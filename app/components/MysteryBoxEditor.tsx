import { useEffect, useRef, useState } from "react";
import { Form, useActionData, useFetcher, useNavigate, useNavigation } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import type {
  BogoConfiguration,
  MatchingRule,
  PriceTier,
} from "../lib/promotions.types";
import type { ResolvedSkuVariant } from "../lib/catalog.server";
import { resourceImage, meaningfulVariantTitle } from "../lib/resource-display";

export interface ChildChoice {
  productId: string;
  productTitle: string;
  variantId: string;
  variantTitle: string;
  sku?: string | null;
  imageUrl?: string | null;
  inventoryQuantity?: number | null;
  available?: boolean;
  weight?: number;
}

export interface MysteryEditorValue {
  id?: string;
  name: string;
  description?: string | null;
  enabled: boolean;
  priority: number;
  parentProductId: string;
  parentProductTitle: string;
  parentVariantId?: string | null;
  parentVariantTitle?: string | null;
  selectionMethod: string;
  inventoryBehavior: string;
  selectionCount: number;
  allowDuplicateChoices: boolean;
  boxPrice: number;
  boxImageUrl?: string | null;
  matchingRules: MatchingRule[];
  priceTiers: PriceTier[];
  bogo: BogoConfiguration;
  restrictions: {
    onePerOrder?: boolean;
    onePerCustomer?: boolean;
    firstPurchaseOnly?: boolean;
    allowedCustomerTags?: string[];
    excludedCustomerTags?: string[];
  };
  startsAt?: string | null;
  endsAt?: string | null;
  children: ChildChoice[];
}

function localDate(value?: string | null) {
  return value ? new Date(value).toISOString().slice(0, 16) : "";
}

// Fixed column widths keep every row in a given list — child pool, matching
// rules, price tiers — lined up at the same x-position regardless of how
// long the product title or which fields happen to be visible.
const CHILD_ROW_GRID = "auto 1fr 90px 40px";
const TIER_ROW_GRID = "120px 1fr 120px 40px";

