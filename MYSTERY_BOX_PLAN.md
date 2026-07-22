# Mystery Box — native rewrite plan (storefront)

Companion to GIFT_AUTOMATION_MIGRATION.md. Free-gift is done (real-line +
checkout Discount Function + Cart Transform safety net). This plan brings the
Mystery Box feature to the same native quality. Written for handoff — any
session/model can execute from here.

Deploy reality (critical): the app SERVER runs on Ploi, which deploys from the
`Perfection-PK/mystery-box` repo, branch **`master`**. The GitHub `origin`
(`mrashail/mystry-box`, branch `main`) is NOT what Ploi uses. Always push server
changes to BOTH: `git push origin main && git push perfection main:master`.
Shopify extensions (functions, theme block) deploy via `npx shopify app deploy
--allow-updates`. Both are needed; server logic (sync, routes, engine) is Ploi,
extensions are Shopify.

## Already done (admin side, committed ef055eb, on master)

- Standard box requires `boxPrice > 0` to save (validation). BOGO exempt.
- Shopify automatic discount is created ONLY when the box is BOGO or has price
  tiers (a plain priced box makes no Discounts-page entry); editing a box that
  loses its tiers/BOGO removes the stale discount.
- Save (new/edit) stays on the box's own edit page.
- Delete already removes the Shopify discount + shadow product (pre-existing).

## Headline problem (the big remaining work)

The Mystery Box SERVER engine is fully built but ORPHANED from the storefront.
`app/lib/promotion-engine.server.ts` has `mysteryMutations()` / `pickChildren()`
/ `evaluateCart()` — the whole hidden-pick + in-place reconcile machinery — but
the storefront client (`extensions/giftlab-cart/assets/giftlab-cart.js`) NEVER
POSTs the cart to the `apps/giftlab/evaluate` action, so none of it runs live.
Today, adding a mystery box just adds the shadow product as a plain line with NO
hidden pick attached. (When free gifts moved to the client-only real-line path,
the server round-trip that used to drive mystery was removed — commits b611794 /
204c409 / df900d5. The "slower server round-trip" comment in giftlab-cart.js
runEvaluateCycle is now stale.)

## How mystery box is meant to work (native target)

