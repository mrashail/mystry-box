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
  var rulesLoadPromise = null;

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
      if (!result.mutations || !result.mutations.length) return null;
      var didMutate = false;
      var latestSections = null;
      for (var i = 0; i < result.mutations.length; i += 1) {
        var mut = result.mutations[i];
        var r = await applyMutation(mut);
        if (r) {
          patchCachedCartForMutation(mut);
          if (!mut.silent) didMutate = true;
          if (r.sections) latestSections = r.sections;
        }
      }
      return { didMutate: didMutate, sections: latestSections };
    } catch (e) {
      console.warn("GiftLab mystery reconcile failed:", e);
      return null;
    }
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
        var isGift = item.properties && (item.properties._free_gift_rule || item.properties._mystery_box_reward);
        if (!isGift) {
          subtotal += (item.final_price || item.price || 0) * item.quantity;
        }
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

  // At add-to-cart time the item(s) about to be added aren't in the cart
  // snapshot yet, and all we know about them is a bare variant id (no price,
  // no product id — themes send just `id`/`items[].id` to /cart/add) — not
  // enough to safely simulate a subtotal, quantity, or product-level
  // condition. The one thing we CAN say with total certainty is "this exact
  // variant is one of the ones being added" — a "variant equals" condition
  // targeting it is guaranteed true regardless of what else happens. Every
  // other condition is judged against the cart as it stands right NOW
  // (before this add): if this very add is what pushes it over the line, the
  // very next evaluate() reconcile (already fast) picks it up a beat later —
  // far better than instant-batching a gift whose condition doesn't actually
  // end up true and having to silently un-add it (the flash the merchant saw).
  function ruleConditionsMatchAtAddTime(rule, cart, probeVariantIds) {
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
  function computeEffectiveRules(rules, cart, probeVariantIds) {
    var matched = (rules || []).filter(function (rule) {
      if (!ruleAllowedForCustomer(rule)) return false;
      return probeVariantIds
        ? ruleConditionsMatchAtAddTime(rule, cart, probeVariantIds)
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
    // Add missing gifts (only the resolved subset — respects Allow multiple /
    // Max gifts / One per order)
    matchedRules.forEach(function (rule) {
      if (declinedSet[rule.id]) return;
      resolveGiftsForRule(rule).forEach(function (gift) {
        var current = cart.items.find(function (item) {
          return item.properties && item.properties._free_gift_rule === rule.id && numericId(item.variant_id) === numericId(gift.variantId);
        });
        if (!current) {
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
            _promotion_signature: gift.signature,
            "Free gift": rule.name
          };
          if (rule.unverifiable) {
            properties._free_gift_unverifiable = "true";
          } else {
            properties._free_gift_conditions = rule.conditionsBlob;
          }
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

  function evaluate() {
    console.log("GiftLab evaluate() called. Running state:", running);
    if (running) {
      needsReevaluate = true;
      return currentEvaluatePromise;
    }
    running = true;
    needsReevaluate = false;
    currentEvaluatePromise = runEvaluateCycleExclusive();
    return currentEvaluatePromise;
  }

  async function runEvaluateCycleExclusive() {
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
      await runEvaluateCycle();
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
    if (message) toast(message);
  }

  async function runEvaluateCycle() {
    try {
      // The rules list is fetched once on page load via the (slower, app-proxy
      // routed) evaluate loader. Without waiting for it here, the very first
      // cart action on a page always races ahead of it, finds an empty
      // `cachedRules`, and silently falls through to the much slower
      // authoritative server round-trip below on every single interaction.
      if (rulesLoadPromise) await rulesLoadPromise;
      console.log("GiftLab fetching current cart state...");
      var cartResponse = await fetch(getUrl("cart.js"), { credentials: "same-origin", cache: "no-store", headers: { "X-GiftLab-Internal": "1", "Cache-Control": "no-cache" } });
      if (!cartResponse.ok) {
        console.warn("GiftLab failed to fetch cart.js. Status:", cartResponse.status);
        return;
      }
      // Snapshot from the previous cycle, kept only to detect a still-
      // qualifying gift line disappearing between cycles (i.e. the shopper
      // just deleted it) — see evaluateRulesLocally's previousCart param.
      var previousCart = cachedCart;
      var cart = await cartResponse.json();
      cachedCart = cart;
      console.log("GiftLab cart items count:", cart.items.length, "Subtotal:", cart.items_subtotal_price);

      var didMutate = false;
      var latestSections = null;
      var giftMessage = "";

      // Try local evaluation first (instant, covers simple free gifts)
      var localMutations = evaluateRulesLocally(cachedRules, cart, previousCart);
      console.log("GiftLab local evaluation mutations result:", localMutations);

      if (localMutations.length > 0) {
        var addedGift = false;
        for (var k = 0; k < localMutations.length; k += 1) {
          var mut = localMutations[k];
          var r = await applyMutation(mut);
          if (r) {
            patchCachedCartForMutation(mut);
            if (!mut.silent) didMutate = true;
            if (mut.type === "ADD") {
              addedGift = true;
              // Prefer the per-rule storefront message the merchant wrote.
              if (mut.notification && !giftMessage) giftMessage = mut.notification;
            }
            if (r.sections) latestSections = r.sections;
          }
        }
        if (addedGift) giftMessage = giftMessage || config.dataset.giftMessage || "A free gift has been added to your cart.";
      }
      // No local gift mutation needed: the cart already matches what the
      // rules want (gift present and still qualifying, or nothing qualifies).
      // The checkout Discount Function keeps the gift line at $0, and the
      // native Cart Transform Function is a no-JS safety net at checkout.

      // Mystery boxes are an entirely independent concern from free gifts —
      // check regardless of what the gift pass above did. A cart with no
      // mystery box line, and that never had one a moment ago either, never
      // calls the server at all.
      //
      // Also fire once on the transition FROM having a box line TO not having
      // one (previousMysteryLines but not mysteryLines) — that's the shopper
      // just removing the box. The server's cleanup for "box no longer in
      // cart" (deleting the persisted MysterySelection roll, so a later
      // re-add starts fresh instead of reusing the old pick) only runs when
      // it's actually asked to evaluate that now-box-less cart. Skipping this
      // call on removal was exactly why re-adding the box kept giving back
      // the very first item ever rolled for this cart, forever.
      var mysteryLines = findMysteryBoxLines(cart);
      var previousMysteryLines = previousCart ? findMysteryBoxLines(previousCart) : [];
      if (mysteryLines.length > 0 || previousMysteryLines.length > 0) {
        var mysteryResult = await runMysteryReconcile(cart);
        if (mysteryResult) {
          if (mysteryResult.didMutate) didMutate = true;
          if (mysteryResult.sections) latestSections = mysteryResult.sections;
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

  function buildGiftItemPayload(rule, gift) {
    var properties = {
      _free_gift_rule: rule.id,
      _promotion_kind: "free_gift",
      _free_gift_discount_type: gift.discountType,
      _free_gift_discount_value: String(gift.discountValue),
      _free_gift_qty: String(gift.quantity),
      _free_gift_name: rule.name,
      _promotion_signature: gift.signature || "",
      "Free gift": rule.name
    };
    // The checkout Discount Function re-verifies the line's HMAC signature
    // over discountType|discountValue|qty|<conditions-or-UNVERIFIABLE>. If we
    // don't carry the matching conditions blob (or the unverifiable flag),
    // that reconstruction won't match the signature and the gift is charged
    // at checkout instead of being $0. evaluateRulesLocally's add path already
    // attaches these; the batched-add path must attach them identically.
    if (rule.unverifiable) {
      properties._free_gift_unverifiable = "true";
    } else if (rule.conditionsBlob) {
      properties._free_gift_conditions = rule.conditionsBlob;
    }
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
    // add time too; conditions are checked via ruleConditionsMatchAtAddTime —
    // only an exact "variant equals" match on one of these ids is trusted
    // before the add lands, everything else is judged against the confirmed
    // current cart (see that function for why: batching a gift for e.g. a
    // subtotal condition this add doesn't actually satisfy — an unrelated
    // low-value product like a mystery box — was exactly the "gift flashes
    // in then vanishes" bug).
    var probeVariantIds = (items || []).map(function (it) { return numericId(it.id); }).filter(Boolean);
    var effective = computeEffectiveRules(cachedRules, cachedCart, probeVariantIds);
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
              var gifts = getMatchingGiftsForPayload([{ id: mainId }]);
              if (gifts.length > 0) {
                console.log("GiftLab batching gift items into FormData add.js payload...", gifts);
                options.body.delete("id");
                options.body.delete("quantity");
                options.body.append("items[0][id]", mainId);
                options.body.append("items[0][quantity]", mainQty);

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
              }
            }
          } else if (typeof options.body === "string") {
            if (options.body.indexOf("{") === 0) {
              var payload = JSON.parse(options.body);
              var items = payload.items || (payload.id ? [payload] : []);
              var gifts = getMatchingGiftsForPayload(items);
              if (gifts.length > 0) {
                console.log("GiftLab batching gift items into primary JSON add.js payload...", gifts);
                payload.items = items.concat(gifts);
                delete payload.id;
                delete payload.quantity;
                delete payload.properties;
                options.body = JSON.stringify(payload);
              }
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
          cachedCart.items.forEach(function (item, idx) {
            var lineNum = String(idx + 1);
            if (lineOrKey === lineNum || lineOrKey === item.key || lineOrKey === String(item.variant_id) || lineOrKey === String(item.id)) {
              updates[item.key] = 0;
            } else if (item.properties && (item.properties._free_gift_rule || item.properties._promotion_kind === "free_gift")) {
              updates[item.key] = 0;
              hasGiftToRemove = true;
            }
          });

          if (hasGiftToRemove) {
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
          var mBox = targetVariantId && cachedMysteryBoxes.filter(function (b) {
            return (b.parentVariantId && numericId(b.parentVariantId) === targetVariantId) ||
              (b.boxVariantId && numericId(b.boxVariantId) === targetVariantId);
          })[0];
          if (mBox && mBox.tiers && mBox.tiers.length) {
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
      } catch (e) {
        console.warn("GiftLab failed to combine remove payload:", e);
      }
    }

    return originalFetch.apply(window, args).then(function (response) {
      if (!isInternal && isCartAction(requestUrl)) {
        if (response.ok) {
          console.log("GiftLab: External cart fetch succeeded. Triggering instant evaluate()...");
          pendingRenderHold = false;
          evaluate();
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
