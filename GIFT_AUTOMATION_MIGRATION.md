# GiftLab: cart-drawer gift bug fixes + Cart Transform migration

Status doc for handoff between AI sessions/models. Written mid-task because the
current session is approaching its context limit. Read this fully before
touching code — it explains what's already fixed & live, and what's still an
open, in-progress rewrite.

Store used for all live testing: `mrashail-2.myshopify.com` (dev store).
App: "mystery-box", org "Rashail" (client_id in `shopify.app.toml`).
Test product: "The Multi-location Snowboard" (variant `42595477389389`,
$729.95). Test gift: "The Collection Snowboard: Liquid" (variant
`42595477454925`). Test rule id `cmrw2wafi0002z98n7y2awrtl`, condition
`subtotal >= 50`.

## 1. Original bug reports (from the merchant)

1. Clicking the trash/delete icon on a cart line sometimes resulted in "A free
   gift has been added to your cart" instead of the item being removed — the
   gift silently reappeared right after being deleted.
2. After clicking "Add to cart", the toast said a gift was added, but the
   cart drawer only showed the one product — the gift line was invisible.
3. (Current, unresolved architecture concern) Even when correct, the gift
   shows up *after* a visible delay (multiple sequential network round trips)
   rather than in the exact same instant as the add/delete action. The
   merchant wants this reduced to **zero** perceptible delay and has
   authorized a full Cart Transform Function rewrite to achieve it (see §4).

## 2. Root causes found, and fixes already made + deployed