The shopper adds a "Mystery Box" shadow product (a real product; STANDARD boxes
set `parentProductId == boxProductId`, price `boxPrice`). It shows in the drawer
natively (it's a real line — no Cart-Transform-in-drawer problem like gifts had).
What must happen natively:

1. A RANDOM child variant is rolled server-side and recorded (hidden) on the box
   line as `_mystery_selection` (+ `_mystery_contents` label), so fulfillment
   knows what to ship. The shopper still just sees the generic box.
2. Roll is random each add, DIFFERENT across re-adds (MysterySelection row is
   deleted when the box leaves the cart, so a re-add re-rolls) and avoids
   variants the customer was already shipped (MysteryCustomerHistory →
   `excludeVariantIds` in pickChildren). This logic already exists in
   pickChildren/mysteryMutations — it just needs to be reachable from the cart.
3. Progressive price tiers: the box line carries signed `_mystery_price_type/
   _value/_pricing_box/_trigger_*` props; the checkout Discount Function
   (extensions/giftlab-discounts/src/run.rs:312-351) applies the best tier.
4. Deleting the box from the cart removes it (native, single real line). For
   BOGO, deleting the trigger must also remove the bonus reward line.

## Data model (prisma/schema.prisma)

- `MysteryBox` (79-118): parentProductId/VariantId (STANDARD: == box shadow;
  BOGO: real trigger), selectionMethod (RANDOM/WEIGHTED/SEQUENTIAL/ROUND_ROBIN/
  HIGHEST_INVENTORY/LOWEST_INVENTORY), inventoryBehavior, selectionCount,
  allowDuplicateChoices, matchingRules, priceTiers, bogo, restrictions,
  startsAt/endsAt, cursor, boxProductId/VariantId/boxPrice/boxImageUrl,
  shopifyDiscountId. children: MysteryBoxChild[].
- `MysteryBoxChild` (120-139): productId/variantId/title/sku/imageUrl/
  inventoryQuantity/available/weight/position.
- `MysterySelection` (186-201): per-cart-line roll — shop, mysteryBoxId,
  cartToken, parentLineKey, selectedVariants(Json), selectionQuantity, status
  (CART), orderId. `@@unique([shop, cartToken, parentLineKey, mysteryBoxId])`.
- `MysteryCustomerHistory` (203-218): shipped variants per customer, written by
  the orders/create webhook (app/routes/webhooks.orders-create.tsx:47-100).
- `PromotionUsage` (168-184): onePerCustomer gating.

Key engine fns: `pickChildren` (promotion-engine.server.ts:464), `chooseWeighted`
(451), `priceTierForQuantity` (535), `mysteryMutations` (551), `evaluateCart`
(936). Checkout: extensions/giftlab-discounts/src/run.rs:280-351 (BOGO zero +
tiers).

## Plan — storefront wiring (do in this order)

### Step 1: expose mystery boxes to the client (synchronously)
Mirror the gift `rules-config` metafield. Add a shop metafield (e.g.
`$app:giftlab-gift-transform/mystery-config`, or extend the block) synced from a
new `syncMysteryBoxConfig(admin, shop)` in app/lib/cart-transform.server.ts (or
a sibling), carrying per active box: id, parentProductId, parentVariantId,
boxVariantId, isBogo, hasPriceTiers, restrictions, notification. The block
(extensions/giftlab-cart/blocks/cart-engine.liquid) renders it into a
`#giftlab-mystery-data` script via `| json` (same fix as gift rules — raw
`.value` renders Ruby-hash and JSON.parse fails). Call this sync from the same
admin save/toggle/delete points that call syncCartTransformRules
(app.mystery-boxes.new/$id, app.rules._index).

Purpose: the client can cheaply tell "does this cart contain a mystery box
parent line?" WITHOUT a server round-trip, so free-gift-only carts stay fast.

### Step 2: attach the hidden pick via a SILENT server call
Randomness + inventory + history + MysterySelection persistence are server-only,
so the pick must come from the server — but it's a SILENT property update on a
line the shopper already sees, so there is no flash.

- In giftlab-cart.js runEvaluateCycle, after the free-gift local pass, if the
  cart contains any mystery box parent line that is missing `_mystery_selection`
  (or whose parent quantity changed), POST the cart to a mystery endpoint.
- Best: a dedicated action that runs ONLY mysteryMutations (not gifts) to avoid
  re-emitting gift mutations the client already owns. Either a new route
  (app/routes/apps.giftlab.mystery.tsx) or a `?only=mystery` flag on the
  existing evaluate action that filters evaluateCart's output to mystery lines.
- Apply the returned mutations with the existing applyMutation (CHANGE with
  properties on the same line = silent; the box stays put, now carrying
  `_mystery_selection`/`_mystery_contents` and, if tiered, the signed price
  props). Use `patchCachedCartForMutation` + the sections in the response so the
  drawer repaints once.
- Do NOT batch mystery into the /cart/add request the way gifts are batched —
  the shadow product is what the shopper added, so it's already the first paint;
  only the hidden props need attaching afterward (silent, no visible change).

### Step 3: combined-remove for BOGO bonus lines
In the giftlab-cart.js /cart/change interceptor, extend the free-gift branch so
that removing a mystery trigger/box line also zeroes any line tagged
`_mystery_box_reward` / `_mystery_box_id` belonging to it, in the same
/cart/update.js request (mirror the gift combined-remove, including forwarding
the theme's `sections` from the body). STANDARD boxes are a single line so
native delete already works; this is for BOGO bonus lines.

### Step 4: price-tier display + checkout
Tiers already work at checkout via the Discount Function once the box line
carries the signed props (attached in Step 2). Confirm the drawer shows the
tiered price (line discount reflects like the gift $0 did). If a plain box (no
tiers) — no discount, shopper pays boxPrice; nothing to do.

### Step 5: cursor persistence for SEQUENTIAL/ROUND_ROBIN
mysteryMutations advances `box.cursor` server-side when it rolls — since Step 2
routes through the server engine, this keeps working. Verify no double-advance
on repeated silent calls (mysteryMutations only re-rolls when shouldReselect).

## Testing (live, on mrashail-2.myshopify.com)

Prereq: create a mystery box in the app admin with 4-5 children, RANDOM,
boxPrice > 0, no tiers first. Deploy Ploi (master) + shopify app deploy, then:
- Add box → drawer shows ONLY the box (no flash), one line, priced boxPrice.
- Inspect /cart.js: the box line has `_mystery_selection` (a child variant id)
  and `_mystery_contents`. Remove + re-add → a DIFFERENT `_mystery_selection`.
- Delete box → cart empty, badge 0 (single real line, native).
- Then add price tiers → box line gains signed price props; checkout shows the
  tiered price. And confirm a plain box created NO Discounts-page entry.
- Verify each admin toggle (schedule, customer tags, first-purchase, one-per-*,
  selection method, inventory behavior, allow-repeated-child) actually affects
  the pick/eligibility — port the same client-side honoring done for gifts
  (computeEffectiveRules-style) if the pick is decided client-side; since the
  pick is server-side (Step 2), evaluateCart already honors most of these, so
  mainly confirm the sync passes them through.

## Watch-outs (do not regress the working free-gift path)

- The client mystery round-trip must be gated to carts that actually contain a
  mystery box (Step 1 data), so free-gift-only carts keep zero round-trips.
- Do not let the mystery server call re-emit or undo free-gift lines (use a
  mystery-only endpoint/filter).
- Keep `_promotion_signature` payloads byte-identical between what the server
  signs and what run.rs reconstructs (mystery price + BOGO), or checkout won't
  discount.
