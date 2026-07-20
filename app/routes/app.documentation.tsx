export default function Documentation() {
  return (
    <s-page heading="App Documentation">
      <div className="page-intro mystery-intro">
        <div>
          <span className="eyebrow" style={{ color: "#7a589e" }}>USER GUIDE &amp; DOCUMENTATION</span>
          <h2>Master your promotional campaigns.</h2>
          <p>
            Learn how to set up automatic gifts, mystery boxes, and progressive pricing to boost conversions and average order value.
          </p>
        </div>
      </div>

      <s-section id="getting-started" heading="Getting Started">
        <s-stack direction="inline" gap="small-300" alignItems="center">
          <s-icon type="book-open" tone="auto"></s-icon>
        </s-stack>
        <s-paragraph color="subdued">
          Welcome to the Free Gift &amp; Mystery Box App! This application allows you to create and run automated cart promotions without editing a single line of liquid code.
        </s-paragraph>
        <s-heading>How Promotions Work</s-heading>
        <s-paragraph color="subdued">
          The app embeds a lightweight storefront engine into your theme. When shoppers add or remove items, the engine instantly evaluates your active rules. If qualifying conditions are met, it signs the cart with a secure token and adds the reward. The Shopify checkout discount function validates the token and applies the discount, protecting your shop from exploitation.
        </s-paragraph>
        <s-heading>Key Terminology</s-heading>
        <s-unordered-list>
          <s-list-item>
            <strong>Trigger Product (Parent):</strong> The product a customer must add to their cart to trigger the promotion.
          </s-list-item>
          <s-list-item>
            <strong>Child/Gift Product:</strong> The reward product that is automatically added to the customer's cart.
          </s-list-item>
          <s-list-item>
            <strong>Rule Priority:</strong> Determines which rule runs first if multiple promotions are active. Lower numbers execute first.
          </s-list-item>
        </s-unordered-list>
      </s-section>

      <s-section id="free-gift" heading="Creating a Free Gift Rule">
        <s-icon type="gift-card" tone="auto"></s-icon>
        <s-paragraph color="subdued">
          Award automatic free products when carts meet specific requirements.
        </s-paragraph>
        <s-ordered-list>
          <s-list-item>
            Click <strong>Create rule</strong> on the Rules page and choose <strong>Free Gift Rule</strong>.
          </s-list-item>
          <s-list-item>Name your rule (e.g., "Free Socks on Orders over $100").</s-list-item>
          <s-list-item>
            Under <strong>Eligibility conditions</strong>, select matching rules (AND/OR). You can restrict by subtotal, quantity, collections, tags, customer login, country, SKU, and discount codes.
          </s-list-item>
          <s-list-item>Select the free gift product(s) and set their reward quantities.</s-list-item>
          <s-list-item>
            Set priority and options like "Allow multiple gifts", "Stack rules", or "One per customer".
          </s-list-item>
          <s-list-item>
            Set starting/ending dates, ensure the rule is <strong>Enabled</strong>, and click <strong>Save</strong>.
          </s-list-item>
        </s-ordered-list>
      </s-section>

      <s-section id="mystery-box" heading="Creating a Mystery Box Rule">
        <s-icon type="package" tone="auto"></s-icon>
        <s-paragraph color="subdued">
          Sell surprise boxes that dynamically pack hidden items from your catalog.
        </s-paragraph>
        <s-heading>Automatic Parent Product Creation</s-heading>
        <s-paragraph color="subdued">
          You do <strong>not</strong> need to manually create a parent product. When you save a Mystery Box rule, the app automatically creates a parent product on Shopify representing the Mystery Box.
        </s-paragraph>
        <s-heading>Only One Storefront Variant</s-heading>
        <s-paragraph color="subdued">
          The parent Mystery Box product always has a single "Default Title" variant, no matter how many products are in the pool (2 or 20 — it makes no difference). Your pool items are never turned into a variant picker: if they were, shoppers could see and choose the real product names before checkout, which defeats the whole point of a mystery box.
        </s-paragraph>
        <s-heading>Automatic Selection &amp; Hiding</s-heading>
        <s-paragraph color="subdued">
          When a shopper adds the Mystery Box to their cart, the app's engine picks one (or however many you configured under "Items selected per box") product from the pool according to your selection method (Completely random, Weighted random, Sequential, etc.) and records it using hidden cart properties. The shopper only ever sees the Mystery Box's own name, image, and price — in the cart and at checkout — never the real item that was picked; that stays visible to you as the merchant only, on the order.
        </s-paragraph>
      </s-section>

      <s-section id="inventory-handling" heading="Inventory Handling">
        <s-icon type="check-circle" tone="success"></s-icon>
        <s-paragraph color="subdued">
          Configure how the selection engine reacts when child items run out of stock:
        </s-paragraph>
        <s-unordered-list>
          <s-list-item>
            <strong>Only use in-stock products:</strong> Candidate variants must be active and have positive stock inventory.
          </s-list-item>
          <s-list-item>
            <strong>Skip unavailable:</strong> Unavailable variants are filtered out completely before rolling selection.
          </s-list-item>
          <s-list-item>
            <strong>Select next available:</strong> If a selected variant has no stock, it falls back to the next variant in position order.
          </s-list-item>
          <s-list-item>
            <strong>Ignore inventory:</strong> Always adds the item regardless of inventory levels.
          </s-list-item>
        </s-unordered-list>
      </s-section>

      <s-section id="scheduling-restrictions" heading="Scheduling &amp; Restrictions">
        <s-icon type="settings" tone="auto"></s-icon>
        <s-paragraph color="subdued">Control when rules are active and who receives rewards.</s-paragraph>
        <s-heading>Scheduling</s-heading>
        <s-paragraph color="subdued">
          Set starting and ending datetimes. Carts will only qualify within the window. Make sure your local timezone matches your Shopify store settings.
        </s-paragraph>
        <s-heading>Customer Restrictions</s-heading>
        <s-paragraph color="subdued">Limit rewards using:</s-paragraph>
        <s-unordered-list>
          <s-list-item>One gift per customer (tracked via order history).</s-list-item>
          <s-list-item>First purchase only (for acquisition campaigns).</s-list-item>
          <s-list-item>Customer tag restrictions (allow only VIPs, or exclude wholesale).</s-list-item>
        </s-unordered-list>
      </s-section>

      <s-section id="faq" heading="Frequently Asked Questions">
        <s-stack direction="block" gap="base">
          <s-stack direction="block" gap="small-100">
            <s-text type="strong">Q: Why are gifts not appearing in the cart?</s-text>
            <s-paragraph color="subdued">
              A: Make sure the <strong>storefront automation is enabled</strong> in Settings, the checkout discount automatic app is active, and you have enabled the Theme App Embed in your Shopify Theme Editor.
            </s-paragraph>
          </s-stack>
          <s-divider></s-divider>
          <s-stack direction="block" gap="small-100">
            <s-text type="strong">Q: Can I run multiple promotions at the same time?</s-text>
            <s-paragraph color="subdued">
              A: Yes. Multiple active rules are evaluated sequentially based on their Priority values. Enable <strong>Stack rules</strong> in the settings to combine rewards, or restrict conflict strategy to First Match in settings.
            </s-paragraph>
          </s-stack>
          <s-divider></s-divider>
          <s-stack direction="block" gap="small-100">
            <s-text type="strong">Q: How are child product items packed for shipping?</s-text>
            <s-paragraph color="subdued">
              A: The selection details are written to the order's line item properties (e.g. <code>_mystery_selection</code>) when the customer checks out. Your fulfillment team or 3PL can read these properties to pack the appropriate items.
            </s-paragraph>
          </s-stack>
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="Documentation Index">
        <s-stack direction="block" gap="base">
          <s-link href="#getting-started">Getting Started</s-link>
          <s-link href="#free-gift">Creating a Free Gift Rule</s-link>
          <s-link href="#mystery-box">Creating a Mystery Box Rule</s-link>
          <s-link href="#inventory-handling">Inventory Handling</s-link>
          <s-link href="#scheduling-restrictions">Scheduling &amp; Restrictions</s-link>
          <s-link href="#faq">FAQs</s-link>
        </s-stack>
        <s-button href="/app/rules" variant="primary">
          Go to Rules Center
        </s-button>
      </s-section>
    </s-page>
  );
}