All of this is in `extensions/giftlab-cart/assets/giftlab-cart.js` (the theme
app extension's client-side cart script) plus, for the decline-tracking
piece, `app/lib/promotion-engine.server.ts` / `app/lib/promotions.types.ts` /
`app/routes/apps.giftlab.evaluate.tsx`.

### 2a. No concept of "shopper declined this gift" (already committed as `d37cdc0`, already live)

`evaluateRulesLocally()` (client) and `desiredGiftMutations()` (server,
`app/lib/promotion-engine.server.ts`) only ever asked "does the rule still
match, and is the gift line present?" — with zero memory of *why* it might be
absent. Since `evaluate()` fires on every single cart mutation (including the
shopper's own delete of the gift line), deleting the gift looked identical to
"never added," and it was instantly re-added.

**Fix:** a cart attribute `_giftlab_declined_gifts` (comma-separated rule ids)
tracks explicit shopper declines. Client-side, `evaluateRulesLocally(rules,
cart, previousCart)` diffs `previousCart` vs `cart` to detect "a still-
qualifying gift line just disappeared" and adds that rule id to the declined
set (persisted via a new `"ATTRIBUTES"` mutation type → `cart/update.js`).
The decline is cleared the moment the rule stops matching (so a later, fresh
qualification isn't treated as still-declined). Server-side
`desiredGiftMutations` reads the same attribute and skips re-adding declined
rules, with the identical stale-decline cleanup. This is **already committed**
(you'll see it in `git log` as commit `d37cdc0`) and was already live before
this session's live-testing began.

Also fixed in the same pass: the toast message ("A free gift has been added")
used to fire on *any* successful local mutation, including a pure removal —
now it only fires when an `ADD` mutation actually happened.

Relevant constant: `GIFTLAB_DECLINED_GIFTS_ATTRIBUTE` /
`DECLINED_GIFTS_ATTRIBUTE` = `"_giftlab_declined_gifts"` — **must stay
identical** in both `giftlab-cart.js` and `promotion-engine.server.ts`.

### 2b. `isCartSectionRender()` held the wrong fetch, so the drawer never repainted with the gift (fixed + deployed as `mystery-box-13`)

Verified live by reproducing the bug in a real browser: after "Add to cart",
`cart.js` correctly showed 2 items (gift + product) server-side, but the
**drawer DOM only ever showed 1 item** — the gift silently existed in the
cart but was never painted.

Root cause: the "render hold" mechanism (added in commit `322e921`, right
before this session) holds the *theme's own* cart-section-repaint fetch until
our gift-evaluation settles, so the theme paints the drawer once, gift
included, avoiding a double-paint/flicker. But `isCartSectionRender()` matched
*any* cart-ish URL with a `sections=`/`section_id=` param — including an
unrelated background fetch this theme makes to `/cart?section_id=main-cart-
items` (nothing to do with the drawer). Holding that unrelated fetch made
`finalizeRender()` wrongly believe "the theme will repaint the drawer for
me," so it skipped its own necessary `refreshCartSections()` call. Result:
nothing ever repainted the drawer with the gift.

**Fix:** `isCartSectionRender()` (around line 685) now requires the fetch's
`sections=`/`section_id=` value to actually mention `cart-drawer` or
`cart-icon-bubble` before holding it. Verified live: gift now appears in the
drawer immediately after add-to-cart.

### 2c. `cachedCart` was one cycle stale, breaking the decline detection from §2a (fixed + deployed as `mystery-box-14`)

Verified live: after §2b's fix, adding to cart correctly showed the gift, but
**deleting the gift line re-added it anyway** — the exact original bug,
still present after §2a's decline-tracking was live. Reproduced and traced:

`cachedCart` is only reassigned from a fresh `cart.js` fetch at the very
*start* of `runEvaluateCycle()`, before that cycle's own mutations are
applied. It's never updated again after those mutations land. Since
`cachedCart` becomes `previousCart` for the *next* cycle (the diff §2a's
decline-detection relies on), it stayed stale by exactly one cycle whenever
the previous cycle itself mutated the cart. Concretely: cycle 1 (add-to-cart)
adds the gift, but `cachedCart` still reflects the *pre-gift* snapshot taken
at the top of that cycle. Cycle 2 (shopper deletes the gift) then computes
`previousCart` = that stale pre-gift snapshot, so the diff sees "gift wasn't
there before, isn't there now" → no decline detected → the gift looks
"missing" in the ordinary sense → **gets re-added**.

**Fix:** `patchCachedCartForMutation(mutation)` (new function, right before
`preserveOpenState`) patches `cachedCart.items` / `cachedCart.attributes` in
place immediately after each successful mutation (ADD → push a synthetic
line; CHANGE quantity 0 → remove the line; CHANGE non-zero → update
quantity/properties; ATTRIBUTES → merge into `cachedCart.attributes`). Called
after every successful `applyMutation()` in both the local and server-
fallback branches of `runEvaluateCycle()`. Verified live end-to-end: add →
gift appears instantly; delete gift → stays deleted, no re-add, attribute
`_giftlab_declined_gifts` correctly persisted server-side (confirmed via
`fetch('/cart.js')`).

### 2d. Round-trip reduction (written, NOT yet committed/deployed)

Small, safe, zero-risk optimization: `cart/add.js` / `cart/change.js` /
`cart/update.js`, when called with a `sections=` param (which this app's own
`applyMutation()` always does), return the rendered section HTML **in the
same response** — but the code was discarding that and making a *separate*
`refreshCartSections()` fetch afterward to get the same data again. Now
`finalizeRender(didMutate, message, sectionsData)` takes an optional third
argument; both call sites in `runEvaluateCycle()` capture the last
successful mutation's `.sections` and pass it through, so `updateDOMWithSections()`
is called directly with data already in hand instead of an extra network
round trip. This cuts one full round trip off the visible delay, but **does
not** get you to zero — see §3.

**This is uncommitted and undeployed.** `git status --short` will show only
`extensions/giftlab-cart/assets/giftlab-cart.js` as modified. Before doing
anything else, either commit + deploy this (`npx shopify app deploy
--allow-updates`) or fold it into whatever the Cart Transform migration
produces.

## 3. Why the merchant is not satisfied yet, and what they've asked for

Even with 2a–2d, the current architecture is fundamentally: theme adds the
real product → our script *separately* detects the change (via a wrapped
`fetch`/XHR) → *separately* fetches `cart.js` to re-evaluate rules →
*separately* POSTs `cart/add.js` to add the gift → drawer repaints. That's
inherently 1–3 sequential network round trips *after* the theme's own add,
so however fast, there is always a visible "product appears, then a beat
later the gift appears" — never truly simultaneous.

The merchant explicitly rejected further patching of this client-side
approach and asked for the *real*, native Shopify mechanism, with **zero**
perceptible delay, and asked me to research Shopify's own recommended
approach rather than guess. They were extremely clear: test by deleting the
**product** (not just the gift) too, and confirm zero delay in both
directions before considering this done.

### Research finding (via `shopify-dev-mcp`, already done — do not redo)

Shopify's **Cart Transform Function** (`cart_transform_run` target,
`schema::Operation::LineExpand` in Rust) can "expand" an **existing** cart
line into itself plus one or more additional line items, each with its own
price adjustment (`FixedPricePerUnit`, likely also percentage — verify) —
computed natively by Shopify as part of *any* cart render (drawer, cart page,
checkout), with **zero client-side round trips**. This is the only mechanism
that gets to genuinely zero added latency, confirmed via Shopify's own docs
(searched via `mcp__shopify-dev-mcp__search_docs_chunks`, api
`functions_cart_transform` / `functions`).

Key capabilities/constraints confirmed from docs:

- Input query can access `cart.lines[].merchandise` (on `ProductVariant`:
  product title, tags via `hasAnyTag`/`hasTags`, collections via
  `inAnyCollection`, presumably vendor/productType — verify exact field
  names against the real schema), `cart.lines[].cost.amountPerQuantity`,
  `cart.buyerIdentity.customer` (confirmed available: `id`, `hasAnyTag(tags:
  [...])`, `isWholesale`), and `presentmentCurrencyRate`.
- Confirmed example: expanding a line based on a cart-line **attribute**
  (`attribute(key: "...")`) and based on **customer tag** via
  `buyerIdentity.customer.hasAnyTag`.
- Functions are **pure**: no network, no filesystem, no RNG, **no access to
  current date/time**. This matters because `GiftRule.startsAt`/`endsAt`
  (schedule windows) **cannot** be evaluated inside the function itself —
  only currently-active rules must be synced into whatever config the
  function reads, and that sync needs to happen from *outside* the function
  (an admin action, and ideally also a periodic/scheduled job so a schedule
  boundary crossing without any admin edit still takes effect — this is a
  real gap to design for, not yet solved).
- No RNG matters less here: this app's *mystery box* random-pick feature is a
  separate system from *free gift* rules and is out of scope for this
  migration (free-gift rules already pick gifts deterministically —
  `configured.slice(0, n)`, see `promotion-engine.server.ts`).

### Existing sync pattern to imitate (don't reinvent)

`app/lib/checkout-discount.server.ts` already has the precedent: every
`GiftRule` gets its own Shopify Discount instance created via
`discountAutomaticAppCreate` (Admin API), storing a small
`metafieldsSet` (namespace `$app:giftlab-checkout-discounts`, key
`signature-secret`) on the discount itself. `GiftRule.shopifyDiscountId`
(Prisma field) tracks it. Hooked into these existing admin routes — grep
`shopifyDiscountId` to find them all:

```
app/routes/app._index.tsx
app/routes/app.mystery-boxes.new.tsx
app/routes/app.mystery-boxes.$id.tsx
app/routes/app.rules._index.tsx
app/routes/app.gifts.$id.tsx
app/routes/app.gifts.new.tsx
app/routes/app.settings.tsx
```

**Important difference for Cart Transform:** the existing checkout Discount
function does *not* need a central rules metafield — it re-verifies whatever
gift line *already exists* in the cart using that line's own encoded
properties (`_free_gift_conditions` blob + `_promotion_signature`, see
`encodeConditionsForFunction()` in `promotion-engine.server.ts`). That
"self-describing line" trick doesn't work for Cart Transform, because Cart
Transform is what's responsible for **deciding whether to add the line in
the first place** — it has no pre-existing line to read conditions off of.
So Cart Transform genuinely needs real rule data as input. Likely design: a
**single shared JSON metafield** (shop-level, or on the one Cart Transform
instance — a shop can typically only have a small number of Cart Transform
instances registered, unlike Discounts which are one-per-rule) containing an
array of all currently-active gift rules, kept in sync from the same admin
routes listed above, in a shape the Rust function can parse.

## 4. Where the migration stands right now (incomplete)

Ran (already done, don't repeat):

```
npx shopify app generate extension --template cart_transform --flavor rust --name giftlab-gift-transform
```

This created `extensions/giftlab-gift-transform/` with the **default
unmodified template** — nothing has been customized yet:

```
extensions/giftlab-gift-transform/Cargo.toml
extensions/giftlab-gift-transform/schema.graphql
extensions/giftlab-gift-transform/shopify.extension.toml
extensions/giftlab-gift-transform/src/cart_transform_run.graphql   ← template stub, needs full rewrite
extensions/giftlab-gift-transform/src/cart_transform_run.rs        ← template stub, needs full rewrite
extensions/giftlab-gift-transform/src/main.rs
extensions/giftlab-gift-transform/tests/default.test.js
extensions/giftlab-gift-transform/tests/fixtures/no-operations.json
```

This directory is **untracked** (`git status` shows it as `??`). Nothing
about it has been deployed.

### Remaining work, in the order it makes sense to do it

1. **Design the metafield JSON schema** the function will read — needs, per
   rule: `id`, `matchMode`, `conditions[]` (field/operator/value — reuse the
   shape in `app/lib/promotions.types.ts`'s `RuleCondition`), `gifts[]`
   (variantId, quantity, discountType, discountValue — reuse `GiftChoice`),
   `stackable`, `priority`/conflict handling. Decide shop-level vs per-
   instance metafield placement (research Cart Transform instance limits per
   shop first — validate via `mcp__shopify-dev-mcp__validate_graphql_codeblocks`
   with `api: "functions_cart_transform"` before assuming field names).

2. **Write `src/cart_transform_run.graphql`** — needs: `cart.lines` (id,
   quantity, cost, merchandise variant id/product id/tags/vendor/
   productType), `cart.attributes` (to read `_giftlab_declined_gifts` — verify
   this field actually exists on the Cart Transform input schema; it might
   not, unlike Discount functions — check via introspection/validation tool
   before assuming), `cart.buyerIdentity.customer` (id, hasAnyTag, country if
   available), `cart.cost` (subtotal), and the metafield holding the rules
   config (likely `cartTransform.metafield(namespace:, key:)` mirroring the
   discount function's `discount.metafield` pattern — check the loaded
   `functions` system instructions from `learn_shopify_api` earlier in this
   conversation for the exact metafield-access pattern used elsewhere in this
   codebase, e.g. `extensions/giftlab-discounts/src/cart_lines_discounts_generate_run.graphql`
   is a working, deployed example to copy the metafield-reading style from).

3. **Port condition matching to Rust** — mirror `conditionMatches()` /
   `matchCondition()` from `app/lib/promotion-engine.server.ts` (fields:
   subtotal, quantity, distinct_products, product, variant, sku, product_tag,
   vendor, product_type, collection, customer_tag, customer_logged_in,
   country, discount_code — note `UNVERIFIABLE_CONDITION_FIELDS` in that file
   already documents which of these the *existing* checkout function can't
   verify due to Shopify Function input query cost caps; re-check each one
   against Cart Transform's own cost budget rather than assuming the same
   list applies verbatim — Cart Transform's confirmed `buyerIdentity.customer
   .hasAnyTag` access suggests customer_tag may actually be verifiable here
   even though it isn't in the discount function).

4. **Pick a "carrier" line per matching rule** and emit
   `Operation::LineExpand` with `expanded_cart_items` = `[original item
   unchanged, gift item(s) with price adjustment]`. For `subtotal`/
   `quantity`-style rules not tied to one specific product, a reasonable
   choice is the cart's first non-gift line (document whichever choice is
   made, since it's a real design decision, not an obvious default).

5. **Respect `_giftlab_declined_gifts`** the same way the client/server do
   today — skip expanding for a rule id present in the (however this ends up
   being exposed to the function) declined set.

6. **Handle the schedule-window gap** from §3 — at minimum, sync on every
   admin save (reuse the hook points in §3's file list); flag to the
   merchant that a schedule boundary with *no* admin edit around it won't
   flip until something else triggers a resync (or build a scheduled task —
   see the `schedule` skill / `mcp__scheduled-tasks__*` tools available in
   this environment — to force a periodic resync).

7. **Reconcile with the existing checkout Discount function**
   (`extensions/giftlab-discounts`) — once Cart Transform sets the gift's
   price directly via `ExpandedItemPriceAdjustment`, decide whether the
   checkout function still needs to re-discount that same line (risk of
   double-discount) or should skip lines it detects were added by Cart
   Transform (e.g. tag the expanded item with a distinguishing property/
   attribute it can check for).

8. **Retire the client-side gift-adding path** in `giftlab-cart.js` for any
   rule now handled by Cart Transform (to avoid **both** systems adding the
   gift and ending up with two lines) — likely keep the file for whatever
   isn't migrated (mystery box picks are explicitly out of scope, see §3) and
   for the checkout-interception logic, but remove/guard the free-gift
   `evaluateRulesLocally` add-path once Cart Transform covers it.

9. **Register the Cart Transform instance** via Admin API
   (`cartTransformCreate` mutation — mirror `createPromotionDiscount()` in
   `app/lib/checkout-discount.server.ts` for the calling pattern), likely
   once per shop (not per rule, unlike discounts — verify the actual
   per-shop limit first).

10. **Test locally** before touching the live store:
    `cd extensions/giftlab-gift-transform && shopify app function build`,
    then `shopify app function run --input=<sample>.json --export=cart_transform_run`
    with hand-written sample input JSON covering: no matching rule (expect
    `{"operations":[]}`), one matching subtotal rule, a declined rule that
    still matches (expect no expand), a rule whose window/attribute cleanup
    needs to fire.

11. **Deploy** (`npx shopify app deploy --allow-updates --message "..."`,
    same pattern used throughout this session) and **re-verify live** on
    `mrashail-2.myshopify.com` with the browser tool (`mcp__Claude_Browser__*`
    — already used extensively this session, see §5 for the exact recipe):
    clear cart → add the trigger product → **the gift must already be in the
    very first drawer paint, no separate pop-in** → delete the **product**
    (not the gift) → gift must vanish in the same instant, cart must not
    show a stale/blank state at any point → re-add the product → gift
    reappears instantly, fresh (not still "declined").

## 5. How to test live on the store (recipe used throughout this session)

```
# Open the browser tool on the product page
mcp__Claude_Browser__preview_start { url: "https://mrashail-2.myshopify.com/products/the-multi-location-snowboard" }

# Clear the cart via JS before every test run, to start clean:
mcp__Claude_Browser__javascript_tool { action: "javascript_exec", text: "fetch('/cart/clear.js', {method:'POST', headers:{'Content-Type':'application/json'}}).then(r=>r.json()).then(c=>JSON.stringify({item_count:c.item_count}))" }

# Reload to pick up the latest deployed asset (extension version auto-updates on this dev store):
mcp__Claude_Browser__navigate { url: "...", force: true }

# Confirm which deployed version is actually being served (bump number should match your latest `shopify app deploy` release):
mcp__Claude_Browser__javascript_tool { action: "javascript_exec", text: "Array.from(document.querySelectorAll('script[src*=\"giftlab-cart\"]')).map(s=>s.src)" }

# Click Add to cart (use read_page filter:interactive to get the ref, then computer left_click)
# Screenshot immediately after — the gift MUST already be in the drawer, no delay/second paint.

# Inspect real server-side cart state at any point:
mcp__Claude_Browser__javascript_tool { action: "javascript_exec", text: "fetch('/cart.js').then(r=>r.json()).then(c=>JSON.stringify({item_count:c.item_count, items:c.items.map(i=>({title:i.title,qty:i.quantity})), attributes:c.attributes}))" }
```

The merchant communicates in Roman Urdu/English mixed — respond in kind,
keep it concise, and **always verify claims live in the browser rather than
reasoning from screenshots or assumptions** — every real bug found this
session (§2a–2c) was only actually understood by reproducing it live and
reading real console/network logs, not by reading the source alone.

## 6. Explicit standing instructions from the merchant

- No half-measures / no more incremental patches on the client-side
  approach — they want the real Shopify-native mechanism, however large the
  rewrite.
- Zero tolerance for perceptible delay (their words: "1 second ka bhi delay
  nahi") in either direction (add → gift appears; delete the *product* →
  gift disappears), verified by live testing, not just described.
- They've already granted blanket permission to proceed without asking for
  confirmation on each step ("all permissions, aapko pouchne ki zaroorat
  nahi") — this was said in-session and applies to this specific piece of
  work; still use judgment on genuinely destructive/irreversible actions
  (e.g. don't drop the Discounts function or delete existing rules without
  clear reason).
