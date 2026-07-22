(function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // GiftLab storefront script — NATIVE Cart Transform mode.
  //
  // Free gifts are now added, priced ($0), grouped, and removed entirely by the
  // GiftLab Cart Transform Function (extension "giftlab-gift-transform") on
  // Shopify's own backend, as part of every cart render (drawer, cart page and
  // checkout). That is the only mechanism that reaches the shopper with zero
  // added latency and without ever fighting the theme's own cart rendering.
  //
  // Because of that, this client script deliberately does NOTHING to the cart:
  //   • it never adds or removes a gift line,
  //   • it never intercepts /cart/add, /cart/change or /cart/update,
  //   • it never re-renders the drawer or touches the cart badge.
  //
  // Every one of those responsibilities used to live here and was the direct
  // cause of the delete-re-adds-the-gift, gift-appears-then-vanishes, and
  // stuck-cart-badge bugs: the client and the Cart Transform Function were both
  // trying to own the gift line and stomped on each other. The theme alone owns
  // the cart UI now, and the Cart Transform Function alone owns the gift — no
  // overlap, so there is nothing left here to conflict with either of them.
  //
  // The block still renders a hidden #giftlab-cart-engine config element and a
  // #giftlab-rules-data script; both are harmless and kept only so the theme
  // editor block and any future non-cart features have somewhere to read
  // config from. This file is intentionally inert.
  // ---------------------------------------------------------------------------

  var config = document.getElementById("giftlab-cart-engine");
  if (!config) return;
  if (config.dataset.giftlabLoaded === "true") return;
  config.dataset.giftlabLoaded = "true";

  console.log(
    "GiftLab: native Cart Transform mode — free gifts are handled server-side; this client script is intentionally inert."
  );
})();
