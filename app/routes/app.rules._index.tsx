import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData, useNavigate } from "react-router";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { prismaJson } from "../lib/forms.server";
import {
  createPromotionDiscount,
  deletePromotionDiscount,
  ensurePromotionSecret,
} from "../lib/checkout-discount.server";
import { syncCartTransformRules } from "../lib/cart-transform.server";
import { deleteMysteryBoxProduct, syncMysteryBoxProduct } from "../lib/mystery-box-product.server";
import { MetricTile } from "../components/MetricTile";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const [gifts, mysteries, selections, catalog] = await Promise.all([
    prisma.giftRule.findMany({
      where: { shop: session.shop },
      orderBy: [{ priority: "asc" }, { updatedAt: "desc" }],
    }),
    prisma.mysteryBox.findMany({
      where: { shop: session.shop },
      include: { children: true },
      orderBy: [{ priority: "asc" }, { updatedAt: "desc" }],
    }),
    prisma.mysterySelection.count({ where: { shop: session.shop } }),
    prisma.catalogVariant.count({ where: { shop: session.shop } }),
  ]);

  // Every enabled gift rule needs its own Shopify discount (the checkout
  // Function is what actually zeroes the gift line). A mystery box only needs
  // one when its checkout Function step does something — BOGO (zeroes the
  // bonus line) or progressive price tiers (adjusts the box price) — a plain
  // priced box is correctly discount-less by design, so it must NOT be
  // counted as "missing" one.
  const mysteryNeedsDiscount = (box: (typeof mysteries)[number]) =>
    Boolean((box.bogo as any)?.enabled) ||
    ((box.priceTiers as unknown as unknown[]) ?? []).length > 0;
  const missingDiscounts =
    gifts.filter((rule) => rule.enabled && !rule.shopifyDiscountId).length +
    mysteries.filter((box) => box.enabled && mysteryNeedsDiscount(box) && !box.shopifyDiscountId).length;

  const active = (r: { enabled: boolean; startsAt: Date | null; endsAt: Date | null }) => {
    if (!r.enabled) return false;
    const now = new Date();
    if (r.startsAt && r.startsAt > now) return false;
    if (r.endsAt && r.endsAt < now) return false;
    return true;
  };

  // The visible status must agree with what the metric counts as "active".
  // A rule that is enabled but whose start date is still in the future is
  // Scheduled, not Active — otherwise the badge says "Active" while the
  // "Active rules" metric shows 0, which reads as a broken counter.
  const statusOf = (r: {
    enabled: boolean;
    startsAt: Date | null;
    endsAt: Date | null;
  }): "active" | "scheduled" | "expired" | "disabled" => {
    if (!r.enabled) return "disabled";
    const now = new Date();
    if (r.startsAt && r.startsAt > now) return "scheduled";
    if (r.endsAt && r.endsAt < now) return "expired";
    return "active";
  };

  const activeGifts = gifts.filter(active).length;
  const activeBoxes = mysteries.filter(active).length;

  const totalActive = activeGifts + activeBoxes;
  const totalDisabled = (gifts.length - activeGifts) + (mysteries.length - activeBoxes);

  const freeGiftRulesCount = gifts.length;
  const mysteryBoxRulesCount = mysteries.filter((b) => {
    const bogoVal = b.bogo as any;
    return !bogoVal || !bogoVal.enabled;
  }).length;
  const bogoRulesCount = mysteries.filter((b) => {
    const bogoVal = b.bogo as any;
    return bogoVal && bogoVal.enabled;
  }).length;

  const combined = [
    ...gifts.map((item) => ({
      id: item.id,
      name: item.name,
      type: "GIFT" as const,
      typeName: "Free Gift",
      enabled: item.enabled,
      status: statusOf(item),
      priority: item.priority,
      startsAt: item.startsAt,
      endsAt: item.endsAt,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      details: `${item.matchMode === "ALL" ? "All conditions" : "Any condition"} · ${item.maxGifts} gift${item.maxGifts === 1 ? "" : "s"}`,
      editUrl: `/app/gifts/${item.id}`,
    })),
    ...mysteries.map((item) => {
      const bogoVal = item.bogo as any;
      const isBogo = bogoVal && bogoVal.enabled;
      // Every pool item is currently unavailable/out of stock, so the box (or
      // BOGO reward) would silently fail to add anything hidden when a
      // shopper triggers it — surface it here instead of leaving it silent.
      const poolExhausted =
        item.inventoryBehavior !== "IGNORE" &&
        item.children.length > 0 &&
        !item.children.some(
          (child) =>
            child.available &&
            (child.inventoryQuantity === null || child.inventoryQuantity > 0),
        );
      return {
        id: item.id,
        name: item.name,
        type: "MYSTERY" as const,
        typeName: isBogo ? "Mystery Box BOGO" : "Mystery Box",
        enabled: item.enabled,
        status: statusOf(item),
        priority: item.priority,
        startsAt: item.startsAt,
        endsAt: item.endsAt,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        details: isBogo
          ? `Buy ${bogoVal.buyQuantity || 1} → Get ${bogoVal.freeQuantity || 1} Free`
          : `${item.children.length} pool variants · ${item.selectionMethod.toLowerCase().replace("_", " ")}`,
        editUrl: `/app/mystery-boxes/${item.id}`,
        poolExhausted,
      };
    }),
  ].sort((a, b) => a.priority - b.priority || b.updatedAt.getTime() - a.updatedAt.getTime());

  const exhaustedBoxCount = combined.filter(
    (rule) => rule.enabled && "poolExhausted" in rule && rule.poolExhausted,
  ).length;

  return {
    rules: combined,
    metrics: {
      totalActive,
      totalDisabled,
      freeGiftRulesCount,
      mysteryBoxRulesCount,
      bogoRulesCount,
      selections,
      catalog,
    },
    missingDiscounts,
    exhaustedBoxCount,
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const { session, admin } = await authenticate.admin(request);
  const form = await request.formData();
  const id = String(form.get("id") ?? "");
  const type = String(form.get("type") ?? "");
  const intent = String(form.get("intent") ?? "");

  if (type === "GIFT") {
    const rule = await prisma.giftRule.findFirst({ where: { id, shop: session.shop } });
    if (!rule) return Response.json({ ok: false }, { status: 404 });

    if (intent === "delete") {
      if (rule.shopifyDiscountId) await deletePromotionDiscount(admin, rule.shopifyDiscountId);
      await prisma.giftRule.delete({ where: { id } });
    } else if (intent === "toggle") {
      const enabling = !rule.enabled;
      let shopifyDiscountId = rule.shopifyDiscountId;
      if (enabling && !shopifyDiscountId) {
        try {
          const secret = await ensurePromotionSecret(session.shop);
          shopifyDiscountId = await createPromotionDiscount(admin, {
            title: `Free gift: ${rule.name}`,
            secret,
          });
        } catch (error) {
          return Response.json(
            { ok: false, error: error instanceof Error ? error.message : "Could not activate the checkout discount." },
            { status: 400 },
          );
        }
      } else if (!enabling && shopifyDiscountId) {
        await deletePromotionDiscount(admin, shopifyDiscountId);
        shopifyDiscountId = null;
      }
      await prisma.giftRule.update({ where: { id }, data: { enabled: enabling, shopifyDiscountId } });
    } else if (intent === "duplicate") {
      await prisma.giftRule.create({
        data: {
          shop: session.shop,
          name: `${rule.name} (copy)`,
          description: rule.description,
          enabled: false,
          priority: rule.priority,
          matchMode: rule.matchMode,
          conditions: prismaJson(rule.conditions),
          gifts: prismaJson(rule.gifts),
          allowMultiple: rule.allowMultiple,
          maxGifts: rule.maxGifts,
          stackable: rule.stackable,
          startsAt: rule.startsAt,
          endsAt: rule.endsAt,
          restrictions: prismaJson(rule.restrictions),
          notification: rule.notification,
        },
      });
    }
    await syncCartTransformRules(admin, session.shop);
  } else if (type === "MYSTERY") {
    const box = await prisma.mysteryBox.findFirst({
      where: { id, shop: session.shop },
      include: { children: true },
    });
    if (!box) return Response.json({ ok: false }, { status: 404 });

    if (intent === "delete") {
      if (box.shopifyDiscountId) await deletePromotionDiscount(admin, box.shopifyDiscountId);
      // The shadow product only ever exists to represent this one rule in
      // cart/checkout — nothing else in the store depends on it, so it should
      // never outlive the rule it belongs to.
      if (box.boxProductId) await deleteMysteryBoxProduct(admin, box.boxProductId);
      await prisma.mysteryBox.delete({ where: { id } });
    } else if (intent === "toggle") {
      const enabling = !box.enabled;
      const isBogo = Boolean((box.bogo as { enabled?: boolean } | null)?.enabled);
      const hasPriceTiers = ((box.priceTiers as unknown as unknown[]) ?? []).length > 0;
      // Only BOGO or price-tier boxes need the checkout Function to do
      // anything — a plain priced box needs no discount at all.
      const needsDiscount = isBogo || hasPriceTiers;
      let shopifyDiscountId = box.shopifyDiscountId;
      if (enabling && needsDiscount && !shopifyDiscountId) {
        try {
          const secret = await ensurePromotionSecret(session.shop);
          shopifyDiscountId = await createPromotionDiscount(admin, {
            title: `${isBogo ? "Mystery Box BOGO" : "Mystery box"}: ${box.name}`,
            secret,
          });
        } catch (error) {
          return Response.json(
            { ok: false, error: error instanceof Error ? error.message : "Could not activate the checkout discount." },
            { status: 400 },
          );
        }
      } else if ((!enabling || !needsDiscount) && shopifyDiscountId) {
        await deletePromotionDiscount(admin, shopifyDiscountId);
        shopifyDiscountId = null;
      }
      await prisma.mysteryBox.update({ where: { id }, data: { enabled: enabling, shopifyDiscountId } });
    } else if (intent === "duplicate") {
      const copyName = `${box.name} (copy)`;
      const isBogo = (box.bogo as { enabled?: boolean } | null)?.enabled;
      // A standard box's parent line IS its own shadow product, so the copy
      // needs a brand-new shadow product of its own — reusing the original's
      // ids would make the copy point at another box's product (and stay
      // unaddable, since it would have no boxVariantId). BOGO boxes trigger off
      // a real merchant product, so they don't get a shadow product.
      let copyBoxProductId: string | null = null;
      let copyBoxVariantId: string | null = null;
      let copyParentProductId = box.parentProductId;
      let copyParentVariantId = box.parentVariantId;
      let copyParentTitle = box.parentProductTitle;
      let copyParentVariantTitle = box.parentVariantTitle;
      if (!isBogo) {
        const synced = await syncMysteryBoxProduct(admin, session.shop, {
          name: copyName,
          boxPrice: Number(box.boxPrice),
          boxImageUrl: box.boxImageUrl,
        });
        copyBoxProductId = synced.boxProductId;
        copyBoxVariantId = synced.boxVariantId;
        copyParentProductId = synced.boxProductId;
        copyParentVariantId = synced.boxVariantId;
        copyParentTitle = copyName;
        copyParentVariantTitle = "Default Title";
      }
      await prisma.mysteryBox.create({
        data: {
          shop: session.shop,
          name: copyName,
          description: box.description,
          enabled: false,
          priority: box.priority,
          parentProductId: copyParentProductId,
          parentProductTitle: copyParentTitle,
          parentVariantId: copyParentVariantId,
          parentVariantTitle: copyParentVariantTitle,
          selectionMethod: box.selectionMethod,
          inventoryBehavior: box.inventoryBehavior,
          selectionCount: box.selectionCount,
          allowDuplicateChoices: box.allowDuplicateChoices,
          matchingRules: prismaJson(box.matchingRules),
          priceTiers: prismaJson(box.priceTiers),
          bogo: prismaJson(box.bogo),
          restrictions: prismaJson(box.restrictions),
          boxProductId: copyBoxProductId,
          boxVariantId: copyBoxVariantId,
          boxPrice: box.boxPrice,
          boxImageUrl: box.boxImageUrl,
          startsAt: box.startsAt,
          endsAt: box.endsAt,
          children: {
            create: box.children.map((child) => ({
              productId: child.productId,
              productTitle: child.productTitle,
              variantId: child.variantId,
              variantTitle: child.variantTitle,
              sku: child.sku,
              imageUrl: child.imageUrl,
              inventoryQuantity: child.inventoryQuantity,
              available: child.available,
              weight: child.weight,
              position: child.position,
            })),
          },
        },
      });
    }
  }

  return { ok: true };
}

