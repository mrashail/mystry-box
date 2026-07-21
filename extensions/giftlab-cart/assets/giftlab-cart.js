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

  var cachedRules = [];
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

  function syncCartBadges(itemCount) {
    // Never guess the count. cart/add.js responses omit the cart-level
    // item_count, and defaulting a missing value to 0 used to flag the whole
    // drawer as empty (is-empty) even with items present. If we don't have a
    // real number, leave the server-rendered sections/badge as-is.
    if (typeof itemCount !== "number" || isNaN(itemCount)) {
      console.log("GiftLab syncCartBadges skipped — no reliable count:", itemCount);
      return;
    }
    console.log("GiftLab syncing cart badges to count:", itemCount);

    // Toggle empty cart classes on the drawer element
    var drawers = document.querySelectorAll("cart-drawer, .drawer, #CartDrawer");
    drawers.forEach(function (drawer) {
      if (itemCount === 0) {
        drawer.classList.add("is-empty");
      } else {
        drawer.classList.remove("is-empty");
      }
    });

    if (itemCount === 0) {
      var bubbles = document.querySelectorAll(".cart-count-bubble, #cart-icon-bubble .cart-count-bubble, .cart-count-bubble");
      bubbles.forEach(function (el) {
        el.remove();
      });
      var elements = document.querySelectorAll("[data-cart-count], .cart-counter, .cart-count, .header__cart-count");
      elements.forEach(function (el) {
        el.textContent = "0";
        el.classList.add("hidden");
        el.style.display = "none";
      });
    } else {
      var elements = document.querySelectorAll("[data-cart-count], .cart-counter, .cart-count, .header__cart-count");
      elements.forEach(function (el) {
        el.textContent = String(itemCount);
        el.classList.remove("hidden");
        el.style.display = "";
      });
    }
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

  async function loadRulesAndCart() {
    try {
      var custStr = encodeURIComponent(JSON.stringify(customer()));
      var rulesResp = await fetch(getUrl("apps/giftlab/evaluate?customer=" + custStr), { credentials: "same-origin", cache: "no-store", headers: { "X-GiftLab-Internal": "1" } });
      if (rulesResp.ok) {
        var res = await rulesResp.json();
        cachedRules = res.rules || [];
        console.log("GiftLab loaded active rules list:", cachedRules);
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
    if (mutation.type === "CHANGE") {
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
      // Never target the "cart-drawer" wrapper itself (or any other outer
      // dialog/drawer root element): it contains the click-outside-to-close
      // overlay as a child, and replacing its innerHTML destroys that overlay
      // node. The theme's own JS grabs a direct reference to the overlay once
      // at page load and binds its close handler to that exact node — once we
      // replace it, the new-look-alike overlay has no listener at all, so
      // clicking outside the drawer silently does nothing. Only ever touch
      // the inner content regions (items/summary/footer/bubble) below.
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
      // Never target the "cart-drawer" wrapper itself (or any other outer
      // dialog/drawer root element): it contains the click-outside-to-close
      // overlay as a child, and replacing its innerHTML destroys that overlay
      // node. The theme's own JS grabs a direct reference to the overlay once
      // at page load and binds its close handler to that exact node — once we
      // replace it, the new-look-alike overlay has no listener at all, so
      // clicking outside the drawer silently does nothing. Only ever touch
      // the inner content regions (items/summary/footer/bubble) below.
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

  // Authoritative cart item_count. Used instead of a mutation response's
  // item_count because cart/add.js doesn't include it.
  async function fetchCartItemCount() {
    try {
      var resp = await fetch(getUrl("cart.js"), { credentials: "same-origin", cache: "no-store", headers: { "X-GiftLab-Internal": "1", "Cache-Control": "no-cache" } });
      if (resp.ok) {
        var c = await resp.json();
        return typeof c.item_count === "number" ? c.item_count : null;
      }
    } catch (e) {}
    return null;
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

  function evaluateRulesLocally(rules, cart) {
    var matchedRules = [];
    rules.forEach(function (rule) {
      var conditions = rule.conditions || [];
      var match = false;
      if (conditions.length === 0) {
        match = true;
      } else {
        var matches = conditions.map(function (cond) {
          return matchCondition(cond, cart);
        });
        if (rule.matchMode === "ANY") {
          match = matches.some(Boolean);
        } else {
          match = matches.every(Boolean);
        }
      }
      if (match) {
        matchedRules.push(rule);
      }
    });

    var mutations = [];
    // Add missing gifts
    matchedRules.forEach(function (rule) {
      rule.gifts.forEach(function (gift) {
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
            properties: properties
          });
        }
      });
    });

    // Remove gifts that are no longer qualified
    cart.items.forEach(function (item) {
      if (item.properties && item.properties._free_gift_rule) {
        var ruleId = item.properties._free_gift_rule;
        var stillActive = matchedRules.some(function (r) { return r.id === ruleId; });
        if (!stillActive) {
          mutations.push({
            type: "CHANGE",
            lineKey: item.key || item.variant_id,
            quantity: 0
          });
        }
      }
    });

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
      var cart = await cartResponse.json();
      cachedCart = cart;
      console.log("GiftLab cart items count:", cart.items.length, "Subtotal:", cart.items_subtotal_price);
      
      // Try local evaluation first (instant)
      var localMutations = evaluateRulesLocally(cachedRules, cart);
      console.log("GiftLab local evaluation mutations result:", localMutations);
      
      if (localMutations.length > 0) {
        var success = true;
        var lastResult = null;
        for (var k = 0; k < localMutations.length; k += 1) {
          var r = await applyMutation(localMutations[k]);
          if (r) {
            lastResult = r;
          } else {
            success = false;
          }
        }
        if (success && lastResult) {
          if (lastResult.sections) {
            updateDOMWithSections(lastResult.sections);
          } else {
            await refreshCartSections();
          }
          toast(config.dataset.giftMessage || "A free gift has been added to your cart.");
          syncCartBadges(await fetchCartItemCount());
        }
        return;
      }

      // Fallback: Send cart to evaluation server for complex/mystery box validations
      console.log("GiftLab sending cart to evaluation server for fallback check...");
      var response = await fetch(getUrl("apps/giftlab/evaluate"), { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/json", "X-GiftLab-Internal": "1" }, body: JSON.stringify({ cart: cart, customer: customer(), country: config.dataset.country || undefined }) });
      if (!response.ok) {
        console.warn("GiftLab evaluate server returned error status:", response.status);
        return;
      }
      var result = await response.json();
      console.log("GiftLab evaluation server response:", result);
      
      if (!result.mutations || !result.mutations.length) {
        console.log("GiftLab: No mutations needed.");
        syncCartBadges(cart.item_count ?? 0);
        return;
      }
      if (result.signature === lastSignature) {
        console.log("GiftLab signature matches lastSignature. Skipping duplicate mutations.");
        return;
      }

      console.log("GiftLab processing server mutations of size:", result.mutations.length);
      var removals = result.mutations.filter(function (item) { return item.type === "CHANGE" && item.quantity === 0; });
      var changes = result.mutations.filter(function (item) { return !(item.type === "CHANGE" && item.quantity === 0); });

      var success = true;
      var lastResult = null;
      for (var i = 0; i < removals.length; i += 1) {
        var r = await applyMutation(removals[i]);
        if (r) {
          lastResult = r;
        } else {
          success = false;
        }
      }
      for (var j = 0; j < changes.length; j += 1) {
        var c = await applyMutation(changes[j]);
        if (c) {
          lastResult = c;
        } else {
          success = false;
        }
      }

      if (success) {
        lastSignature = result.signature;
      } else {
        lastSignature = ""; 
      }

      document.dispatchEvent(new CustomEvent("giftlab:cart-updated", { detail: result }));
      document.dispatchEvent(new CustomEvent("cart:refresh"));
      document.dispatchEvent(new CustomEvent("cart:updated", { detail: { cart: cart, source: "giftlab" } }));
      
      var message = (result.messages && result.messages[0]) || (result.matchedGiftRuleIds && result.matchedGiftRuleIds.length ? config.dataset.giftMessage : (result.matchedMysteryBoxIds && result.matchedMysteryBoxIds.length ? config.dataset.mysteryMessage : ""));
      var visibleChange = result.mutations.some(function (item) { return !item.silent; });
      if (visibleChange) {
        if (lastResult && lastResult.sections) {
          updateDOMWithSections(lastResult.sections);
        } else {
          await refreshCartSections();
        }
      }
      toast(message);
      syncCartBadges(await fetchCartItemCount());
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

  // Intercept window.fetch
  var originalFetch = window.fetch;
  window.fetch = function () {
    var args = arguments;
    var requestUrl = typeof args[0] === "string" ? args[0] : (args[0] && args[0].url) || "";
    var isInternal = (args[1] && args[1].headers && (args[1].headers["X-GiftLab-Internal"] || args[1].headers.get && args[1].headers.get("X-GiftLab-Internal"))) || requestUrl.indexOf("apps/giftlab") !== -1;

    console.log("GiftLab intercepted fetch. URL:", requestUrl, "isInternal:", isInternal);

    return originalFetch.apply(window, args).then(function (response) {
      if (!isInternal && isCartAction(requestUrl)) {
        if (response.ok) {
          console.log("GiftLab: External cart fetch succeeded. Triggering instant evaluate()...");
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
