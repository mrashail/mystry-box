(function () {
  "use strict";
  var root = (window.Shopify && window.Shopify.routes && window.Shopify.routes.root) || "/";
  var config = document.getElementById("giftlab-cart-engine");
  if (!config) return;
  // A `window`-level flag only blocks re-entry within the same JS realm.
  // Shopify's app-block loader has been observed to run this script's
  // top-level code multiple times per page while only ever fetching it once
  // over the network — each run gets its own fresh `window`, so
  // `window.__giftlabLoaded` alone never survives to block the next one, and
  // every run ends up wrapping fetch/XHR again, each independently
  // triggering its own evaluate() for the same cart action. Every run does
  // resolve the *same* real `config` DOM node, though, so a flag stored on
  // that shared element (rather than on `window`) is what actually survives
  // across whichever mechanism causes the repeat runs.
  if (config.dataset.giftlabLoaded === "true") return;
  config.dataset.giftlabLoaded = "true";
  window.__giftlabLoaded = true;
  var running = false;
  var needsReevaluate = false;
  var lastSignature = "";
  // Set true the moment we defer (hold) one of the theme's own cart-render
  // fetches. It tells the evaluation cycle "the theme is going to repaint the
  // drawer itself once I release its render, so don't repaint it a second time."
  // Reset to false at the start of every cart mutation the shopper triggers.
  var pendingRenderHold = false;

  var cachedRules = [];
  var cachedMysteryBoxes = [];
  var cachedCart = null;
  // True whenever cachedCart.items' ORDER is just this client's best guess
  // (see buildKnownCartAfterAdd) rather than the server's real, confirmed
  // line order — Shopify does not necessarily keep a batched add's line
  // items in the order they were submitted in (verified live: a gift
  // appended AFTER the main item in the request came back BEFORE it in the
  // real cart). Anything that matches a cart line by POSITION (like a
  // theme's "line N" remove button) must not trust that match while this is
  // true, or it risks mutating the wrong line — see the /cart/change
  // interceptor below.
  var cachedCartOrderApproximate = false;
  // Bumped every time cachedCart is reassigned, from ANY path — lets a
  // fire-and-forget background correction (see correctCartOrderInBackground)
  // confirm nothing newer has touched cachedCart while its own request was
  // in flight before it applies its result, so it can never clobber a more
  // recent state with a stale one.
  var cachedCartGeneration = 0;
  var rulesLoadPromise = null;
  // Set the moment an add/change request gets clamped to a box's maxPerOrder,
  // and shown as a toast right after the (now-clamped) request completes —
  // the shopper asked for more than the cap allows, so they should know why
  // their cart doesn't reflect the number they entered.
  var pendingMysteryLimitMessage = null;

  console.log("GiftLab Cart Engine initialized. Root:", root);

  function customer() {
    return {
      id: config.dataset.customerId || undefined,
      loggedIn: Boolean(config.dataset.customerId),
      tags: (config.dataset.customerTags || "").split(",").map(function (tag) { return tag.trim(); }).filter(Boolean),
      orderCount: Number(config.dataset.customerOrders || 0)
    };
  }

  var TOAST_KEY = "giftlab:pending-toast";

  function toast(message) {
    if (!message || config.dataset.showNotifications === "false") return;
    console.log("GiftLab Toast message:", message);
    var old = document.getElementById("giftlab-toast");
    if (old) old.remove();
    var node = document.createElement("div");
    node.id = "giftlab-toast";
    node.setAttribute("role", "status");
    node.textContent = message;
    Object.assign(node.style, { position: "fixed", right: "20px", top: "20px", zIndex: "2147483000", maxWidth: "360px", padding: "14px 18px", borderRadius: "12px", color: "#fff", background: "#173f33", boxShadow: "0 14px 40px rgba(0,0,0,.22)", font: "600 14px/1.4 system-ui,sans-serif", opacity: "0", transform: "translateY(-8px)", transition: ".2s ease" });
    document.body.appendChild(node);
    requestAnimationFrame(function () { node.style.opacity = "1"; node.style.transform = "translateY(0)"; });
    setTimeout(function () { node.style.opacity = "0"; setTimeout(function () { node.remove(); }, 250); }, 4200);
  }

  // The drawer's outer wrapper (#CartDrawer) carries an `is-empty` class that
  // the theme's CSS uses to hide the whole line-item region and show the empty
  // state. We deliberately never innerHTML-replace that wrapper (it owns the
  // click-outside overlay), so when we repaint the inner regions ourselves we
  // must also mirror its is-empty state — from GROUND TRUTH (the freshly
  // rendered section markup), never from a guessed item count. Guessing the
  // count was the original bug: a stale/missing count flagged a full cart as
  // empty and left it stuck hidden.
  function syncEmptyStateFromDoc(doc) {
    var fresh = doc.querySelector("#CartDrawer, cart-drawer, .drawer");
    if (!fresh) return;
    var isEmpty = fresh.classList.contains("is-empty") || doc.querySelector(".drawer__inner-empty") !== null;
    document.querySelectorAll("#CartDrawer, cart-drawer, .drawer").forEach(function (el) {
      if (isEmpty) el.classList.add("is-empty");
      else el.classList.remove("is-empty");
    });
  }

  function getUrl(path) {
    var r = root;
    if (r.slice(-1) !== "/") r += "/";
    if (path.charAt(0) === "/") path = path.slice(1);
    return r + path;
  }

  function post(url, body) {
    return fetch(getUrl(url), { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/json", "X-GiftLab-Internal": "1" }, body: JSON.stringify(body) });
  }

  // Read in-memory rules directly from Liquid script tag on page load (0ms delay!)
  var rulesEl = document.getElementById("giftlab-rules-data");
  if (rulesEl && rulesEl.textContent) {
    try {
      cachedRules = JSON.parse(rulesEl.textContent);
      console.log("GiftLab instant rules loaded from Liquid DOM:", cachedRules);
    } catch (e) {}
  }

  // Same instant-load pattern for the mystery box identity list (id +
  // parent/box variant ids only — enough to spot "this cart line is a
  // mystery box" without a round trip; the actual random pick always comes
  // from the server, see runMysteryReconcile).
  var mysteryEl = document.getElementById("giftlab-mystery-data");
  if (mysteryEl && mysteryEl.textContent) {
    try {
      cachedMysteryBoxes = JSON.parse(mysteryEl.textContent);
      console.log("GiftLab instant mystery box list loaded from Liquid DOM:", cachedMysteryBoxes);
    } catch (e) {}
  }

  // Any cart line whose variant matches a known mystery box's parent/shadow
  // variant. Standard boxes set parentVariantId === boxVariantId (the shopper
  // adds the shadow product directly); BOGO boxes trigger off a different real
  // product, so parentVariantId is the one that matters there.
  function findMysteryBoxLines(cart) {
    if (!cachedMysteryBoxes || !cachedMysteryBoxes.length || !cart || !cart.items) return [];
    return cart.items.filter(function (item) {
      var itemVid = numericId(item.variant_id);
      return cachedMysteryBoxes.some(function (box) {
        return (box.parentVariantId && numericId(box.parentVariantId) === itemVid) ||
          (box.boxVariantId && numericId(box.boxVariantId) === itemVid);
      });
    });
  }

  // The box a given variant id belongs to (as parent/shadow variant), or
  // undefined if it isn't a mystery box line at all.
  function findMysteryBoxByVariantId(variantId) {
    if (!cachedMysteryBoxes || !cachedMysteryBoxes.length) return undefined;
    var vid = numericId(variantId);
    return cachedMysteryBoxes.filter(function (b) {
      return (b.parentVariantId && numericId(b.parentVariantId) === vid) ||
        (b.boxVariantId && numericId(b.boxVariantId) === vid);
    })[0];
  }

  // True if the cart holds a tiered mystery box we CANNOT price from any
  // stable source yet — neither config basePrice nor Shopify's product meta
  // (see effectiveLinePrice's preference order). Only then must a subtotal-
  // gated gift decision be deferred until the mystery reconcile supplies the
  // authoritative price (mergeBoxBasePrices). On the box's own product page
  // meta IS available, so this returns false and the gift decides instantly.
  function mysteryBoxNeedsPrice(cart) {
    return findMysteryBoxLines(cart).some(function (line) {
      var box = findMysteryBoxByVariantId(line.variant_id);
      if (!box || !box.tiers || !box.tiers.length) return false;
      if (box.basePrice != null) return false;
      var meta = getKnownVariantMeta(line.variant_id);
      return !(meta && meta.price != null);
    });
  }

  // How many units of this variant the cart already holds, summed across any
  // lines that share it (there's normally only one, but a raw duplicate line
  // can briefly exist before the theme/Shopify merges it).
  function currentCartQuantityFor(variantId) {
    if (!cachedCart || !cachedCart.items) return 0;
    var vid = numericId(variantId);
    var total = 0;
    cachedCart.items.forEach(function (item) {
      if (numericId(item.variant_id) === vid) total += item.quantity;
    });
    return total;
  }

  // Caps a requested quantity at the box's maxPerOrder (accounting for
  // whatever's already in the cart), and records a toast message to show
  // once the (now-clamped) request completes. Returns the quantity to
  // actually send — unchanged if there's no box, no limit, or no shopper
  // hasn't asked for more than the cap allows.
  function clampToMysteryLimit(box, requestedQty, alreadyInCartQty) {
    if (!box || !box.maxPerOrder) return requestedQty;
    var allowed = Math.max(0, box.maxPerOrder - alreadyInCartQty);
    var qty = Number(requestedQty) || 0;
    if (qty <= allowed) return qty;
    pendingMysteryLimitMessage = "You can add up to " + box.maxPerOrder + " of “" + box.name + "” per order.";
    console.log("GiftLab clamping mystery box quantity from", qty, "to", allowed, "(max per order:", box.maxPerOrder, ")");
    return allowed;
  }

  // The highest-minQuantity precomputed tier that still qualifies at this
  // quantity, or null if none does (box.tiers is pre-sorted descending by
  // minQuantity at sync time — see syncMysteryBoxConfig).
  function bestMysteryTierFor(box, quantity) {
    var tiers = (box && box.tiers) || [];
    for (var i = 0; i < tiers.length; i += 1) {
      if (tiers[i].minQuantity <= quantity) return tiers[i];
    }
    return null;
  }

  // Builds the properties a mystery box line should carry for a given
  // quantity: keeps every existing property (the hidden pick bookkeeping —
  // _mystery_box_id/_mystery_selection/_mystery_contents — must survive,
  // since the actual pick is only refreshed a beat later by the silent server
  // reconcile), but always starts the price-tier fields fresh so a tier that
  // no longer qualifies doesn't leave its old discount properties behind.
  function buildMysteryLineProperties(existingProperties, box, quantity) {
    var properties = {};
    if (existingProperties) {
      Object.keys(existingProperties).forEach(function (key) {
        if (existingProperties[key] !== null && existingProperties[key] !== undefined) {
          properties[key] = existingProperties[key];
        }
      });
    }
    delete properties._mystery_price_type;
    delete properties._mystery_price_value;
    delete properties._mystery_pricing_box;
    delete properties._mystery_trigger_product_id;
    delete properties._mystery_trigger_variant_id;
    delete properties._promotion_signature;
    var tier = bestMysteryTierFor(box, quantity);
    if (tier) {
      properties._mystery_price_type = tier.adjustmentType;
      properties._mystery_price_value = String(tier.value);
      properties._mystery_pricing_box = box.id;
      properties._mystery_trigger_product_id = tier.triggerProductId;
      properties._mystery_trigger_variant_id = tier.triggerVariantId;
      properties._promotion_signature = tier.signature;
    }
    return properties;
  }

  // The true amount a cart line contributes to a subtotal/eligibility check —
  // with the mystery-box quantity-tier discount ALREADY applied. This is the
  // single source of truth for "what this line is really worth," so gift
  // eligibility is decided on the exact number the shopper ends up paying,
  // synchronously, without waiting for Shopify's async discount recompute (the
  // tier discount is applied by a cart-line discount Function that only lands
  // a beat after the cart mutation — see extensions/giftlab-discounts/src/run.rs).
  // Mirrors that Function's per-unit math exactly:
  //   PERCENT_OFF -> unit * (1 - value/100)
  //   FIXED_OFF   -> max(0, unit - value)   (absolute amount off, per item)
  //   FIXED_PRICE -> min(unit, value)       (per-unit target price)
  // Gift/reward lines contribute 0 (they're free). Everything else uses the
  // cart's own final_price (falling back to price). Always computes the box's
  // discounted price from the RAW unit price + the known tier rather than
  // trusting the line's final_price, because right after a mutation Shopify
  // hasn't recomputed the discount yet and final_price is still the raw value.
  function effectiveLinePrice(item) {
    if (!item) return 0;
    var quantity = item.quantity || 0;
    var props = item.properties || {};
    if (props._free_gift_rule || props._mystery_box_reward) return 0;
    var box = findMysteryBoxByVariantId(item.variant_id);
    if (box) {
      var tier = bestMysteryTierFor(box, quantity);
      if (tier) {
        // Price the box off a STABLE per-unit source, never the cart line's
        // own `price`: Shopify reports a line's price at LINE level (unit ×
        // quantity) after a cart mutation with the box's tier discount — it
        // does NOT reliably settle to per-unit here — so a $10 box × 6 reads
        // as ~$60/unit, which made a subtotal-gated gift wrongly qualify.
        // Preference, each authoritative and stable:
        //   1. config basePrice (available in every context once synced)
        //   2. Shopify's own product-meta price for this variant — present on
        //      the product page, i.e. exactly where the shopper adds the box,
        //      and confirmed to match the real product price (the CART line is
        //      the unreliable one here, not meta)
        //   3. the cart line price (last resort)
        var rawUnit = null;
        if (box.basePrice != null) {
          rawUnit = box.basePrice;
        } else {
          var boxMeta = getKnownVariantMeta(item.variant_id);
          if (boxMeta && boxMeta.price != null) rawUnit = boxMeta.price;
        }
        if (rawUnit == null) {
          rawUnit = item.price != null ? item.price : (item.final_price != null ? item.final_price : 0);
        }
        var value = Number(tier.value) || 0;
        var discountedUnit = rawUnit;
        if (tier.adjustmentType === "PERCENT_OFF") {
          discountedUnit = rawUnit * (1 - Math.min(100, value) / 100);
        } else if (tier.adjustmentType === "FIXED_OFF") {
          discountedUnit = Math.max(0, rawUnit - value);
        } else if (tier.adjustmentType === "FIXED_PRICE") {
          discountedUnit = Math.min(rawUnit, value);
        }
        // Shopify works in whole cents — round per unit so the projected
        // subtotal matches what the discount Function actually charges.
        return Math.round(discountedUnit) * quantity;
      }
    }
    var unit = item.final_price != null ? item.final_price : (item.price || 0);
    return unit * quantity;
  }

  // Attaches/refreshes the hidden random pick on a mystery box line. This
  // MUST be server-side (randomness, inventory, per-customer history, and the
  // persisted MysterySelection roll all live only there — see
  // evaluateMysteryOnly in promotion-engine.server.ts). It's a silent property
  // update on a line the shopper already sees (the box itself was already
  // added natively, instantly, by the theme) — never a separate add, so there
  // is no flash. A cart with no mystery box line never calls this at all.
  async function runMysteryReconcile(cart) {
    try {
      var response = await fetch(getUrl("apps/giftlab/mystery"), {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json", "X-GiftLab-Internal": "1" },
        body: JSON.stringify({ cart: cart, customer: customer(), country: config.dataset.country || undefined })
      });
      if (!response.ok) {
        console.warn("GiftLab mystery reconcile returned error status:", response.status);
        return null;
      }
      var result = await response.json();
      console.log("GiftLab mystery reconcile result:", result);
      // Learn each box's authoritative per-unit price (see boxPrices in
      // apps.giftlab.mystery.tsx) so effectiveLinePrice can price a tiered box
      // off a stable value instead of the cart line's transient inflated one.
      var basePriceLearned = mergeBoxBasePrices(result.boxPrices);
      if (!result.mutations || !result.mutations.length) {
        return { didMutate: false, sections: null, basePriceLearned: basePriceLearned };
      }
      var didMutate = false;
      var latestSections = null;
      for (var i = 0; i < result.mutations.length; i += 1) {
        var mut = result.mutations[i];
        var r = await applyMutation(mut);
        if (r) {
          patchCachedCartForMutation(mut);
          // A CHANGE that only refreshes the hidden pick on the box's own
          // still-present line (has _mystery_box_id, isn't zeroing it out) has
          // NOTHING new to show the shopper — the price/quantity were already
          // painted instantly by the /cart/change.js interceptor the moment
          // they clicked +/-. Triggering a second drawer repaint for it just
          // re-renders visually-identical content a beat later, which is
          // exactly the flicker/"jumpy" feeling reported on every quantity
          // click. Only a genuine removal (quantity 0) or a brand new line
          // (ADD — e.g. a BOGO bonus appearing) is an actually-visible change
          // worth repainting for.
          var isHiddenPickRefresh = mut.type === "CHANGE" && mut.quantity !== 0 &&
            mut.properties && mut.properties._mystery_box_id;
          if (!mut.silent && !isHiddenPickRefresh) didMutate = true;
          if (r.sections) latestSections = r.sections;
        }
      }
      return { didMutate: didMutate, sections: latestSections, basePriceLearned: basePriceLearned };
    } catch (e) {
      console.warn("GiftLab mystery reconcile failed:", e);
      return null;
    }
  }

  // Merges server-provided authoritative per-unit box prices (cents) into
  // cachedMysteryBoxes. Matches by box id (falling back to boxVariantId), and
  // returns true if any box's basePrice actually changed — the caller uses
  // that to know a deferred gift decision can now be made on a correct price.
  function mergeBoxBasePrices(boxPrices) {
    if (!boxPrices || !boxPrices.length || !cachedMysteryBoxes || !cachedMysteryBoxes.length) return false;
    var changed = false;
    boxPrices.forEach(function (bp) {
      cachedMysteryBoxes.forEach(function (box) {
        var match = (bp.id && box.id === bp.id) ||
          (bp.boxVariantId && box.boxVariantId && numericId(box.boxVariantId) === numericId(bp.boxVariantId));
        if (match && box.basePrice !== bp.basePrice) {
          box.basePrice = bp.basePrice;
          changed = true;
        }
      });
    });
    return changed;
  }

  async function loadRulesAndCart() {
    try {
      if (!cachedRules || cachedRules.length === 0) {
        var custStr = encodeURIComponent(JSON.stringify(customer()));
        var rulesResp = await fetch(getUrl("apps/giftlab/evaluate?customer=" + custStr), { credentials: "same-origin", cache: "no-store", headers: { "X-GiftLab-Internal": "1" } });
        if (rulesResp.ok) {
          var res = await rulesResp.json();
          cachedRules = res.rules || [];
          console.log("GiftLab loaded active rules list via fallback:", cachedRules);
        }
      }
      
      var cartResp = await fetch(getUrl("cart.js"), { credentials: "same-origin", cache: "no-store", headers: { "X-GiftLab-Internal": "1" } });
      if (cartResp.ok) {
        cachedCart = await cartResp.json();
        cachedCartOrderApproximate = false;
        cachedCartGeneration++;
        console.log("GiftLab loaded initial cart:", cachedCart);
      }
    } catch (e) {
      console.warn("GiftLab failed to load initial rules/cart:", e);
    }
  }

  async function applyMutation(mutation) {
    console.log("GiftLab applying mutation:", mutation);
    var response;
    var urlParams = "?sections=cart-drawer,cart-icon-bubble";
    if (mutation.type === "ATTRIBUTES") {
      // cart/update.js replaces the whole attributes object rather than
      // merging it, so we must carry forward whatever else was already on
      // the cart (other apps' attributes, cart notes, etc.) and only
      // overwrite the keys this mutation actually specifies.
      var attributes = Object.assign({}, (cachedCart && cachedCart.attributes) || {}, mutation.attributes || {});
      response = await post("cart/update.js" + urlParams, { attributes: attributes });
    } else if (mutation.type === "CHANGE") {
      response = await post("cart/change.js" + urlParams, { id: mutation.lineKey, quantity: mutation.quantity, properties: mutation.properties });
    } else {
      response = await post("cart/add.js" + urlParams, { items: [{ id: mutation.variantId, quantity: mutation.quantity, properties: mutation.properties || {} }] });
    }
    if (!response.ok) {
      try {
        var errText = await response.text();
        console.error("GiftLab Cart API Mutation Failed:", response.status, errText);
      } catch (e) {}
      return null;
    } else {
      console.log("GiftLab Mutation successfully applied!");
      try {
        return await response.json();
      } catch (e) {
        return {};
      }
    }
  }

  // cachedCart is only refetched from cart.js at the *start* of an evaluate
  // cycle, before that cycle's own mutations are applied — so left alone, it
  // stays one cycle stale about anything WE just did (e.g. it would still
  // show a gift as absent right after we added it). Since cachedCart is what
  // becomes `previousCart` for the *next* cycle (evaluateRulesLocally's
  // still-qualifying-gift-just-disappeared check), that staleness broke the
  // very decline detection it exists to support: deleting a gift the shopper
  // had just been given looked identical to "never added," and got re-added
  // instantly. Patching cachedCart in place right after each successful
  // mutation keeps it an accurate ground truth for the next cycle.
  function patchCachedCartForMutation(mutation) {
    if (!cachedCart || !cachedCart.items) return;
    if (mutation.type === "ATTRIBUTES") {
      cachedCart.attributes = Object.assign({}, cachedCart.attributes || {}, mutation.attributes || {});
    } else if (mutation.type === "ADD") {
      cachedCart.items.push({ variant_id: mutation.variantId, quantity: mutation.quantity, properties: mutation.properties || {} });
    } else if (mutation.type === "CHANGE") {
      if (mutation.quantity === 0) {
        cachedCart.items = cachedCart.items.filter(function (item) {
          return (item.key || item.variant_id) !== mutation.lineKey;
        });
      } else {
        cachedCart.items.forEach(function (item) {
          if ((item.key || item.variant_id) === mutation.lineKey) {
            item.quantity = mutation.quantity;
            if (mutation.properties) item.properties = mutation.properties;
          }
        });
      }
    }
    // ATTRIBUTES mutations don't touch line items — nothing to patch.
  }

  // Classes/attributes different themes use to mark a drawer/modal as open.
  var OPEN_STATE_CLASSES = ["active", "is-open", "open", "drawer--open", "js-drawer-open", "is-visible", "cart-drawer--open"];

  function preserveOpenState(target, source) {
    OPEN_STATE_CLASSES.forEach(function (cls) {
      if (target.classList.contains(cls)) source.classList.add(cls);
      else source.classList.remove(cls);
    });
    if (target.hasAttribute("open")) source.setAttribute("open", "");
    else source.removeAttribute("open");
    var ariaHidden = target.getAttribute("aria-hidden");
    if (ariaHidden !== null) source.setAttribute("aria-hidden", ariaHidden);
  }

  // Best-effort UI polish: once a mystery box line's quantity has reached its
  // configured maxPerOrder, disable that specific line's "+" stepper (and cap
  // the input's own max attribute) so the shopper visibly can't ask for
  // more — matching Dawn's own `data-quantity-variant-id` markup convention
  // (shared by most Dawn-derived themes too). This is a best-effort UI touch
  // on top of the REAL enforcement, which is the /cart/add.js|change.js
  // interceptors clamping the actual cart — that stays authoritative
  // regardless of whether a given theme's markup happens to match this
  // pattern, so nothing here can let a shopper actually exceed the cap even
  // if this cosmetic pass finds nothing to disable.
  function enforceMysteryQuantityCaps() {
    if (!cachedMysteryBoxes || !cachedMysteryBoxes.length) return;
    try {
      document.querySelectorAll("input[data-quantity-variant-id]").forEach(function (input) {
        var vid = numericId(input.getAttribute("data-quantity-variant-id"));
        var box = findMysteryBoxByVariantId(vid);
        if (!box || !box.maxPerOrder) return;
        var current = Number(input.value || input.getAttribute("data-cart-quantity") || 0);
        input.setAttribute("max", String(box.maxPerOrder));
        var wrapper = input.closest("quantity-input") || input.parentElement;
        var plusButton = wrapper && wrapper.querySelector('button[name="plus"]');
        if (plusButton) plusButton.disabled = current >= box.maxPerOrder;
      });
    } catch (e) {
      console.warn("GiftLab failed to enforce mystery quantity cap on the stepper UI:", e);
    }
  }

  function updateDOMWithSections(sectionsJson) {
    console.log("GiftLab updating DOM using mutation response sections...");
    var selectors = [
      ".drawer__inner",
      "#CartDrawer-CartItems",
      "cart-drawer-items",
      ".drawer__cart-items-wrapper",
      "#CartDrawer-Summary",
      ".drawer__footer",
      "#cart-icon-bubble",
      ".cart-icon-bubble",
      "#main-cart-items",
      "#main-cart-footer",
      ".mini-cart"
    ];
    var combinedHtml = "";
    for (var key in sectionsJson) {
      combinedHtml += sectionsJson[key] || "";
    }
    if (!combinedHtml) return;

    var parser = new DOMParser();
    var doc = parser.parseFromString(combinedHtml, "text/html");

    syncEmptyStateFromDoc(doc);

    selectors.forEach(function (selector) {
      var target = document.querySelector(selector);
      var source = doc.querySelector(selector);
      if (target && source) {
        console.log("GiftLab updating element selector from cache:", selector);
        // The freshly fetched section markup always describes the drawer in
        // its default *closed* state. Blindly copying its class/attributes
        // onto a drawer that's currently open rips the open/active flag off,
        // so the drawer snaps shut and the theme reopens it a frame later —
        // the exact flicker shoppers see. Carry the live open state across the
        // swap so the contents update in place without ever closing.
        preserveOpenState(target, source);
        target.innerHTML = source.innerHTML;
        target.className = source.className;
        for (var a = 0; a < source.attributes.length; a++) {
          var attr = source.attributes[a];
          if (attr.name !== "id") {
            target.setAttribute(attr.name, attr.value);
          }
        }
      }
    });

    enforceMysteryQuantityCaps();

    document.dispatchEvent(new CustomEvent("cart:refresh"));
    // Tag this as our own update so the cart:updated listener below doesn't
    // treat it as an external cart change and kick off a second evaluate().
    document.dispatchEvent(new CustomEvent("cart:updated", { detail: { source: "giftlab" } }));
    if (window.theme && window.theme.CartDrawer && typeof window.theme.CartDrawer.render === "function") {
      try { window.theme.CartDrawer.render(); } catch (e) {}
    }
  }

  async function refreshCartSections() {
    console.log("GiftLab refreshing cart sections...");
    var selectors = [
      ".drawer__inner",
      "#CartDrawer-CartItems",
      "cart-drawer-items",
      ".drawer__cart-items-wrapper",
      "#CartDrawer-Summary",
      ".drawer__footer",
      "#cart-icon-bubble",
      ".cart-icon-bubble",
      "#main-cart-items",
      "#main-cart-footer",
      ".mini-cart"
    ];
    try {
      var response = await fetch(getUrl("cart?sections=cart-drawer,cart-icon-bubble"), { headers: { "X-GiftLab-Internal": "1" } });
      if (response.ok) {
        var sectionsJson = await response.json();
        updateDOMWithSections(sectionsJson);
      } else {
        console.warn("GiftLab failed to load cart sections HTML. Status:", response.status);
      }
    } catch (err) {
      console.warn("Failed to refresh cart sections", err);
    }
  }

  function numericId(val) {
    if (!val) return "";
    return String(val).split("/").pop();
  }

  function matchCondition(cond, cart) {
    if (!cond) return false;
    var actualVal = 0;
    if (cond.field === "subtotal") {
      var subtotal = 0;
      cart.items.forEach(function (item) {
        // effectiveLinePrice already returns 0 for gift/reward lines and the
        // discounted amount for tiered mystery boxes — the one place subtotal
        // is defined, so add-time and reconcile can never disagree.
        subtotal += effectiveLinePrice(item);
      });
      actualVal = subtotal / 100;
    } else if (cond.field === "quantity") {
      var totalQty = 0;
      cart.items.forEach(function (item) {
        var isGift = item.properties && (item.properties._free_gift_rule || item.properties._mystery_box_reward);
        if (!isGift) {
          totalQty += item.quantity;
        }
      });
      actualVal = totalQty;
    } else if (cond.field === "product") {
      var expectedIds = Array.isArray(cond.value) ? cond.value.map(numericId) : [numericId(cond.value)];
      var found = cart.items.some(function (item) {
        var isGift = item.properties && (item.properties._free_gift_rule || item.properties._mystery_box_reward);
        return !isGift && expectedIds.indexOf(numericId(item.product_id)) !== -1;
      });
      return cond.operator === "equals" ? found : !found;
    } else if (cond.field === "variant") {
      var expectedIds = Array.isArray(cond.value) ? cond.value.map(numericId) : [numericId(cond.value)];
      var found = cart.items.some(function (item) {
        var isGift = item.properties && (item.properties._free_gift_rule || item.properties._mystery_box_reward);
        return !isGift && expectedIds.indexOf(numericId(item.variant_id)) !== -1;
      });
      return cond.operator === "equals" ? found : !found;
    } else {
      return false;
    }

    var expectedVal = Number(cond.value);
    switch (cond.operator) {
      case "equals": return actualVal === expectedVal;
      case "not_equals": return actualVal !== expectedVal;
      case "greater_than": return actualVal > expectedVal;
      case "greater_or_equal": return actualVal >= expectedVal;
      case "less_than": return actualVal < expectedVal;
      case "less_or_equal": return actualVal <= expectedVal;
      default: return false;
    }
  }

  // Cart attribute holding the comma-separated ids of gift rules the shopper
  // has explicitly declined (by deleting the gift line themselves) while the
  // rule still qualifies. Must match GIFTLAB_DECLINED_GIFTS_ATTRIBUTE in
  // promotion-engine.server.ts exactly — both sides read/write the same cart
  // attribute so a decline made via the fast local path here is honored by
  // the server fallback path too, and vice versa.
  var DECLINED_GIFTS_ATTRIBUTE = "_giftlab_declined_gifts";

  function parseDeclinedGiftIds(cart) {
    var raw = (cart.attributes && cart.attributes[DECLINED_GIFTS_ATTRIBUTE]) || "";
    return raw.split(",").map(function (id) { return id.trim(); }).filter(Boolean);
  }

  // True if the shopper already declined this rule's gift this session (tracked
  // in the cart attribute). Checked before the instant batched add so we never
  // re-add a gift they just removed. Reads from the last cart snapshot we hold.
  function isRuleDeclined(ruleId) {
    if (!cachedCart) return false;
    return parseDeclinedGiftIds(cachedCart).indexOf(ruleId) !== -1;
  }

  function giftLinePresent(cartSnapshot, ruleId, variantId) {
    return cartSnapshot.items.some(function (item) {
      return item.properties && item.properties._free_gift_rule === ruleId &&
        numericId(item.variant_id) === numericId(variantId) && item.quantity > 0;
    });
  }

  // ---- Rule qualification, mirroring promotion-engine.server.ts so the
  // storefront honors every toggle on the Free Gift form exactly the way the
  // server engine (and the merchant) expects. Kept intentionally close to the
  // server's giftRuleMatches/restrictionsMatch/desiredGiftMutations. ----

  // Customer-level gates that don't depend on cart contents. Note: "one gift
  // per customer" can't be judged on the storefront (it needs the shopper's
  // past-order history, which only the server has), so it is enforced by the
  // order-level check server-side, not here.
  function ruleAllowedForCustomer(rule) {
    var r = rule.restrictions || {};
    var cust = customer();
    if (r.firstPurchaseOnly && (cust.orderCount || 0) > 0) return false;
    var tags = (cust.tags || []).map(function (t) { return String(t).trim().toLowerCase(); });
    var allowed = r.allowedCustomerTags || [];
    if (allowed.length && !allowed.some(function (t) { return tags.indexOf(String(t).trim().toLowerCase()) !== -1; })) return false;
    var excluded = r.excludedCustomerTags || [];
    if (excluded.length && excluded.some(function (t) { return tags.indexOf(String(t).trim().toLowerCase()) !== -1; })) return false;
    return true;
  }

  function ruleConditionsMatch(rule, cart) {
    var conditions = rule.conditions || [];
    if (conditions.length === 0) return true;
    var results = conditions.map(function (cond) { return matchCondition(cond, cart); });
    return rule.matchMode === "ANY" ? results.some(Boolean) : results.every(Boolean);
  }

  // Shopify itself injects window.ShopifyAnalytics.meta.product on virtually
  // every theme's product page — the CURRENT product's id plus every one of
  // its variants' real prices. It's not theme markup we're guessing at, it's
  // Shopify's own analytics beacon data, already sitting in memory before the
  // shopper ever clicks Add to cart. Used to price the item(s) about to be
  // added with total confidence — never a guess — so subtotal/quantity/
  // product conditions can be checked BEFORE the request goes out. Returns
  // null the instant the variant isn't found there (e.g. the add is for a
  // different product than the one currently loaded), signalling the caller
  // to fall back to the deferred, cart.js-confirmed check instead.
  function getKnownVariantMeta(variantId) {
    try {
      var meta = window.ShopifyAnalytics && window.ShopifyAnalytics.meta;
      var product = meta && meta.product;
      if (!product || !product.variants) return null;
      var id = numericId(variantId);
      var match = product.variants.filter(function (v) { return numericId(v.id) === id; })[0];
      if (!match) return null;
      return { price: match.price, product_id: numericId(product.id) };
    } catch (e) {
      return null;
    }
  }

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  // The correct per-unit price this cart line SHOULD show right now (same
  // stable-price preference and tier math as effectiveLinePrice), used to
  // detect whether Shopify's own cart-line discount Function has finished its
  // async recompute yet. Returns null only if no stable price source exists
  // at all (falls back to whatever the item itself reports).
  function mysteryBoxExpectedUnitPrice(box, item) {
    var rawUnit = box.basePrice != null ? box.basePrice : null;
    if (rawUnit == null) {
      var meta = getKnownVariantMeta(item.variant_id);
      if (meta && meta.price != null) rawUnit = meta.price;
    }
    if (rawUnit == null) rawUnit = item.price != null ? item.price : item.final_price;
    if (rawUnit == null) return null;
    var tier = bestMysteryTierFor(box, item.quantity);
    if (!tier) return Math.round(rawUnit);
    var value = Number(tier.value) || 0;
    var discountedUnit = rawUnit;
    if (tier.adjustmentType === "PERCENT_OFF") discountedUnit = rawUnit * (1 - Math.min(100, value) / 100);
    else if (tier.adjustmentType === "FIXED_OFF") discountedUnit = Math.max(0, rawUnit - value);
    else if (tier.adjustmentType === "FIXED_PRICE") discountedUnit = Math.min(rawUnit, value);
    return Math.round(discountedUnit);
  }

  // True the moment ANY mystery-box cart line's price hasn't caught up with
  // what it should be — either a qualifying tier not discounted yet, or a
  // discount still showing after the quantity dropped below the tier. This is
  // genuine Shopify-side latency in extensions/giftlab-discounts (the
  // cart-line discount Function recomputes asynchronously after a mutation) —
  // not something an app can make instant, only detect and wait out.
  function cartHasUnsettledMysteryPrice(cart) {
    if (!cart || !cart.items) return false;
    var hasLineIssue = cart.items.some(function (item) {
      var box = findMysteryBoxByVariantId(item.variant_id);
      if (!box) return false;
      var expected = mysteryBoxExpectedUnitPrice(box, item);
      if (expected == null) return false;
      var actual = item.final_price != null ? item.final_price : item.price;
      return Math.abs(actual - expected) > 1;
    });
    if (hasLineIssue) return true;
    // A single line's own final_price can already read correctly while the
    // CART-level items_subtotal_price (and each line's final_line_price) is
    // still mid-recompute — verified live: a box's per-unit final_price had
    // already settled to $7 while the Subtotal still showed $175 instead of
    // $35. Cross-check the cart's own reported subtotal against what our
    // authoritative math says it should be; only "settled" once both agree.
    if (cart.items.some(function (item) { return !!findMysteryBoxByVariantId(item.variant_id); })) {
      var ourSubtotal = cart.items.reduce(function (sum, item) { return sum + effectiveLinePrice(item); }, 0);
      if (Math.abs((cart.items_subtotal_price || 0) - ourSubtotal) > cart.items.length) return true;
    }
    return false;
  }

  // Polls cart.js (silent) until every mystery box line's price matches what
  // it should be, or a cap is hit — the cap exists so a shopper's own action
  // is never held hostage indefinitely if Shopify's recompute is unusually
  // slow; on cap-out the caller falls back to the original (unheld) response.
  // Returns { cart, neededWait } once every mystery box line's price is
  // correct, or null if it never settled within the cap. neededWait is false
  // when the very FIRST check already found nothing wrong (the overwhelming
  // common case — no box involved, or its price was already correct) — the
  // caller uses that to skip the extra sections-refetch/response-swap work
  // entirely when there was genuinely nothing to hold for.
  async function pollForSettledMysteryCart() {
    var maxAttempts = 10;
    var delayMs = 300;
    var neededWait = false;
    for (var attempt = 0; attempt < maxAttempts; attempt++) {
      var probe;
      try {
        probe = await fetch(getUrl("cart.js"), { credentials: "same-origin", cache: "no-store", headers: { "X-GiftLab-Internal": "1", "Cache-Control": "no-cache" } });
      } catch (e) {
        return null;
      }
      if (!probe.ok) return null;
      var probeCart = await probe.json();
      if (!cartHasUnsettledMysteryPrice(probeCart)) return { cart: probeCart, neededWait: neededWait };
      neededWait = true;
      if (attempt < maxAttempts - 1) await sleep(delayMs);
    }
    return null;
  }

  // Fetches freshly rendered section HTML via a genuine no-op /cart/update.js
  // call (an empty `updates` object changes nothing) — the same official Ajax
  // Cart API endpoint the rest of this app already uses to repaint the
  // drawer, just used here to get HTML that reflects the NOW-settled price.
  async function fetchFreshSections(sectionsParam) {
    var resp;
    try {
      resp = await fetch(getUrl("cart/update.js"), {
        method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "Content-Type": "application/json", "X-GiftLab-Internal": "1" },
        body: JSON.stringify({ updates: {}, sections: sectionsParam })
      });
    } catch (e) {
      return null;
    }
    if (!resp.ok) return null;
    return resp.json();
  }

  // If the shopper's own native add/change request affects a mystery box
  // whose discount hasn't caught up yet, holds what the THEME's own fetch
  // handler receives until it has — trading a brief pause for NEVER painting
  // Shopify's not-yet-discounted number (the "$175 then $42" flash). Returns
  // a corrected Response in the SAME shape as the original response (only the
  // price-related fields + sections HTML are patched — everything else the
  // theme might read, id/key/errors/etc., is passed through untouched), or
  // null to mean "nothing needed holding, return the original response."
  async function holdForSettledMysteryPrice(response, requestUrl) {
    if (!cachedMysteryBoxes || !cachedMysteryBoxes.some(function (b) { return b.tiers && b.tiers.length; })) {
      return null;
    }
    var originalJson;
    try {
      originalJson = await response.clone().json();
    } catch (e) {
      return null;
    }

    var settled = await pollForSettledMysteryCart();
    if (!settled || !settled.neededWait) return null;
    var settledCart = settled.cart;

    var sectionsParam = "cart-drawer,cart-icon-bubble,main-cart-items,main-cart-footer";
    var secMatch = requestUrl.match(/[?&]sections=([^&]*)/i);
    if (secMatch) sectionsParam = decodeURIComponent(secMatch[1]);
    var fresh = await fetchFreshSections(sectionsParam);
    var freshSections = fresh && fresh.sections ? fresh.sections : null;

    if (/cart\/(change|update)/i.test(requestUrl)) {
      // Both endpoints already return a full Cart object — swap it wholesale
      // for the settled one.
      var merged = Object.assign({}, settledCart);
      if (freshSections) merged.sections = freshSections;
      return new Response(JSON.stringify(merged), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    // /cart/add.js: keep the ORIGINAL body's shape and every field except the
    // price-related ones for a mystery-box item, patched from the settled
    // cart, so anything else the theme reads is exactly what Shopify sent.
    var items = originalJson.items || (originalJson.id ? [originalJson] : null);
    if (items) {
      items.forEach(function (it) {
        var settledLine = settledCart.items.filter(function (s) { return numericId(s.variant_id) === numericId(it.variant_id); })[0];
        if (settledLine) {
          it.price = settledLine.price;
          it.final_price = settledLine.final_price;
          it.line_price = settledLine.final_price * it.quantity;
          it.original_line_price = settledLine.price * it.quantity;
          if (settledLine.discounted_price != null) it.discounted_price = settledLine.discounted_price;
        }
      });
    }
    if (freshSections) originalJson.sections = freshSections;
    return new Response(JSON.stringify(originalJson), { status: 200, headers: { "Content-Type": "application/json" } });
  }

  // Builds an exact (never guessed) projection of what the cart will look
  // like right after this /cart/add request lands, using only real prices
  // (see getKnownVariantMeta) — never a placeholder or assumed value. Returns
  // null the moment any single item in this request can't be priced that way,
  // so the caller always has a clean yes/no on whether it's safe to trust.
  function buildProbeCart(cart, items) {
    if (!cart || !cart.items || !items || !items.length) return null;
    var synthetic = [];
    for (var i = 0; i < items.length; i++) {
      var id = numericId(items[i].id);
      if (!id) return null;
      var meta = getKnownVariantMeta(id);
      if (!meta) return null;
      synthetic.push({
        variant_id: id,
        product_id: meta.product_id,
        quantity: Number(items[i].quantity) || 1,
        price: meta.price,
        final_price: meta.price,
        properties: {},
      });
    }
    return { items: cart.items.concat(synthetic), attributes: cart.attributes };
  }

  // At add-to-cart time the item(s) about to be added aren't in the cart
  // snapshot yet. When probeCart is available (built from real per-item
  // prices, see buildProbeCart above) every condition — subtotal, quantity,
  // product, variant — can be checked exactly against it, with the same
  // matchCondition logic used everywhere else: no separate/duplicated rules,
  // so this can never disagree with the authoritative post-add check.
  // Without a probeCart (price unknown for at least one item), fall back to
  // the narrower guarantee: "this exact variant is one of the ones being
  // added" is the only thing a bare id lets us say with total certainty, so
  // only a matching "variant equals" condition is trusted; everything else is
  // judged against the cart as it stands right NOW (before this add) and
  // picked up a beat later by the next evaluate() reconcile if this add is
  // what actually pushes it over the line — far better than instant-batching
  // a gift whose condition doesn't actually end up true and having to
  // silently un-add it (the flash the merchant saw).
  function ruleConditionsMatchAtAddTime(rule, cart, probeVariantIds, probeCart) {
    if (probeCart) return ruleConditionsMatch(rule, probeCart);
    var conditions = rule.conditions || [];
    if (conditions.length === 0) return true;
    var results = conditions.map(function (cond) {
      if (cond.field === "variant" && cond.operator === "equals" && probeVariantIds && probeVariantIds.length) {
        var targetIds = Array.isArray(cond.value) ? cond.value.map(numericId) : [numericId(cond.value)];
        if (probeVariantIds.some(function (id) { return targetIds.indexOf(id) !== -1; })) return true;
      }
      return matchCondition(cond, cart);
    });
    return rule.matchMode === "ANY" ? results.some(Boolean) : results.every(Boolean);
  }

  // How many of a rule's configured gift variants to actually award: one when
  // "Allow multiple gifts" is off or "One gift per order" is set, otherwise up
  // to "Maximum gifts from this rule". (Note: the per-gift Qty field controls
  // how many UNITS of a single gift variant — that's gift.quantity, separate
  // from this count of distinct variants.)
  function resolveGiftsForRule(rule) {
    var configured = rule.gifts || [];
    var r = rule.restrictions || {};
    if (r.onePerOrder) return configured.slice(0, 1);
    if (rule.allowMultiple) return configured.slice(0, Math.max(1, rule.maxGifts || 1));
    return configured.slice(0, 1);
  }

  // The rules that should award a gift right now: customer-allowed +
  // conditions met, ordered by priority (lower first), and collapsed to just
  // the top rule when any matching rule is non-stackable — the same conflict
  // handling the server applies for the default strategy. Pass
  // probeVariantIds (an array of variant ids about to be added to the cart)
  // at add-to-cart time — see ruleConditionsMatchAtAddTime for why only an
  // exact "variant equals" match can be trusted before the add lands, and
  // everything else is judged against the cart as it stands right now.
  // Omit/pass null for the normal full-reconcile pass (cart already reflects
  // everything that's happened).
  function computeEffectiveRules(rules, cart, probeVariantIds, probeCart) {
    var matched = (rules || []).filter(function (rule) {
      if (!ruleAllowedForCustomer(rule)) return false;
      return probeVariantIds
        ? ruleConditionsMatchAtAddTime(rule, cart, probeVariantIds, probeCart)
        : ruleConditionsMatch(rule, cart);
    });
    matched.sort(function (a, b) { return (a.priority == null ? 100 : a.priority) - (b.priority == null ? 100 : b.priority); });
    var hasNonStackable = matched.some(function (rule) { return !rule.stackable; });
    return hasNonStackable ? matched.slice(0, 1) : matched;
  }

  // previousCart is the cart state we last observed (the prior evaluate
  // cycle's snapshot), used only to detect the moment a still-qualifying
  // gift line disappears on its own — i.e. the shopper deleted it themselves
  // rather than it never having been added. Without that distinction, this
  // function can't tell "never added" from "just declined," and instantly
  // re-adds whatever the shopper just removed (see DECLINED_GIFTS_ATTRIBUTE
  // above for how the decline itself is remembered).
  function evaluateRulesLocally(rules, cart, previousCart) {
    // Honors every Free Gift form toggle: customer tags / first-purchase gate,
    // priority ordering, and stackable conflict resolution.
    var matchedRules = computeEffectiveRules(rules, cart, null);

    var declinedSet = {};
    parseDeclinedGiftIds(cart).forEach(function (id) { declinedSet[id] = true; });
    var declinedChanged = false;

    if (previousCart) {
      matchedRules.forEach(function (rule) {
        if (declinedSet[rule.id]) return;
        var justDeclined = rule.gifts.some(function (gift) {
          return giftLinePresent(previousCart, rule.id, gift.variantId) &&
            !giftLinePresent(cart, rule.id, gift.variantId);
        });
        if (justDeclined) {
          declinedSet[rule.id] = true;
          declinedChanged = true;
          console.log("GiftLab: shopper removed a still-qualifying gift for rule", rule.id, "- respecting the decline instead of re-adding it.");
        }
      });
    }

    // A decline only holds while its rule keeps matching uninterrupted. The
    // moment the qualifying condition stops being true, forget it — if the
    // shopper re-qualifies later from scratch, that's a fresh offer, not a
    // re-add of something already declined.
    Object.keys(declinedSet).forEach(function (ruleId) {
      var stillMatches = matchedRules.some(function (r) { return r.id === ruleId; });
      if (!stillMatches) {
        delete declinedSet[ruleId];
        declinedChanged = true;
      }
    });

    var mutations = [];
    // Add missing gifts, and correct one whose live line no longer matches
    // what's currently configured — only the resolved subset (respects Allow
    // multiple / Max gifts / One per order).
    matchedRules.forEach(function (rule) {
      if (declinedSet[rule.id]) return;
      resolveGiftsForRule(rule).forEach(function (gift) {
        var current = cart.items.find(function (item) {
          return item.properties && item.properties._free_gift_rule === rule.id && numericId(item.variant_id) === numericId(gift.variantId);
        });
        var properties = buildFreeGiftProperties(rule, gift);
        if (!current) {
          mutations.push({
            type: "ADD",
            variantId: gift.variantId,
            quantity: gift.quantity,
            properties: properties,
            // Per-rule storefront message from the Free Gift form, so the
            // toast reflects what the merchant wrote for this specific rule
            // (falls back to the block's default message downstream).
            notification: rule.notification || ""
          });
        } else if (
          current.quantity !== gift.quantity ||
          (current.properties && current.properties._promotion_signature) !== properties._promotion_signature
        ) {
          // The gift line exists but doesn't match the CURRENT config anymore
          // — e.g. the merchant changed the per-gift Qty (or discount
          // type/value) after this line was added. Presence-only checking
          // (the old logic here) never caught this: the shopper kept
          // whatever quantity/discount was signed in at the moment it was
          // first added, forever, however long the merchant's config later
          // changed — which is exactly the "still behaves like the old
          // (stale) config" symptom. Correct it in place, same as the
          // server-side engine already does for the fallback path.
          mutations.push({
            type: "CHANGE",
            lineKey: current.key || current.variant_id,
            quantity: gift.quantity,
            properties: properties
          });
        }
      });
    });

    // Remove gifts that are no longer qualified (or whose rule was just declined)
    cart.items.forEach(function (item) {
      if (item.properties && item.properties._free_gift_rule) {
        var ruleId = item.properties._free_gift_rule;
        var stillActive = matchedRules.some(function (r) { return r.id === ruleId; }) && !declinedSet[ruleId];
        if (!stillActive) {
          mutations.push({
            type: "CHANGE",
            lineKey: item.key || item.variant_id,
            quantity: 0
          });
        }
      }
    });

    if (declinedChanged) {
      var attributes = {};
      attributes[DECLINED_GIFTS_ATTRIBUTE] = Object.keys(declinedSet).join(",");
      mutations.push({ type: "ATTRIBUTES", attributes: attributes, silent: true });
    }

    return mutations;
  }

  // Returns a promise that resolves only once a full, up-to-date evaluation
  // cycle has settled — including any cycle that was deferred and chained on
  // via needsReevaluate while a previous call was still in flight. Checkout
  // interception relies on this to know it's actually safe to proceed.
  var currentEvaluatePromise = Promise.resolve();

  // This script's top-level code has been observed running multiple times on
  // a single page load even though the browser fetches the file only once —
  // each run gets its own `running`/`needsReevaluate` closure, so the
  // re-entrancy guard above only stops overlapping calls *within* one run.
  // Two such runs reacting to the same add-to-cart both independently
  // fetched the cart, computed mutations, and wrote them back — the second
  // one working from a snapshot taken before the first one's write landed —
  // and could issue a conflicting mutation against the same line. A
  // sessionStorage-based lock is used because it's the one thing that stays
  // shared across whichever mechanism is producing these separate runs, so a
  // second run waits for the first to actually finish instead of racing it.
  var EVAL_LOCK_KEY = "giftlab:eval-lock";
  var EVAL_LOCK_TTL = 8000; // safety net only, in case a run never releases it
  // runEvaluateCycle's own finally re-enters evaluate()/runEvaluateCycleExclusive
  // (for the needsReevaluate follow-up) *while this run still holds the lock*
  // — that's a same-instance re-entry, not a second run racing us, so it must
  // be let through immediately rather than waiting on itself. This flag is
  // what tells tryAcquireEvalLock the difference; only the outermost call
  // actually touches sessionStorage.
  var holdingEvalLock = false;
  function tryAcquireEvalLock() {
    if (holdingEvalLock) return true;
    try {
      var raw = sessionStorage.getItem(EVAL_LOCK_KEY);
      if (raw && Date.now() - Number(raw) < EVAL_LOCK_TTL) return false;
      sessionStorage.setItem(EVAL_LOCK_KEY, String(Date.now()));
      holdingEvalLock = true;
      return true;
    } catch (e) {
      return true; // storage unavailable (e.g. private mode) — don't block on it
    }
  }
  function releaseEvalLock() {
    holdingEvalLock = false;
    try { sessionStorage.removeItem(EVAL_LOCK_KEY); } catch (e) {}
  }
  // If the page is torn down mid-cycle, drop our lock so the next page load
  // isn't made to wait out the full TTL before it can evaluate.
  window.addEventListener("pagehide", function () {
    if (holdingEvalLock) releaseEvalLock();
  });
  function waitForEvalLockRelease() {
    return new Promise(function (resolve) {
      var start = Date.now();
      (function poll() {
        var raw;
        try { raw = sessionStorage.getItem(EVAL_LOCK_KEY); } catch (e) { raw = null; }
        var expired = raw && Date.now() - Number(raw) >= EVAL_LOCK_TTL;
        var timedOut = Date.now() - start >= EVAL_LOCK_TTL;
        if (!raw || expired || timedOut) resolve();
        else setTimeout(poll, 60);
      })();
    });
  }

  // Builds an accurate post-add cart snapshot purely from data the native
  // /cart/add response already echoes back — no guessing, no extra request.
  // Returns null (falls back to a real cart.js fetch) whenever cachedCart
  // isn't warm yet or the response shape isn't recognized, since a merge
  // built on a stale/missing base cart would be worse than just refetching.
  function buildKnownCartAfterAdd(addedJson) {
    if (!cachedCart || !cachedCart.items) return null;
    var addedItems = addedJson && (addedJson.items || (addedJson.id ? [addedJson] : null));
    if (!addedItems || !addedItems.length) return null;
    var normalized = addedItems.map(function (it) {
      // /cart/add.js reports the same PER-UNIT price/final_price as /cart.js
      // (verified live: add.js price==cart.js price, ratio 1), so copy them
      // straight through — matchCondition/effectiveLinePrice multiply by
      // quantity themselves.
      return {
        key: it.key,
        id: it.id,
        variant_id: it.variant_id,
        product_id: it.product_id,
        quantity: it.quantity,
        price: it.price,
        final_price: it.final_price != null ? it.final_price : it.price,
        line_price: it.line_price != null ? it.line_price : it.price * it.quantity,
        properties: it.properties || {},
      };
    });
    var mergedItems = cachedCart.items.slice();
    normalized.forEach(function (added) {
      var existingIndex = mergedItems.findIndex(function (item) {
        return item.key === added.key;
      });
      if (existingIndex === -1) {
        mergedItems.push(added);
      } else {
        var existing = mergedItems[existingIndex];
        mergedItems[existingIndex] = Object.assign({}, existing, added, {
          quantity: (existing.quantity || 0) + added.quantity,
        });
      }
    });
    var subtotal = mergedItems.reduce(function (sum, item) {
      return sum + (item.final_price != null ? item.final_price : item.price) * item.quantity;
    }, 0);
    return {
      items: mergedItems,
      items_subtotal_price: subtotal,
      item_count: mergedItems.reduce(function (sum, item) { return sum + item.quantity; }, 0),
      // Flags this cart's item ORDER as a guess, not server-confirmed — see
      // cachedCartOrderApproximate above.
      _orderApproximate: true,
    };
  }

  // A batched add leaves cachedCart's order approximate (see
  // buildKnownCartAfterAdd), which blocks the /cart/change interceptor's
  // single-request removal merge as a safety measure. Silently fetches the
  // real cart.js in the background — invisible to the shopper, since nothing
  // about the just-finished add's own render depends on it — purely so that,
  // by the time (if ever) they remove something, cachedCart's order is
  // already server-confirmed and that merge can safely fire. Guarded by
  // cachedCartGeneration so it never overwrites a newer state some other
  // action produced while this fetch was in flight.
  function correctCartOrderInBackground() {
    var generationAtStart = cachedCartGeneration;
    fetch(getUrl("cart.js"), { credentials: "same-origin", cache: "no-store", headers: { "X-GiftLab-Internal": "1", "Cache-Control": "no-cache" } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (freshCart) {
        if (!freshCart || cachedCartGeneration !== generationAtStart) return;
        cachedCart = freshCart;
        cachedCartOrderApproximate = false;
        cachedCartGeneration++;
      })
      .catch(function () {});
  }

  // knownCart, when passed, is an already-accurate post-mutation cart
  // snapshot the caller has in hand (see the /cart/add response handling
  // below) — skips this cycle's own cart.js re-fetch, cutting a full network
  // round trip off the delay before a gift can be added. Omit for the normal
  // case (fetch fresh, ground-truth state).
  function evaluate(knownCart) {
    console.log("GiftLab evaluate() called. Running state:", running);
    if (running) {
      needsReevaluate = true;
      return currentEvaluatePromise;
    }
    running = true;
    needsReevaluate = false;
    currentEvaluatePromise = runEvaluateCycleExclusive(knownCart);
    return currentEvaluatePromise;
  }

  async function runEvaluateCycleExclusive(knownCart) {
    if (!tryAcquireEvalLock()) {
      // Another run holds the lock. Wait for it to finish, then run our own
      // cycle anyway (the cart may have changed again since it started, and a
      // second evaluate is idempotent — it finds no mutations if nothing
      // changed). Crucially we do NOT skip after waiting: a lock stranded by a
      // page that unloaded mid-cycle must never permanently suppress the next
      // page's evaluation. Once the wait resolves we (best-effort) take the
      // lock and proceed.
      console.log("GiftLab: another evaluate cycle is in flight, waiting for it to settle...");
      await waitForEvalLockRelease();
      tryAcquireEvalLock();
    }
    try {
      await runEvaluateCycle(knownCart);
    } finally {
      releaseEvalLock();
    }
  }

  // Decides who repaints the cart drawer after we've added/removed gift lines,
  // and repaints only when necessary. The whole point is a SINGLE render with
  // the gift already in it — never a second "pop-in":
  //   • didMutate === false → we changed nothing, so there is nothing to
  //     repaint; the shopper's cart is exactly what the theme already drew.
  //   • pendingRenderHold === true → the shopper's own action triggered a
  //     theme render fetch that we're holding until right now; releasing it
  //     lets the theme paint the drawer once, gift included. We must NOT also
  //     repaint or the theme would render twice (the flicker/delay shoppers saw).
  //   • otherwise (single-request themes that add + render in one call, so no
  //     separate render fetch exists to hold) → we repaint the sections once
  //     ourselves, from ground-truth server-rendered HTML.
  //   • sectionsData, when present, is the sections HTML the mutation's own
  //     cart/add.js|change.js|update.js response already returned (they were
  //     called with the same sections param refreshCartSections() would use)
  //     — painting straight from it skips an entirely redundant extra fetch
  //     for data we already have in hand, cutting a full network round trip
  //     off the visible delay before the gift shows up.
  async function finalizeRender(didMutate, message, sectionsData) {
    if (didMutate && !pendingRenderHold) {
      if (sectionsData) {
        updateDOMWithSections(sectionsData);
      } else {
        await refreshCartSections();
      }
    }
    // Runs every evaluate cycle regardless of didMutate — cheap and
    // idempotent — as a catch-all in case a theme repaints the drawer
    // natively without ever dispatching a "cart:updated" event we'd
    // otherwise catch.
    enforceMysteryQuantityCaps();
    if (message) toast(message);
  }

  // Applies a batch of gift mutations (ADD/CHANGE/remove), returning what
  // changed so the caller can aggregate across passes. Extracted so the gift
  // decision can run a second time once a deferred mystery box price is known.
  async function applyGiftMutations(muts) {
    var didMutate = false;
    var giftMessage = "";
    var sections = null;
    var addedGift = false;
    for (var k = 0; k < muts.length; k += 1) {
      var mut = muts[k];
      var r = await applyMutation(mut);
      if (r) {
        patchCachedCartForMutation(mut);
        if (!mut.silent) didMutate = true;
        if (mut.type === "ADD") {
          addedGift = true;
          if (mut.notification && !giftMessage) giftMessage = mut.notification;
        }
        if (r.sections) sections = r.sections;
      }
    }
    if (addedGift) giftMessage = giftMessage || config.dataset.giftMessage || "A free gift has been added to your cart.";
    return { didMutate: didMutate, giftMessage: giftMessage, sections: sections };
  }

  async function runEvaluateCycle(knownCart) {
    try {
      // The rules list is fetched once on page load via the (slower, app-proxy
      // routed) evaluate loader. Without waiting for it here, the very first
      // cart action on a page always races ahead of it, finds an empty
      // `cachedRules`, and silently falls through to the much slower
      // authoritative server round-trip below on every single interaction.
      if (rulesLoadPromise) await rulesLoadPromise;
      // Snapshot from the previous cycle, kept only to detect a still-
      // qualifying gift line disappearing between cycles (i.e. the shopper
      // just deleted it) — see evaluateRulesLocally's previousCart param.
      var previousCart = cachedCart;
      var cart;
      if (knownCart) {
        console.log("GiftLab using the known-accurate cart from the triggering response — skipping the redundant cart.js re-fetch.");
        cart = knownCart;
      } else {
        console.log("GiftLab fetching current cart state...");
        var cartResponse = await fetch(getUrl("cart.js"), { credentials: "same-origin", cache: "no-store", headers: { "X-GiftLab-Internal": "1", "Cache-Control": "no-cache" } });
        if (!cartResponse.ok) {
          console.warn("GiftLab failed to fetch cart.js. Status:", cartResponse.status);
          return;
        }
        cart = await cartResponse.json();
      }
      cachedCart = cart;
      cachedCartOrderApproximate = !!cart._orderApproximate;
      cachedCartGeneration++;
      console.log("GiftLab cart items count:", cart.items.length, "Subtotal:", cart.items_subtotal_price);

      var didMutate = false;
      var latestSections = null;
      var giftMessage = "";

      // Try local evaluation first (instant, covers simple free gifts).
      var localMutations = evaluateRulesLocally(cachedRules, cart, previousCart);
      console.log("GiftLab local evaluation mutations result:", localMutations);

      // If the cart holds a tiered mystery box whose authoritative price we
      // don't have yet, deciding a subtotal-gated gift right now would use the
      // cart line's transient inflated price (Shopify reports it as unit ×
      // quantity for a few seconds after a mutation) — the exact cause of a
      // gift wrongly appearing when 5+ boxes momentarily read as far more than
      // they cost. Defer only the gift ADDs to after the mystery reconcile
      // below supplies the real basePrice; removes/corrections still run now.
      var deferGiftAdds = mysteryBoxNeedsPrice(cart);
      var firstPass = deferGiftAdds
        ? localMutations.filter(function (m) { return m.type !== "ADD"; })
        : localMutations;
      var giftApplied = await applyGiftMutations(firstPass);
      if (giftApplied.didMutate) didMutate = true;
      if (giftApplied.giftMessage) giftMessage = giftApplied.giftMessage;
      if (giftApplied.sections) latestSections = giftApplied.sections;

      // Mystery boxes are an independent concern from free gifts — check
      // regardless of what the gift pass did. Also fire on the transition FROM
      // having a box TO not having one (shopper removed it) so the server can
      // clean up the persisted pick. The reconcile also returns each box's
      // authoritative basePrice (see runMysteryReconcile → mergeBoxBasePrices).
      var mysteryLines = findMysteryBoxLines(cart);
      var previousMysteryLines = previousCart ? findMysteryBoxLines(previousCart) : [];
      if (mysteryLines.length > 0 || previousMysteryLines.length > 0) {
        var mysteryResult = await runMysteryReconcile(cart);
        if (mysteryResult) {
          if (mysteryResult.didMutate) didMutate = true;
          if (mysteryResult.sections) latestSections = mysteryResult.sections;
          // The deferred gift decision can now be made on the box's real
          // price the reconcile just supplied — decide correctly (adds the
          // gift only if the genuinely-discounted subtotal qualifies, and
          // never flashed a wrong one because the ADD was held back above).
          if (deferGiftAdds && mysteryResult.basePriceLearned) {
            var corrected = evaluateRulesLocally(cachedRules, cachedCart, previousCart);
            var giftApplied2 = await applyGiftMutations(corrected);
            if (giftApplied2.didMutate) didMutate = true;
            if (giftApplied2.giftMessage && !giftMessage) giftMessage = giftApplied2.giftMessage;
            if (giftApplied2.sections) latestSections = giftApplied2.sections;
          }
        }
      }

      await finalizeRender(didMutate, giftMessage, latestSections);
      return;
    } catch (error) {
      console.warn("GiftLab cart evaluation failed with error:", error);
    } finally {
      running = false;
      console.log("GiftLab evaluate() completed. Running state reset.");
      if (needsReevaluate) {
        await evaluate();
      }
    }
  }

  function isCartAction(url) {
    return /cart\/(add|change|update|clear)/i.test(url);
  }

  // A theme fetching freshly rendered cart HTML (drawer / cart page / icon
  // bubble) to repaint the UI after a cart change — e.g. `/cart?section_id=...`
  // or `/?sections=cart-drawer,cart-icon-bubble`. These are what we hold until
  // our gift/mystery evaluation settles, so the theme's own single paint
  // already contains the gift. A cart MUTATION (add/change/…) is deliberately
  // excluded here so it stays on the mutation path that triggers evaluate().
  function isCartSectionRender(url) {
    if (isCartAction(url)) return false;
    // Matching on "any cart-ish URL with a sections/section_id param" was too
    // broad: themes fetch other, unrelated cart-adjacent sections (e.g. a
    // background main-cart-items prefetch) that have nothing to do with the
    // drawer repainting. Holding one of those made finalizeRender assume "the
    // theme will repaint the drawer for me" when nothing actually would,
    // silently leaving the drawer stuck showing stale content (verified live:
    // the gift lands in the real cart but never appears in the drawer).
    // Only hold a fetch that's actually requesting the drawer/bubble sections
    // we ourselves repaint from.
    var match = url.match(/[?&](?:sections|section_id)=([^&]*)/i);
    if (!match) return false;
    var requested = decodeURIComponent(match[1]);
    return /cart-drawer|cart-icon-bubble/i.test(requested);
  }

  // Single source of truth for a free-gift line's properties — used both by
  // the instant add-time batch (buildGiftItemPayload) and by
  // evaluateRulesLocally's add/correct pass, so a rule's current Qty/discount
  // config is expressed identically everywhere instead of duplicated
  // (duplicated copies are exactly how the add path and the correction path
  // could disagree on what the line "should" look like).
  function buildFreeGiftProperties(rule, gift) {
    var properties = {
      _free_gift_rule: rule.id,
      _promotion_kind: "free_gift",
      _free_gift_discount_type: gift.discountType,
      _free_gift_discount_value: String(gift.discountValue),
      // Signed awarded quantity (must match gift.quantity, which the
      // app-proxy loader baked into gift.signature) so the checkout
      // Function only discounts this many units.
      _free_gift_qty: String(gift.quantity),
      _free_gift_name: rule.name,
      _promotion_signature: gift.signature || "",
      "Free gift": rule.name
    };
    // The checkout Discount Function re-verifies the line's HMAC signature
    // over discountType|discountValue|qty|<conditions-or-UNVERIFIABLE>. If we
    // don't carry the matching conditions blob (or the unverifiable flag),
    // that reconstruction won't match the signature and the gift is charged
    // at checkout instead of being $0.
    if (rule.unverifiable) {
      properties._free_gift_unverifiable = "true";
    } else if (rule.conditionsBlob) {
      properties._free_gift_conditions = rule.conditionsBlob;
    }
    return properties;
  }

  function buildGiftItemPayload(rule, gift) {
    var properties = buildFreeGiftProperties(rule, gift);
    return { id: gift.variantId, quantity: gift.quantity, properties: properties };
  }

  // Whether the given rule's gift variant is already a line in the cart, so we
  // never batch a duplicate: re-adding the same variant with identical signed
  // properties would merge into the existing line and inflate its quantity
  // beyond the signed award (the shopper would see 2 gifts but the Function
  // only zeroes 1). cart defaults to the last snapshot we hold.
  function giftAlreadyInCart(rule, gift, cart) {
    var c = cart || cachedCart;
    if (!c || !c.items) return false;
    return c.items.some(function (item) {
      return item.properties && item.properties._free_gift_rule === rule.id &&
        numericId(item.variant_id) === numericId(gift.variantId) && item.quantity > 0;
    });
  }

  function getMatchingGiftsForPayload(items) {
    if (!cachedRules || !cachedRules.length) return [];
    if (!cachedCart) return [];
    // Customer gates (tags / first-purchase) + priority + stackable apply at
    // add time too; conditions are checked via ruleConditionsMatchAtAddTime.
    // When every item in this request can be priced from the page's own
    // product metadata (buildProbeCart), ANY condition — subtotal included —
    // is checked exactly, so a subtotal-crossing add batches its gift into
    // this SAME request, same as a "variant equals" rule always has. If an
    // item's price can't be resolved that way, that function falls back to
    // trusting only an exact "variant equals" match and defers everything
    // else to the confirmed current cart (this is why the earlier "gift
    // flashes in then vanishes" bug — batching for a subtotal condition an
    // unrelated low-value add didn't actually satisfy — can't recur: we only
    // ever act on a real computed total, never a guess).
    var probeVariantIds = (items || []).map(function (it) { return numericId(it.id); }).filter(Boolean);
    var probeCart = buildProbeCart(cachedCart, items);
    var effective = computeEffectiveRules(cachedRules, cachedCart, probeVariantIds, probeCart);
    var giftsToAdd = [];
    effective.forEach(function (rule) {
      if (isRuleDeclined(rule.id)) return;
      resolveGiftsForRule(rule).forEach(function (g) {
        // Skip a gift already in the cart (prevents duplicate/quantity
        // inflation when adding a second product while the gift is present).
        if (giftAlreadyInCart(rule, g)) return;
        giftsToAdd.push(buildGiftItemPayload(rule, g));
      });
    });
    return giftsToAdd;
  }

  // Intercept window.fetch
  var originalFetch = window.fetch;
  window.fetch = function () {
    var args = arguments;
    var requestUrl = typeof args[0] === "string" ? args[0] : (args[0] && args[0].url) || "";
    var isInternal = (args[1] && args[1].headers && (args[1].headers["X-GiftLab-Internal"] || args[1].headers.get && args[1].headers.get("X-GiftLab-Internal"))) || requestUrl.indexOf("apps/giftlab") !== -1;

    console.log("GiftLab intercepted fetch. URL:", requestUrl, "isInternal:", isInternal);

    if (!isInternal && isCartSectionRender(requestUrl)) {
      return originalFetch.apply(window, args);
    }

    // Intercept single Add-to-Cart calls to batch the gift item into the VERY FIRST request (Zero Delay!)
    if (!isInternal && (requestUrl.indexOf("/cart/add") !== -1)) {
      try {
        var options = args[1] || {};
        if (options.body) {
          if (typeof FormData !== "undefined" && options.body instanceof FormData) {
            var mainId = options.body.get("id");
            var mainQty = options.body.get("quantity") || "1";
            if (mainId) {
              // A mystery box's maxPerOrder caps the TOTAL the shopper can
              // hold at once — add.js is additive, so the cap is against
              // whatever's already in the cart plus this request.
              var mainBox = findMysteryBoxByVariantId(mainId);
              var mainBoxProps = null;
              if (mainBox) {
                var clampedMainQty = clampToMysteryLimit(mainBox, mainQty, currentCartQuantityFor(mainId));
                if (String(clampedMainQty) !== String(mainQty)) {
                  mainQty = String(clampedMainQty);
                  options.body.set("quantity", mainQty);
                }
                // Attach the qualifying tier's precomputed, signed price
                // properties in this SAME add request (same mechanism the
                // /cart/change interceptor already uses) so the box carries
                // its discount from the very first request — the discount
                // Function then prices it correctly on the first recompute
                // instead of only after the later server reconcile round-trip,
                // which is what caused the box to flash its full price first.
                if (mainBox.tiers && mainBox.tiers.length) {
                  var mainBoxTotalQty = currentCartQuantityFor(mainId) + (Number(mainQty) || 0);
                  var builtMainProps = buildMysteryLineProperties(null, mainBox, mainBoxTotalQty);
                  if (Object.keys(builtMainProps).length) mainBoxProps = builtMainProps;
                }
              }
              var gifts = getMatchingGiftsForPayload([{ id: mainId, quantity: mainQty }]);
              if (gifts.length > 0) {
                console.log("GiftLab batching gift items into FormData add.js payload...", gifts);
                options.body.delete("id");
                options.body.delete("quantity");
                options.body.append("items[0][id]", mainId);
                options.body.append("items[0][quantity]", mainQty);
                if (mainBoxProps) {
                  Object.keys(mainBoxProps).forEach(function (pk) {
                    options.body.append("items[0][properties][" + pk + "]", mainBoxProps[pk]);
                  });
                }

                gifts.forEach(function (g, idx) {
                  var itemIdx = idx + 1;
                  options.body.append("items[" + itemIdx + "][id]", g.id);
                  options.body.append("items[" + itemIdx + "][quantity]", String(g.quantity));
                  if (g.properties) {
                    Object.keys(g.properties).forEach(function (pk) {
                      options.body.append("items[" + itemIdx + "][properties][" + pk + "]", g.properties[pk]);
                    });
                  }
                });
              } else if (mainBoxProps) {
                // No gift to batch, but the box still needs its tier price
                // properties attached to its own (single-item) add payload.
                Object.keys(mainBoxProps).forEach(function (pk) {
                  options.body.append("properties[" + pk + "]", mainBoxProps[pk]);
                });
              }
            }
          } else if (typeof options.body === "string") {
            if (options.body.indexOf("{") === 0) {
              var payload = JSON.parse(options.body);
              var items = payload.items || (payload.id ? [payload] : []);
              // Same maxPerOrder cap as the FormData path above, applied to
              // every item in this add request that's a mystery box variant.
              // `items` aliases the same objects as payload.items/payload
              // itself (see the `[payload]` wrap above), so mutating them
              // here updates the real payload directly — no reassignment
              // needed.
              items.forEach(function (it) {
                var itBox = it && it.id && findMysteryBoxByVariantId(it.id);
                if (itBox) {
                  it.quantity = clampToMysteryLimit(itBox, it.quantity || 1, currentCartQuantityFor(it.id));
                  // Same first-request tier-price attachment as the FormData
                  // path above, so a JSON add also lands the box already
                  // priced instead of flashing its full price.
                  if (itBox.tiers && itBox.tiers.length) {
                    var itTotalQty = currentCartQuantityFor(it.id) + (Number(it.quantity) || 0);
                    var itProps = buildMysteryLineProperties(it.properties || null, itBox, itTotalQty);
                    if (Object.keys(itProps).length) it.properties = itProps;
                  }
                }
              });
              var gifts = getMatchingGiftsForPayload(items);
              if (gifts.length > 0) {
                console.log("GiftLab batching gift items into primary JSON add.js payload...", gifts);
                payload.items = items.concat(gifts);
                delete payload.id;
                delete payload.quantity;
                delete payload.properties;
              }
              options.body = JSON.stringify(payload);
            }
          }
        }
      } catch (e) {
        console.warn("GiftLab failed to batch add payload:", e);
      }
    }

    // Intercept line removal calls (/cart/change.js) to batch remove the gift item simultaneously!
    if (!isInternal && (requestUrl.indexOf("/cart/change") !== -1)) {
      try {
        var options = args[1] || {};
        var isRemove = false;
        var lineOrKey = null;
        var newQuantity = null;
        // The theme asks Shopify to re-render specific sections after the
        // change so it can repaint the drawer AND the cart-count badge. Dawn
        // (and most themes) send that list in the request BODY, not the URL —
        // reading it only from the URL is why the badge used to stay stuck at
        // the old count after a removal. Capture whatever the theme requested
        // (body first, URL second) and always fall back to the drawer+bubble
        // pair so the badge is guaranteed to repaint.
        var requestedSections = null;

        if (options.body) {
          if (typeof FormData !== "undefined" && options.body instanceof FormData) {
            var q = options.body.get("quantity");
            if (q !== null) {
              newQuantity = Number(q);
              if (newQuantity === 0) isRemove = true;
              lineOrKey = options.body.get("line") || options.body.get("id");
            }
            requestedSections = options.body.get("sections");
          } else if (typeof options.body === "string" && options.body.indexOf("{") === 0) {
            var p = JSON.parse(options.body);
            if (p.quantity !== undefined && p.quantity !== null) {
              newQuantity = Number(p.quantity);
              if (newQuantity === 0) isRemove = true;
              lineOrKey = p.line || p.id;
            }
            if (p.sections) requestedSections = p.sections;
          }
        }
        if (!requestedSections && requestUrl.indexOf("sections=") !== -1) {
          var secMatch = requestUrl.match(/sections=([^&]*)/);
          if (secMatch) requestedSections = decodeURIComponent(secMatch[1]);
        }

        if (isRemove && cachedCart && cachedCart.items) {
          var updates = {};
          var hasGiftToRemove = false;
          // Only trust a bare "line N" position match against cachedCart's
          // order when that order is server-confirmed (see
          // cachedCartOrderApproximate) — matching by key/variant id/id is
          // always safe since those don't depend on order at all. Without
          // this guard, a removal request landing right after a batched add
          // (whose line order is only our best guess) could resolve "line 2"
          // to the WRONG item and end up zeroing something the shopper never
          // asked to remove.
          var targetMatched = false;
          cachedCart.items.forEach(function (item, idx) {
            var lineNum = String(idx + 1);
            var isPositionMatch = !cachedCartOrderApproximate && lineOrKey === lineNum;
            var isKeyMatch = lineOrKey === item.key || lineOrKey === String(item.variant_id) || lineOrKey === String(item.id);
            if (isPositionMatch || isKeyMatch) {
              updates[item.key] = 0;
              targetMatched = true;
            } else if (item.properties && (item.properties._free_gift_rule || item.properties._promotion_kind === "free_gift")) {
              updates[item.key] = 0;
              hasGiftToRemove = true;
            }
          });

          if (hasGiftToRemove && targetMatched) {
            console.log("GiftLab converting remove call to combined /cart/update.js...", updates);
            args[0] = getUrl("cart/update.js");
            var newBody = {
              updates: updates,
              // Preserve the exact sections the theme asked for so its own
              // response handler repaints the drawer + badge as it normally
              // would; default to the standard drawer+bubble pair otherwise.
              sections: requestedSections || "cart-drawer,cart-icon-bubble"
            };
            options.body = JSON.stringify(newBody);
            options.headers = options.headers || {};
            if (options.headers instanceof Headers) {
              options.headers.set("Content-Type", "application/json");
            } else {
              options.headers["Content-Type"] = "application/json";
            }
          }
        }

        // A quantity change (not a removal) on an existing mystery box line
        // with price tiers: attach the correct tier's already-signed
        // properties into this SAME request, so the discount applies in the
        // very first repaint instead of a beat later. Every signature is
        // precomputed per-tier at sync time (see syncMysteryBoxConfig) since
        // it depends only on the box/tier configuration, never on the
        // quantity — so no server round trip is needed to pick the right one.
        // Without this, bumping quantity briefly showed the undiscounted
        // price before a follow-up call corrected it, and dropping back below
        // a tier's threshold left the old discount visibly applied for a beat.
        if (!isRemove && newQuantity !== null && lineOrKey !== null && cachedMysteryBoxes && cachedMysteryBoxes.length) {
          // Identify the target line's variant id WITHOUT depending on
          // cachedCart at all: a Shopify cart line key is always
          // "<variantId>:<propertiesHash>", so it can be read directly off
          // the identifier the theme itself just sent — instant, no race.
          // cachedCart is only a fallback for the rarer case where the theme
          // instead sent a bare `line` position index. Relying on cachedCart
          // as the PRIMARY source failed under fast back-to-back actions
          // (e.g. change quantity right after add): its own snapshot is only
          // refreshed by this script's own evaluate cycle, which can still be
          // in flight and not yet even contain the just-added line at all —
          // confirmed live (verified via automated 0-delay repro).
          var targetVariantId = null;
          var targetExistingProperties = null;
          var lineOrKeyStr = String(lineOrKey);
          var colonIdx = lineOrKeyStr.indexOf(":");
          if (colonIdx !== -1) {
            targetVariantId = numericId(lineOrKeyStr.slice(0, colonIdx));
          } else if (/^\d{6,}$/.test(lineOrKeyStr)) {
            // A long bare digit string sent as `id` is a variant id directly
            // (rather than a short `line` position index like "1" or "2").
            targetVariantId = numericId(lineOrKeyStr);
          }
          if (cachedCart && cachedCart.items) {
            cachedCart.items.forEach(function (item, idx) {
              var lineNum = String(idx + 1);
              if (lineOrKey === lineNum || lineOrKey === item.key || lineOrKey === String(item.variant_id) || lineOrKey === String(item.id)) {
                targetExistingProperties = item.properties;
                if (!targetVariantId) targetVariantId = numericId(item.variant_id);
              }
            });
          }
          var mBox = targetVariantId && findMysteryBoxByVariantId(targetVariantId);
          if (mBox) {
            // A change.js call SETS the line's quantity outright (not
            // additive), so the cap is just the new value itself.
            var clampedQuantity = clampToMysteryLimit(mBox, newQuantity, 0);
            if (clampedQuantity !== newQuantity) {
              newQuantity = clampedQuantity;
              if (typeof FormData !== "undefined" && options.body instanceof FormData) {
                options.body.set("quantity", String(newQuantity));
              } else if (typeof options.body === "string") {
                var pClamped = JSON.parse(options.body);
                pClamped.quantity = newQuantity;
                options.body = JSON.stringify(pClamped);
              }
            }
            if (mBox.tiers && mBox.tiers.length) {
              var mergedProps = buildMysteryLineProperties(targetExistingProperties, mBox, newQuantity);
              console.log("GiftLab attaching instant price-tier properties for quantity change...", mergedProps);
              if (typeof FormData !== "undefined" && options.body instanceof FormData) {
                Object.keys(mergedProps).forEach(function (pk) {
                  options.body.append("properties[" + pk + "]", mergedProps[pk]);
                });
              } else if (typeof options.body === "string") {
                var p3 = JSON.parse(options.body);
                p3.properties = mergedProps;
                options.body = JSON.stringify(p3);
              }
            }
          }
        }
      } catch (e) {
        console.warn("GiftLab failed to combine remove payload:", e);
      }
    }

    return originalFetch.apply(window, args).then(async function (response) {
      if (!isInternal && isCartAction(requestUrl)) {
        if (response.ok) {
          console.log("GiftLab: External cart fetch succeeded. Triggering instant evaluate()...");
          pendingRenderHold = false;
          if (/cart\/add/i.test(requestUrl)) {
            // The add response itself already echoes back the real
            // price/product/variant data for whatever was just added — no
            // guessing needed (unlike at intercept time, before the request
            // was even sent, when only a bare variant id is known). Using it
            // to build an accurate post-add cart lets this cycle skip its own
            // cart.js re-fetch entirely, which is what used to make a
            // subtotal-crossing add (e.g. one expensive product that alone
            // clears the threshold) take a full extra round trip before the
            // gift appeared — clone() so the theme's own handler still gets
            // an unconsumed body to read.
            response.clone().json().then(function (addedJson) {
              evaluate(buildKnownCartAfterAdd(addedJson)).then(correctCartOrderInBackground);
            }).catch(function () {
              evaluate();
            });
          } else if (/cart\/(change|update)/i.test(requestUrl)) {
            // Unlike /cart/add.js (which only echoes the item(s) just added),
            // /cart/change.js and /cart/update.js both echo back the COMPLETE
            // post-mutation cart — the exact same shape evaluate() would
            // otherwise re-fetch from cart.js a moment later. Using it
            // directly removes that redundant round trip, which is what
            // delayed a gift's removal after deleting its trigger product.
            response.clone().json().then(function (changedCart) {
              evaluate(changedCart && changedCart.items ? changedCart : undefined);
            }).catch(function () {
              evaluate();
            });
          } else {
            evaluate();
          }
        }
      }
      if (pendingMysteryLimitMessage) {
        toast(pendingMysteryLimitMessage);
        pendingMysteryLimitMessage = null;
      }
      // Native add/change requests only: if this touched a mystery box whose
      // discount hasn't caught up with Shopify's own async recompute yet,
      // hold what the THEME receives until it has, so it only ever paints
      // the correct number — never Shopify's raw pre-discount one.
      if (!isInternal && isCartAction(requestUrl) && response.ok) {
        try {
          var settledResponse = await holdForSettledMysteryPrice(response, requestUrl);
          if (settledResponse) return settledResponse;
        } catch (e) {
          console.warn("GiftLab: mystery price settle-hold failed, returning the original response", e);
        }
      }
      return response;
    });
  };

  // Intercept XMLHttpRequest (for themes using jQuery or other XHR libraries)
  var originalXhrOpen = XMLHttpRequest.prototype.open;
  var originalXhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this._url = url;
    return originalXhrOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    var self = this;
    this.addEventListener("load", function () {
      var requestUrl = self._url || "";
      var isInternal = requestUrl.indexOf("apps/giftlab") !== -1;
      console.log("GiftLab intercepted XHR. URL:", requestUrl, "isInternal:", isInternal);
      if (!isInternal && isCartAction(requestUrl)) {
        if (self.status >= 200 && self.status < 300) {
          console.log("GiftLab XHR matched cart action. Triggering instant evaluate()...");
          evaluate();
        }
      }
    });
    return originalXhrSend.apply(this, arguments);
  };

  // Guarantees the hidden mystery-box pick (and any pending gift mutation) is
  // always attached before the shopper can actually reach checkout — without
  // this, a shopper who clicks "Checkout"/"Buy it now" fast enough could beat
  // the evaluate() round-trip and land on checkout with a raw, unprocessed
  // mystery box line (no hidden item ever recorded for the merchant to ship).
  //
  // The guard flag lives on the form element itself (not a module-scoped var)
  // because some themes end up loading this script more than once on the same
  // page; each copy gets its own closure, so a plain variable wouldn't be
  // visible across copies and they'd re-intercept each other's programmatic
  // resubmit, ping-ponging forever instead of letting checkout through.
  function isIntercepting(el) {
    return Boolean(el.__giftlabIntercepting);
  }
  function setIntercepting(el, value) {
    el.__giftlabIntercepting = value;
  }

  // evaluate() already awaits rulesLoadPromise and chains through any
  // deferred re-evaluation, so calling it here is sufficient to guarantee a
  // fully up-to-date, settled cart (hidden mystery pick included) before we
  // let the shopper proceed.
  async function ensureEvaluatedBeforeCheckout() {
    await evaluate();
  }

  function isCheckoutSubmitter(submitter) {
    return Boolean(submitter && submitter.name === "checkout");
  }

  function isCheckoutLink(link) {
    if (!link || !link.href) return false;
    try {
      var path = new URL(link.href, window.location.href).pathname;
      return path === "/checkout" || path.indexOf("/checkout/") === 0 || path.indexOf("/cart/checkout") === 0;
    } catch (e) {
      return false;
    }
  }

  // Capture phase so this runs before the browser/theme actually navigates or
  // submits, on both the cart page's "Checkout" button and a product page's
  // "Buy it now" button (both are conventionally a submit button named
  // "checkout" in Shopify themes).
  document.addEventListener("submit", function (event) {
    var form = event.target;
    if (isIntercepting(form)) return;
    var submitter = event.submitter || (form && form.querySelector && form.querySelector("[name=checkout]"));
    if (!isCheckoutSubmitter(submitter)) return;
    event.preventDefault();
    console.log("GiftLab: intercepted checkout form submit, finishing evaluation first...");
    ensureEvaluatedBeforeCheckout().then(function () {
      setIntercepting(form, true);
      if (typeof form.requestSubmit === "function") form.requestSubmit(submitter);
      else form.submit();
      setIntercepting(form, false);
    });
  }, true);

  document.addEventListener("click", function (event) {
    var link = event.target && event.target.closest && event.target.closest("a[href]");
    if (!isCheckoutLink(link) || isIntercepting(link)) return;
    event.preventDefault();
    console.log("GiftLab: intercepted checkout link click, finishing evaluation first...");
    var href = link.href;
    ensureEvaluatedBeforeCheckout().then(function () {
      window.location.href = href;
    });
  }, true);

  function init() {
    rulesLoadPromise = loadRulesAndCart();
    rulesLoadPromise.then(function () { evaluate(); });
  }

  var pendingToast = sessionStorage.getItem(TOAST_KEY);
  if (pendingToast) {
    sessionStorage.removeItem(TOAST_KEY);
    document.addEventListener("DOMContentLoaded", function () { toast(pendingToast); });
  }
  document.addEventListener("cart:updated", function (event) {
    // Re-apply the quantity-cap UI touch regardless of who repainted the
    // drawer (us or the theme's own native render) — this is what catches a
    // theme's OWN native repaint, which never goes through
    // updateDOMWithSections at all.
    enforceMysteryQuantityCaps();
    if (event && event.detail && event.detail.source === "giftlab") return;
    console.log("GiftLab: cart:updated event received. Re-evaluating...");
    evaluate();
  });
  // Only re-initialize on an actual back/forward-cache restore; a normal fresh
  // load is handled by the single immediate init below. This avoids firing
  // three redundant rule/cart loads (immediate + DOMContentLoaded + pageshow)
  // on every pageview.
  window.addEventListener("pageshow", function (event) {
    if (event.persisted) init();
  });

  // Single initial run for this pageview.
  init();
})();