export default function UnifiedRules() {
  const { rules, metrics, missingDiscounts, exhaustedBoxCount } = useLoaderData<typeof loader>();
  const navigate = useNavigate();

  const formatDate = (date: string | Date) => {
    return new Date(date).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  };

  return (
    <s-page heading="Promotional rules">
      <div className="page-intro" style={{ background: "linear-gradient(110deg, #e8f2f5, #f7fbfb)", borderColor: "#d0e4ea" }}>
        <div>
          <span className="eyebrow" style={{ color: "#3a6d7a" }}>PROMOTIONS CONTROL CENTER</span>
          <h2>A single hub for all rules.</h2>
          <p>
            Create, manage, and coordinate your Free Gift and Mystery Box promotions in one priority-ordered index.
          </p>
        </div>
        <div className="hero-stat" style={{ borderLeftColor: "rgba(58, 109, 122, 0.16)" }}>
          <strong>{metrics.totalActive}</strong>
          <span style={{ color: "#567b84" }}>active rules</span>
        </div>
      </div>

      {missingDiscounts > 0 && (
          <s-banner
            tone="critical"
            heading={`${missingDiscounts} active rule${missingDiscounts === 1 ? "" : "s"} missing its checkout discount`}
          >
            <s-paragraph>
              It won&apos;t apply at checkout until this is fixed. <s-link href="/app/settings">Fix now in Settings</s-link>
            </s-paragraph>
          </s-banner>
        )}

        {exhaustedBoxCount > 0 && (
          <s-banner
            tone="warning"
            heading={`${exhaustedBoxCount} active mystery box${exhaustedBoxCount === 1 ? "" : "es"} ha${exhaustedBoxCount === 1 ? "s" : "ve"} an empty pool`}
          >
            <s-paragraph>
              Every item in it is out of stock, so it won&apos;t add anything hidden to the cart until you restock or add more pool items.
            </s-paragraph>
          </s-banner>
        )}

        <s-section padding="base">
          <s-grid gridTemplateColumns="1fr auto 1fr auto 1fr auto 1fr" gap="large" alignItems="center">
            <MetricTile
              icon="check-circle"
              tone="success"
              value={metrics.totalActive}
              label="Active rules"
              detail={`${metrics.totalDisabled} disabled`}
            />
            <s-divider direction="block"></s-divider>
            <MetricTile
              icon="gift-card"
              tone="info"
              value={metrics.freeGiftRulesCount}
              label="Free Gift rules"
            />
            <s-divider direction="block"></s-divider>
            <MetricTile
              icon="product"
              tone="info"
              value={metrics.mysteryBoxRulesCount}
              label="Mystery Box rules"
            />
            <s-divider direction="block"></s-divider>
            <MetricTile
              icon="inventory"
              tone="info"
              value={metrics.catalog}
              label="Synced variants"
              detail={`${metrics.selections} selections`}
            />
          </s-grid>
        </s-section>

        <s-section heading="Campaign rules">
          <s-stack direction="block" gap="base">
            <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
              <s-text color="subdued">{rules.length} total rule{rules.length === 1 ? "" : "s"}</s-text>
              <s-stack direction="inline" gap="small-300">
                <s-button icon="package" accessibilityLabel="Create mystery box" onClick={() => navigate("/app/mystery-boxes/new?type=STANDARD")}>
                  Create mystery box
                </s-button>
                <s-button variant="primary" icon="gift-card" accessibilityLabel="Create free gift" onClick={() => navigate("/app/gifts/new")}>
                  Create free gift
                </s-button>
              </s-stack>
            </s-stack>

            {rules.length ? (
              <s-table>
                <s-table-header-row>
                  <s-table-header listSlot="primary">Rule name</s-table-header>
                  <s-table-header>Type</s-table-header>
                  <s-table-header>Priority</s-table-header>
                  <s-table-header>Created / Updated</s-table-header>
                  <s-table-header>Status</s-table-header>
                  <s-table-header>Actions</s-table-header>
                </s-table-header-row>
                <s-table-body>
                  {rules.map((rule) => (
                    <s-table-row key={`${rule.type}-${rule.id}`}>
                      <s-table-cell>
                        <s-stack direction="block" gap="small-100">
                          <s-link href={rule.editUrl}>{rule.name}</s-link>
                          <s-text color="subdued">{rule.details}</s-text>
                          {"poolExhausted" in rule && rule.poolExhausted && (
                            <s-text tone="warning">⚠ Pool out of stock</s-text>
                          )}
                        </s-stack>
                      </s-table-cell>
                      <s-table-cell>{rule.typeName}</s-table-cell>
                      <s-table-cell>#{rule.priority}</s-table-cell>
                      <s-table-cell>
                        <s-stack direction="block" gap="small-100">
                          <s-text color="subdued">Created {formatDate(rule.createdAt)}</s-text>
                          <s-text color="subdued">Updated {formatDate(rule.updatedAt)}</s-text>
                        </s-stack>
                      </s-table-cell>
                      <s-table-cell>
                        <s-badge
                          tone={
                            rule.status === "active"
                              ? "success"
                              : rule.status === "scheduled"
                                ? "info"
                                : rule.status === "expired"
                                  ? "warning"
                                  : "neutral"
                          }
                        >
                          {rule.status === "active"
                            ? "Active"
                            : rule.status === "scheduled"
                              ? "Scheduled"
                              : rule.status === "expired"
                                ? "Expired"
                                : "Disabled"}
                        </s-badge>
                      </s-table-cell>
                      <s-table-cell>
                        <div style={{ display: "flex", gap: "8px" }}>
                          <Form method="post">
                            <input type="hidden" name="id" value={rule.id} />
                            <input type="hidden" name="type" value={rule.type} />
                            <input type="hidden" name="intent" value="toggle" />
                            <s-button type="submit">
                              {rule.enabled ? "Disable" : "Enable"}
                            </s-button>
                          </Form>
                          <Form method="post">
                            <input type="hidden" name="id" value={rule.id} />
                            <input type="hidden" name="type" value={rule.type} />
                            <input type="hidden" name="intent" value="duplicate" />
                            <s-button type="submit" icon="duplicate" accessibilityLabel="Duplicate rule">
                              Copy
                            </s-button>
                          </Form>
                          <Form method="post">
                            <input type="hidden" name="id" value={rule.id} />
                            <input type="hidden" name="type" value={rule.type} />
                            <input type="hidden" name="intent" value="delete" />
                            <s-button type="submit" tone="critical" icon="delete" accessibilityLabel="Delete rule">
                              Delete
                            </s-button>
                          </Form>
                        </div>
                      </s-table-cell>
                    </s-table-row>
                  ))}
                </s-table-body>
              </s-table>
            ) : (
              <s-box padding="large">
                <s-stack direction="block" gap="base" alignItems="center">
                  <s-icon type="collection" color="subdued"></s-icon>
                  <s-heading>No rules found</s-heading>
                  <s-text color="subdued">
                    Get started by creating your first Free Gift or Mystery Box promotion to delight customers.
                  </s-text>
                  <s-button variant="primary" icon="plus" accessibilityLabel="Create your first rule" onClick={() => navigate("/app/gifts/new")}>
                    Create your first rule
                  </s-button>
                </s-stack>
              </s-box>
            )}
          </s-stack>
        </s-section>
    </s-page>
  );
}
