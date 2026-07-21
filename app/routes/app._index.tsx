import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, useNavigate } from "react-router";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { GiftIcon } from "../components/Icons";
import { MetricTile } from "../components/MetricTile";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const now = new Date();
  const [giftRules, boxes, selections, catalog, settings] = await Promise.all([
    prisma.giftRule.findMany({
      where: { shop: session.shop },
      orderBy: { createdAt: "desc" },
    }),
    prisma.mysteryBox.findMany({
      where: { shop: session.shop },
      orderBy: { createdAt: "desc" },
    }),
    prisma.mysterySelection.count({ where: { shop: session.shop } }),
    prisma.catalogVariant.count({ where: { shop: session.shop } }),
    prisma.shopSettings.upsert({
      where: { shop: session.shop },
      update: {},
      create: { shop: session.shop },
    }),
  ]);

  // Each enabled rule/box carries its own Shopify discount id, created
  // automatically when it's turned on — no single shop-wide toggle anymore.
  const missingDiscounts =
    giftRules.filter((rule) => rule.enabled && !rule.shopifyDiscountId).length +
    boxes.filter((box) => box.enabled && !box.shopifyDiscountId).length;

  const active = (item: { enabled: boolean; startsAt: Date | null; endsAt: Date | null }) =>
    item.enabled && (!item.startsAt || item.startsAt <= now) && (!item.endsAt || item.endsAt >= now);

  const activeGifts = giftRules.filter(active).length;
  const activeBoxes = boxes.filter(active).length;

  const totalActive = activeGifts + activeBoxes;
  const totalDisabled = (giftRules.length - activeGifts) + (boxes.length - activeBoxes);

  const freeGiftRulesCount = giftRules.length;
  const mysteryBoxRulesCount = boxes.length;

  // Combine rules for recently created list
  const allRulesCombined = [
    ...giftRules.map((r) => ({
      id: r.id,
      name: r.name,
      type: "Free Gift" as const,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      editUrl: `/app/gifts/${r.id}`,
    })),
    ...boxes.map((b) => ({
      id: b.id,
      name: b.name,
      type: "Mystery Box" as const,
      createdAt: b.createdAt,
      updatedAt: b.updatedAt,
      editUrl: `/app/mystery-boxes/${b.id}`,
    })),
  ];

  const recentlyCreated = [...allRulesCombined]
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, 4);

  return {
    totalActive,
    totalDisabled,
    freeGiftRulesCount,
    mysteryBoxRulesCount,
    selections,
    catalog,
    storefrontEnabled: settings.storefrontEnabled,
    missingDiscounts,
    recentlyCreated,
  };
}

