# GiftLab — Shopify Free Gifts & Mystery Boxes

GiftLab is an embedded Shopify app for automatic free gifts, inventory-aware mystery boxes, BOGO rewards, and progressive quantity pricing. Merchants configure promotions in Shopify Admin; storefront behavior is delivered through a Theme App Extension, so theme source files are never edited.

## Included

- Unlimited free-gift rules with AND/OR cart, catalog, customer, market, quantity, and discount-code conditions
- Priorities, stacking controls, schedules, customer restrictions, automatic add/remove, and per-order limits
- Unlimited mystery boxes with manual product/variant pools and automatic variant-title/SKU matching
- Random, weighted, sequential, round-robin, highest-inventory, and lowest-inventory selection
- Stable cart selections, inventory fallbacks, multiple child selections, and duplicate controls
- Same-box and different-box BOGO pools
- Progressive percentage-off, fixed-amount-off, and final-unit-price tiers
- HMAC-signed cart markers and a native Rust Shopify Discount Function for checkout-safe pricing
- Product/inventory/order webhooks, catalog sync, usage tracking, and mandatory privacy webhooks

## Local development

Requirements: Node.js 20.19+ or 22.12+, Shopify CLI, Rust, and the `wasm32-unknown-unknown` Rust target.

```bash
npm install
rustup target add wasm32-unknown-unknown
npm run setup
npm run dev
```

The default `shopify.app.toml` deliberately avoids protected customer-data
scopes so a new development app can be installed immediately. Customer tags,
login status, and first-purchase checks are supplied by the storefront theme
extension and continue to work without Admin customer access.

Exact cross-order "one gift per customer" accounting uses the `orders/create`
webhook. After enabling Protected Customer Data access for the app in Shopify,
run the protected configuration instead:

```bash
shopify app dev --config protected
```

`npm run setup` creates the local SQLite file when needed, generates Prisma Client, and applies all migrations.

## Merchant launch checklist

1. Open **Settings** and run **Sync catalog now**.
2. Deploy the app extensions, then click **Activate checkout discount**.
3. Enable **GiftLab Cart Engine** under Shopify Admin → Online Store → Themes → Customize → App embeds.
4. Create a disabled test promotion, verify its cart and checkout behavior, then enable it.

## Verification

```bash
npm run typecheck
npm run lint
npm run build
cargo test --manifest-path extensions/giftlab-discounts/Cargo.toml
shopify app build
```

## Deployment notes

- Replace the placeholder application and redirect URLs through Shopify CLI linking/deployment.
- The default SQLite database is appropriate for local development or a single persistent application instance. Use a managed relational database before horizontal scaling.
- Run `npm run setup` in the release phase so migrations are applied before the web process starts.
- Configuration changes, webhooks, the Theme App Extension, and the Discount Function become active after `shopify app deploy`.