export function MysteryBoxEditor({
  value,
  title,
  availableBoxes = [],
}: {
  value: MysteryEditorValue;
  title: string;
  availableBoxes?: Array<{ id: string; name: string }>;
}) {
  const shopify = useAppBridge();
  const navigate = useNavigate();
  const navigation = useNavigation();
  const actionData = useActionData() as { error?: string } | undefined;
  const [parent, setParent] = useState({
    productId: value.parentProductId,
    productTitle: value.parentProductTitle,
    variantId: value.parentVariantId ?? "",
    variantTitle: value.parentVariantTitle ?? "",
  });
  const [promotionType] = useState(value.bogo.enabled ? "BOGO" : "STANDARD");
  const [children, setChildren] = useState(value.children);
  const [tiers, setTiers] = useState(value.priceTiers);
  const skuFetcher = useFetcher<{
    variants: ResolvedSkuVariant[];
    notFound: string[];
  }>();
  const [skuInput, setSkuInput] = useState("");
  const [skuNotFound, setSkuNotFound] = useState<string[]>([]);
  const lastSkuData = useRef(skuFetcher.data);

  useEffect(() => {
    if (!skuFetcher.data || skuFetcher.data === lastSkuData.current) return;
    lastSkuData.current = skuFetcher.data;
    const { variants, notFound } = skuFetcher.data;
    setChildren((current) => {
      const next = [...current];
      for (const variant of variants) {
        if (next.some((item) => item.variantId === variant.variantId))
          continue;
        next.push({ ...variant, weight: 1 });
      }
      return next;
    });
    setSkuNotFound(notFound);
    setSkuInput("");
  }, [skuFetcher.data]);

  function addBySku() {
    if (!skuInput.trim()) return;
    skuFetcher.submit(
      { skus: skuInput },
      { method: "post", action: "/app/mystery-boxes/resolve-skus" },
    );
  }

  async function pickParent() {
    const selection = await shopify.resourcePicker({
      type: "product",
      multiple: false,
      filter: { variants: true },
    });
    const product = selection?.[0];
    if (!product) return;
    const variant = product.variants?.[0];
    setParent({
      productId: product.id,
      productTitle: product.title,
      variantId: variant?.id ?? "",
      variantTitle: variant?.title ?? "",
    });
  }

  async function pickChildren() {
    const selection = await shopify.resourcePicker({
      type: "product",
      multiple: true,
      filter: { variants: true },
    });
    if (!selection) return;
    const next = [...children];
    for (const product of selection) {
      for (const variant of product.variants ?? []) {
        if (!variant.id) continue;
        if (next.some((item) => item.variantId === variant.id)) continue;
        next.push({
          productId: product.id,
          productTitle: product.title ?? "Untitled product",
          variantId: variant.id,
          variantTitle: variant.title ?? "Default",
          sku: variant.sku,
          imageUrl: resourceImage(product, variant),
          inventoryQuantity: variant.inventoryQuantity,
          available: true,
          weight: 1,
        });
      }
    }
    setChildren(next);
  }

  const busy = navigation.state === "submitting";
  const disableSave =
    busy ||
    (promotionType === "BOGO" && !parent.productId) ||
    !children.length;

  return (
    <Form method="post">
      <input type="hidden" name="parent" value={JSON.stringify(parent)} />
      <input type="hidden" name="children" value={JSON.stringify(children)} />
      {/* Automatic pool matching was removed from the UI; always submit an
          empty set so the pool comes only from explicit products + SKUs. */}
      <input type="hidden" name="matchingRules" value="[]" />
      <input type="hidden" name="priceTiers" value={JSON.stringify(tiers)} />
      <input
        type="hidden"
        name="bogoEnabled"
        value={promotionType === "BOGO" ? "true" : "false"}
      />

      <s-page heading={title}>
        <s-link slot="breadcrumb-actions" href="/app/rules">
          Rules
        </s-link>
        <s-button
          slot="primary-action"
          type="submit"
          variant="primary"
          disabled={disableSave}
        >
          {busy ? "Saving…" : "Save mystery box"}
        </s-button>
        <s-button slot="secondary-actions" onClick={() => navigate("/app/rules")}>
          Cancel
        </s-button>

        {actionData?.error && (
          <s-banner heading="Couldn't save this mystery box" tone="critical">
            <s-paragraph>{actionData.error}</s-paragraph>
          </s-banner>
        )}

        <s-section heading="Box details">
          <s-stack direction="block" gap="base">
            <s-paragraph color="subdued">
              Shown to the shopper as its own cart line — image, name, and price
              below — alongside the parent product. The real child item that
              gets picked always stays hidden.
            </s-paragraph>
            <s-grid gap="base">
              <s-text-field
                label="Mystery box name"
                name="name"
                value={value.name}
                placeholder="Summer surprise box"
                required
              ></s-text-field>
              <s-text-area
                label="Description"
                name="description"
                value={value.description ?? ""}
                placeholder="Internal note (optional)"
              ></s-text-area>
              <s-grid gridTemplateColumns="1fr 1fr" gap="base">
                <s-money-field
                  label="Box price"
                  name="boxPrice"
                  min={0}
                  value={String(value.boxPrice)}
                  placeholder="0.00"
                ></s-money-field>
                <s-url-field
                  label="Box image URL"
                  name="boxImageUrl"
                  value={value.boxImageUrl ?? ""}
                  placeholder="https://..."
                ></s-url-field>
              </s-grid>
            </s-grid>
          </s-stack>
        </s-section>

        {promotionType === "BOGO" && (
          <s-section heading="Parent product">
            <s-stack direction="block" gap="base">
              <s-stack direction="inline" gap="base" alignItems="start" justifyContent="space-between">
                <s-paragraph color="subdued">
                  The product customers actually buy that triggers this BOGO
                  promotion.
                </s-paragraph>
                <s-button onClick={pickParent}>
                  {parent.productId ? "Change" : "Select product"}
                </s-button>
              </s-stack>
              {parent.productId ? (
                <s-box padding="base" background="subdued" borderRadius="base">
                  <s-stack direction="inline" gap="base" alignItems="center">
                    <s-icon type="cart" tone="auto"></s-icon>
                    <s-stack direction="block" gap="small-100">
                      <s-text type="strong">{parent.productTitle}</s-text>
                      <s-text color="subdued">
                        {parent.variantTitle || "All variants"}
                      </s-text>
                    </s-stack>
                  </s-stack>
                </s-box>
              ) : (
                <s-clickable
                  onClick={pickParent}
                  padding="large"
                  background="subdued"
                  borderRadius="base"
                  border="base subdued dashed"
                >
                  <s-text color="subdued">Select a parent product</s-text>
                </s-clickable>
              )}
            </s-stack>
          </s-section>
        )}

        <s-section heading="Child product pool">
          <s-stack direction="block" gap="base">
            <s-stack direction="inline" gap="base" alignItems="start" justifyContent="space-between">
              <s-paragraph color="subdued">
                Add any number of products or individual variants.
              </s-paragraph>
              <s-button onClick={pickChildren}>Add products</s-button>
            </s-stack>

            {children.length ? (
              <s-stack direction="block" gap="small-300">
                {children.map((child, index) => (
                  <s-box
                    key={child.variantId}
                    padding="small-300"
                    border="base"
                    borderRadius="base"
                  >
                    <s-grid gridTemplateColumns={CHILD_ROW_GRID} gap="base" alignItems="center">
                      {child.imageUrl ? (
                        <s-thumbnail src={child.imageUrl} alt={child.productTitle} size="small"></s-thumbnail>
                      ) : (
                        <s-box padding="small-300" background="subdued" borderRadius="base">
                          <s-icon type="product" tone="auto"></s-icon>
                        </s-box>
                      )}
                      <s-stack direction="block" gap="small-500">
                        <s-text type="strong">{child.productTitle}</s-text>
                        {(() => {
                          const label = meaningfulVariantTitle(child.productTitle, child.variantTitle);
                          const detail = [label, child.sku].filter(Boolean).join(" · ");
                          return detail ? <s-text color="subdued">{detail}</s-text> : null;
                        })()}
                      </s-stack>
                      <s-number-field
                        label="Weight"
                        labelAccessibilityVisibility="exclusive"
                        min={1}
                        value={String(child.weight ?? 1)}
                        onChange={(event: any) =>
                          setChildren((current) =>
                            current.map((item, itemIndex) =>
                              itemIndex === index
                                ? {
                                    ...item,
                                    weight: Math.max(
                                      1,
                                      Number(event.target.value),
                                    ),
                                  }
                                : item,
                            ),
                          )
                        }
                      ></s-number-field>
                      <s-button
                        icon="delete"
                        accessibilityLabel="Remove child"
                        tone="critical"
                        variant="tertiary"
                        onClick={() =>
                          setChildren((current) =>
                            current.filter((_, itemIndex) => itemIndex !== index),
                          )
                        }
                      ></s-button>
                    </s-grid>
                  </s-box>
                ))}
              </s-stack>
            ) : (
              <s-clickable
                onClick={pickChildren}
                padding="large"
                background="subdued"
                borderRadius="base"
                border="base subdued dashed"
              >
                <s-text color="subdued">
                  No child variants yet. Select several at once.
                </s-text>
              </s-clickable>
            )}

            <s-stack direction="block" gap="small-300">
              <s-text-area
                label="Add by SKU list"
                value={skuInput}
                onChange={(event: any) => setSkuInput(event.target.value)}
                placeholder={"SKU-001, SKU-002\nSKU-003"}
              ></s-text-area>
              <div>
                <s-button
                  disabled={skuFetcher.state !== "idle" || !skuInput.trim()}
                  onClick={addBySku}
                >
                  {skuFetcher.state !== "idle" ? "Looking up…" : "Add by SKU"}
                </s-button>
              </div>
            </s-stack>
            {skuNotFound.length > 0 && (
              <s-banner tone="warning">
                No variant found for: {skuNotFound.join(", ")}
              </s-banner>
            )}
          </s-stack>
        </s-section>

        {promotionType === "STANDARD" && (
          <s-section heading="Progressive price tiers">
            <s-stack direction="block" gap="base">
              <s-paragraph color="subdued">
                Example: first box at regular price, second 30% off, third 40%
                off. The checkout function applies the best matching tier.
              </s-paragraph>
              {tiers.length > 0 && (
                <s-stack direction="block" gap="small-300">
                  {tiers.map((tier, index) => (
                    <s-box
                      key={index}
                      padding="small-300"
                      background="subdued"
                      borderRadius="base"
                    >
                      <s-grid gridTemplateColumns={TIER_ROW_GRID} gap="base" alignItems="center">
                        <s-number-field
                          label="From quantity"
                          min={1}
                          value={String(tier.minQuantity)}
                          onChange={(event: any) =>
                            setTiers((current) =>
                              current.map((item, i) =>
                                i === index
                                  ? {
                                      ...item,
                                      minQuantity: Math.max(
                                        1,
                                        Number(event.target.value),
                                      ),
                                    }
                                  : item,
                              ),
                            )
                          }
                        ></s-number-field>
                        <s-select
                          label="Adjustment"
                          value={tier.adjustmentType}
                          onChange={(event: any) =>
                            setTiers((current) =>
                              current.map((item, i) =>
                                i === index
                                  ? {
                                      ...item,
                                      adjustmentType: event.target
                                        .value as PriceTier["adjustmentType"],
                                    }
                                  : item,
                              ),
                            )
                          }
                        >
                          <s-option value="PERCENT_OFF">Percentage off</s-option>
                          <s-option value="FIXED_OFF">Fixed amount off</s-option>
                          <s-option value="FIXED_PRICE">Final unit price</s-option>
                        </s-select>
                        <s-number-field
                          label="Value"
                          min={0}
                          step={0.01}
                          value={String(tier.value)}
                          onChange={(event: any) =>
                            setTiers((current) =>
                              current.map((item, i) =>
                                i === index
                                  ? {
                                      ...item,
                                      value: Math.max(0, Number(event.target.value)),
                                    }
                                  : item,
                              ),
                            )
                          }
                        ></s-number-field>
                        <s-button
                          icon="delete"
                          accessibilityLabel="Remove price tier"
                          tone="critical"
                          variant="tertiary"
                          onClick={() =>
                            setTiers((current) => current.filter((_, i) => i !== index))
                          }
                        ></s-button>
                      </s-grid>
                    </s-box>
                  ))}
                </s-stack>
              )}
              <div>
                <s-button
                  icon="plus"
                  accessibilityLabel="Add price tier"
                  onClick={() =>
                    setTiers((current) => [
                      ...current,
                      {
                        minQuantity: (current.at(-1)?.minQuantity ?? 1) + 1,
                        adjustmentType: "PERCENT_OFF",
                        value: 30,
                      },
                    ])
                  }
                >
                  Add price tier
                </s-button>
              </div>
            </s-stack>
          </s-section>
        )}

        {promotionType === "BOGO" && (
          <s-section heading="Mystery Box BOGO settings">
            <s-stack direction="block" gap="base">
              <s-paragraph color="subdued">
                Configure Buy X Get Y logic and randomize gift rewards.
              </s-paragraph>
              <s-switch
                label="Randomize gifts"
                details="Select random gift from child products pool"
                name="randomizeGifts"
                defaultChecked={value.bogo.randomizeGifts !== false}
              ></s-switch>
              <s-grid gridTemplateColumns="1fr 1fr 1fr" gap="base">
                <s-number-field
                  label="Buy quantity"
                  min={1}
                  name="buyQuantity"
                  value={String(value.bogo.buyQuantity ?? 1)}
                ></s-number-field>
                <s-number-field
                  label="Free quantity"
                  min={1}
                  name="freeQuantity"
                  value={String(value.bogo.freeQuantity ?? 1)}
                ></s-number-field>
                <s-select
                  label="Reward box"
                  name="bogoTarget"
                  value={value.bogo.target ?? "SAME_BOX"}
                >
                  <s-option value="SAME_BOX">Same mystery box</s-option>
                  <s-option value="DIFFERENT_BOX">Different mystery box</s-option>
                </s-select>
              </s-grid>
              <s-select
                label="Different reward box"
                name="targetBoxId"
                value={value.bogo.targetBoxId ?? ""}
              >
                <s-option value="">Select a mystery box</s-option>
                {availableBoxes
                  .filter((box) => box.id !== value.id)
                  .map((box) => (
                    <s-option key={box.id} value={box.id}>
                      {box.name}
                    </s-option>
                  ))}
              </s-select>
            </s-stack>
          </s-section>
        )}

        <s-section slot="aside" heading="Behavior">
          <s-stack direction="block" gap="base">
            <s-switch
              label="Box enabled"
              details="Run on the storefront"
              name="enabled"
              defaultChecked={value.enabled}
            ></s-switch>
            {promotionType === "STANDARD" && (
              <s-select
                label="Selection method"
                name="selectionMethod"
                value={value.selectionMethod}
              >
                <s-option value="RANDOM">Completely random</s-option>
                <s-option value="WEIGHTED">Weighted random</s-option>
                <s-option value="SEQUENTIAL">Sequential</s-option>
                <s-option value="ROUND_ROBIN">Round robin</s-option>
                <s-option value="HIGHEST_INVENTORY">Highest inventory</s-option>
                <s-option value="LOWEST_INVENTORY">Lowest inventory</s-option>
              </s-select>
            )}
            <s-select
              label="Inventory behavior"
              name="inventoryBehavior"
              value={value.inventoryBehavior}
            >
              <s-option value="IN_STOCK_ONLY">Only in-stock products</s-option>
              <s-option value="SKIP_UNAVAILABLE">Skip unavailable</s-option>
              <s-option value="NEXT_AVAILABLE">Select next available</s-option>
              <s-option value="IGNORE">Ignore inventory</s-option>
            </s-select>
            {promotionType === "STANDARD" && (
              <s-number-field
                label="Items selected per box"
                min={1}
                name="selectionCount"
                value={String(value.selectionCount)}
              ></s-number-field>
            )}
            <s-number-field
              label="Priority"
              min={1}
              name="priority"
              value={String(value.priority)}
            ></s-number-field>
            <s-switch
              label="Allow repeated child"
              details="Same variant may be selected twice"
              name="allowDuplicateChoices"
              defaultChecked={value.allowDuplicateChoices}
            ></s-switch>
          </s-stack>
        </s-section>

        <s-section slot="aside" heading="Schedule">
          <s-stack direction="block" gap="base">
            <label className="native-datetime-field">
              <span>Starts at</span>
              <input
                type="datetime-local"
                name="startsAt"
                defaultValue={localDate(value.startsAt)}
              />
            </label>
            <label className="native-datetime-field">
              <span>Ends at</span>
              <input
                type="datetime-local"
                name="endsAt"
                defaultValue={localDate(value.endsAt)}
              />
            </label>
          </s-stack>
        </s-section>

        <s-section slot="aside" heading="Customer limits">
          <s-stack direction="block" gap="base">
            <s-switch
              label="One per order"
              name="onePerOrder"
              defaultChecked={value.restrictions.onePerOrder}
            ></s-switch>
            <s-switch
              label="One per customer"
              name="onePerCustomer"
              defaultChecked={value.restrictions.onePerCustomer}
            ></s-switch>
            <s-switch
              label="First purchase only"
              name="firstPurchaseOnly"
              defaultChecked={value.restrictions.firstPurchaseOnly}
            ></s-switch>
            <s-text-field
              label="Allowed customer tags"
              name="allowedCustomerTags"
              value={value.restrictions.allowedCustomerTags?.join(", ") ?? ""}
              placeholder="VIP, loyalty"
            ></s-text-field>
            <s-text-field
              label="Excluded customer tags"
              name="excludedCustomerTags"
              value={value.restrictions.excludedCustomerTags?.join(", ") ?? ""}
              placeholder="no-gifts"
            ></s-text-field>
          </s-stack>
        </s-section>
      </s-page>
    </Form>
  );
}