export default function Dashboard() {
  const data = useLoaderData<typeof loader>();
  const navigate = useNavigate();

  return (
    <s-page heading="Mystery Box dashboard">
      <s-button slot="primary-action" variant="primary" icon="gift-card" accessibilityLabel="Create free gift" onClick={() => navigate("/app/gifts/new")}>
        Create free gift
      </s-button>
      <s-button slot="secondary-actions" icon="package" accessibilityLabel="Create mystery box" onClick={() => navigate("/app/mystery-boxes/new?type=STANDARD")}>
        Create mystery box
      </s-button>

      <s-stack direction="block" gap="base">
        <div className="dashboard-hero">
          <div>
            <span className="eyebrow">FREE GIFTS + MYSTERY BOXES</span>
            <h1>Turn every cart into a small moment of delight.</h1>
            <p>
              Run sophisticated promotions without editing theme code. Priority-safe, inventory-aware, and designed for real Shopify carts.
            </p>
          </div>
          <div className="hero-visual">
            <GiftIcon style={{ width: 96, height: 96, color: "#fff", opacity: 0.92 }} />
            <i className="orb one" />
            <i className="orb two" />
          </div>
        </div>

        {!data.storefrontEnabled && (
          <s-banner tone="warning" heading="Storefront automation is paused">
            <s-paragraph>
              Enable it in Settings when you are ready. <s-link href="/app/settings">Open settings</s-link>
            </s-paragraph>
          </s-banner>
        )}

        {data.missingDiscounts > 0 && (
          <s-banner
            tone="critical"
            heading={`${data.missingDiscounts} active rule${data.missingDiscounts === 1 ? "" : "s"} missing its checkout discount`}
          >
            <s-paragraph>
              It won&apos;t apply at checkout until this is fixed. <s-link href="/app/settings">Fix now in Settings</s-link>
            </s-paragraph>
          </s-banner>
        )}

        <s-section heading="Quick actions">
          <s-stack direction="inline" gap="large" alignItems="center">
            <s-link href="/app/gifts/new">
              <s-stack direction="inline" gap="small-200" alignItems="center">
                <s-icon type="gift-card" size="small"></s-icon>
                <s-text>Create Free Gift</s-text>
              </s-stack>
            </s-link>
            <s-link href="/app/mystery-boxes/new?type=STANDARD">
              <s-stack direction="inline" gap="small-200" alignItems="center">
                <s-icon type="package" size="small"></s-icon>
                <s-text>Create Mystery Box</s-text>
              </s-stack>
            </s-link>
            <s-link href="/app/rules">View all rules →</s-link>
          </s-stack>
        </s-section>

        <s-section padding="base">
          <s-grid gridTemplateColumns="1fr auto 1fr auto 1fr auto 1fr" gap="large" alignItems="center">
            <MetricTile
              icon="check-circle"
              tone="success"
              value={data.totalActive}
              label="Active rules"
              detail={`${data.totalDisabled} disabled`}
            />
            <s-divider direction="block"></s-divider>
            <MetricTile
              icon="gift-card"
              tone="info"
              value={data.freeGiftRulesCount}
              label="Free Gift rules"
            />
            <s-divider direction="block"></s-divider>
            <MetricTile
              icon="product"
              tone="info"
              value={data.mysteryBoxRulesCount}
              label="Mystery Box rules"
            />
            <s-divider direction="block"></s-divider>
            <MetricTile
              icon="inventory"
              tone="info"
              value={data.catalog}
              label="Synced variants"
              detail={`${data.selections} selections`}
            />
          </s-grid>
        </s-section>

        <s-grid gridTemplateColumns="1.4fr 1fr" gap="base" alignItems="start">
          <s-section heading="Quick actions & rules">
            <s-stack direction="block" gap="base">
              <s-paragraph color="subdued">Everything needed to build your campaign.</s-paragraph>
              <s-stack direction="block" gap="none">
                <s-clickable href="/app/rules" padding="base" borderRadius="base">
                  <s-grid gridTemplateColumns="40px 1fr auto" gap="base" alignItems="center">
                    <s-icon type="collection" tone="auto"></s-icon>
                    <s-stack direction="block" gap="small-100">
                      <s-text type="strong">Rules center</s-text>
                      <s-text color="subdued">View and manage all promotional rules in one unified hub</s-text>
                    </s-stack>
                    <s-icon type="arrow-right" color="subdued"></s-icon>
                  </s-grid>
                </s-clickable>
                <s-clickable href="/app/documentation" padding="base" borderRadius="base">
                  <s-grid gridTemplateColumns="40px 1fr auto" gap="base" alignItems="center">
                    <s-icon type="book-open" tone="auto"></s-icon>
                    <s-stack direction="block" gap="small-100">
                      <s-text type="strong">App documentation</s-text>
                      <s-text color="subdued">Step-by-step setup guides and troubleshooting details</s-text>
                    </s-stack>
                    <s-icon type="arrow-right" color="subdued"></s-icon>
                  </s-grid>
                </s-clickable>
                <s-clickable href="/app/settings" padding="base" borderRadius="base">
                  <s-grid gridTemplateColumns="40px 1fr auto" gap="base" alignItems="center">
                    <s-icon type="settings" tone="auto"></s-icon>
                    <s-stack direction="block" gap="small-100">
                      <s-text type="strong">Storefront &amp; catalog settings</s-text>
                      <s-text color="subdued">Messages, safety limits and manual product catalog sync</s-text>
                    </s-stack>
                    <s-icon type="arrow-right" color="subdued"></s-icon>
                  </s-grid>
                </s-clickable>
              </s-stack>
            </s-stack>
          </s-section>

          <s-section heading="Ready for your first campaign?">
            <s-stack direction="block" gap="base">
              <s-stack direction="inline" gap="base" alignItems="start">
                <s-icon type={data.catalog ? "check-circle-filled" : "circle"} tone={data.catalog ? "success" : "neutral"}></s-icon>
                <s-stack direction="block" gap="small-100">
                  <s-text type="strong">Sync your product catalog</s-text>
                  <s-text color="subdued">Required for SKU and title matching pools.</s-text>
                </s-stack>
              </s-stack>
              <s-stack direction="inline" gap="base" alignItems="start">
                <s-icon
                  type={data.freeGiftRulesCount || data.mysteryBoxRulesCount ? "check-circle-filled" : "circle"}
                  tone={data.freeGiftRulesCount || data.mysteryBoxRulesCount ? "success" : "neutral"}
                ></s-icon>
                <s-stack direction="block" gap="small-100">
                  <s-text type="strong">Create a promotion</s-text>
                  <s-text color="subdued">Start with one simple test rule.</s-text>
                </s-stack>
              </s-stack>
              <s-stack direction="inline" gap="base" alignItems="start">
                <s-icon type="circle" tone="neutral"></s-icon>
                <s-stack direction="block" gap="small-100">
                  <s-text type="strong">Enable the theme app embed</s-text>
                  <s-text color="subdued">No theme code changes are made.</s-text>
                </s-stack>
              </s-stack>
              <s-stack direction="inline" gap="base" alignItems="start">
                <s-icon type="circle" tone="neutral"></s-icon>
                <s-stack direction="block" gap="small-100">
                  <s-text type="strong">Test cart and checkout</s-text>
                  <s-text color="subdued">Use a real customer journey before launch.</s-text>
                </s-stack>
              </s-stack>
            </s-stack>
          </s-section>
        </s-grid>

        {data.recentlyCreated.length > 0 && (
          <s-section heading="Recently created rules">
            <s-stack direction="block" gap="base">
              <s-paragraph color="subdued">Your latest promotions, newest first.</s-paragraph>
              <s-stack direction="block" gap="none">
                {data.recentlyCreated.map((rule) => (
                  <s-clickable href={rule.editUrl} key={rule.id} padding="base" borderRadius="base">
                    <s-grid gridTemplateColumns="40px 1fr auto" gap="base" alignItems="center">
                      <s-icon type={rule.type === "Free Gift" ? "gift-card" : "package"} tone="auto"></s-icon>
                      <s-stack direction="block" gap="small-100">
                        <s-text type="strong">{rule.name}</s-text>
                        <s-text color="subdued">
                          {rule.type} · Created{" "}
                          {new Date(rule.createdAt).toLocaleDateString(undefined, {
                            month: "short",
                            day: "numeric",
                            year: "numeric",
                          })}
                        </s-text>
                      </s-stack>
                      <s-icon type="arrow-right" color="subdued"></s-icon>
                    </s-grid>
                  </s-clickable>
                ))}
              </s-stack>
            </s-stack>
          </s-section>
        )}

        <s-stack direction="inline" alignItems="center" justifyContent="center" paddingBlock="large">
          <s-text color="subdued">
            Powered by <s-link href="https://digitalperfection.ae/" target="_blank">Digital Perfection</s-link>
          </s-text>
        </s-stack>
      </s-stack>
    </s-page>
  );
}
