import { useMemo, useState } from "react";
import { Form, useActionData, useNavigate, useNavigation } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import type { GiftChoice, RuleCondition } from "../lib/promotions.types";
import { resourceImage, meaningfulVariantTitle } from "../lib/resource-display";

export interface GiftRuleEditorValue {
  id?: string;
  name: string;
  description?: string | null;
  enabled: boolean;
  priority: number;
  matchMode: string;
  conditions: RuleCondition[];
  gifts: GiftChoice[];
  allowMultiple: boolean;
  maxGifts: number;
  stackable: boolean;
  startsAt?: string | null;
  endsAt?: string | null;
  restrictions: {
    onePerOrder?: boolean;
    onePerCustomer?: boolean;
    firstPurchaseOnly?: boolean;
    allowedCustomerTags?: string[];
    excludedCustomerTags?: string[];
  };
  notification?: string | null;
  // Display names for any "product"/"variant"/"collection" condition values
  // already saved on this rule (keyed by the raw GID) — resolved server-side
  // since the condition itself only stores IDs, not titles.
  conditionLabels?: Record<string, string>;
}

const fields = [
  ["subtotal", "Cart subtotal"],
  ["quantity", "Total quantity"],
  ["distinct_products", "Different products"],
  ["product", "Product"],
  ["variant", "Product variant"],
  ["sku", "SKU"],
  ["product_tag", "Product tag"],
  ["vendor", "Vendor"],
  ["product_type", "Product type"],
  ["collection", "Collection"],
  ["customer_tag", "Customer tag"],
  ["customer_logged_in", "Customer login status"],
  ["country", "Country / market"],
  ["discount_code", "Discount code"],
] as const;

const operators = [
  ["equals", "Equals"],
  ["not_equals", "Does not equal"],
  ["greater_or_equal", "At least"],
  ["less_or_equal", "At most"],
  ["contains", "Contains"],
  ["not_contains", "Does not contain"],
  ["starts_with", "Starts with"],
  ["ends_with", "Ends with"],
] as const;

// "At least $50" makes sense for a number field; it's meaningless for a
// vendor name or a country code. Each field only offers operators that
// actually apply to its kind of value, instead of always showing all eight.
const numericOperatorIds = new Set([
  "equals",
  "not_equals",
  "greater_or_equal",
  "less_or_equal",
]);
const textOperatorIds = new Set([
  "equals",
  "not_equals",
  "contains",
  "not_contains",
  "starts_with",
  "ends_with",
]);
const numericOperators = operators.filter(([id]) => numericOperatorIds.has(id));
const textOperators = operators.filter(([id]) => textOperatorIds.has(id));

type ConditionKind =
  | "numeric"
  | "text"
  | "boolean"
  | "product"
  | "variant"
  | "collection";

function conditionKind(field: RuleCondition["field"]): ConditionKind {
  switch (field) {
    case "subtotal":
    case "quantity":
    case "distinct_products":
      return "numeric";
    case "product":
      return "product";
    case "variant":
      return "variant";
    case "collection":
      return "collection";
    case "customer_logged_in":
      return "boolean";
    default:
      return "text";
  }
}

const fieldPlaceholders: Partial<Record<RuleCondition["field"], string>> = {
  sku: "e.g. SHIRT-RED-M",
  product_tag: "e.g. sale",
  vendor: "e.g. Acme Co.",
  product_type: "e.g. Snowboard",
  customer_tag: "e.g. vip",
  country: "2-letter code, e.g. US",
  discount_code: "e.g. SUMMER10",
};

function defaultValueAndOperator(
  kind: ConditionKind,
): Pick<RuleCondition, "value" | "operator"> {
  switch (kind) {
    case "numeric":
      return { value: "1", operator: "greater_or_equal" };
    case "boolean":
      return { value: "true", operator: "equals" };
    case "product":
    case "variant":
    case "collection":
      return { value: [], operator: "equals" };
    default:
      return { value: "", operator: "equals" };
  }
}

function localDate(value?: string | null) {
  return value ? new Date(value).toISOString().slice(0, 16) : "";
}

// Fixed pixel widths so the field selector and remove button land at the
// exact same x-position on every condition row, no matter which kind of
// value editor (chips, a select, or an operator + input pair) sits between
// them — the thing that was drifting out of alignment before.
const CONDITION_GRID = "180px 140px 1fr 40px";

export function GiftRuleEditor({
  value,
  title,
}: {
  value: GiftRuleEditorValue;
  title: string;
}) {
  const shopify = useAppBridge();
  const navigate = useNavigate();
  const navigation = useNavigation();
  const actionData = useActionData() as { error?: string } | undefined;
  const [conditions, setConditions] = useState(value.conditions);
  const [gifts, setGifts] = useState(value.gifts);
  const [conditionLabels, setConditionLabels] = useState<Record<string, string>>(
    value.conditionLabels ?? {},
  );
  const busy = navigation.state === "submitting";

  const giftLabel = useMemo(
    () =>
      gifts.length
        ? `${gifts.length} variant${gifts.length === 1 ? "" : "s"} selected`
        : "No gifts selected",
    [gifts.length],
  );

  async function pickGifts() {
    const selection = await shopify.resourcePicker({
      type: "product",
      multiple: true,
      filter: { variants: true },
    });
    if (!selection) return;
    const next: GiftChoice[] = [];
    for (const product of selection) {
      for (const variant of product.variants ?? []) {
        if (!variant.id) continue;
        next.push({
          productId: product.id,
          productTitle: product.title ?? "Untitled product",
          variantId: variant.id,
          variantTitle: variant.title ?? "Default",
          imageUrl: resourceImage(product, variant),
          quantity: 1,
        });
      }
    }
    setGifts(next);
  }

  function updateCondition(index: number, patch: Partial<RuleCondition>) {
    setConditions((current) =>
      current.map((item, itemIndex) =>
        itemIndex === index ? { ...item, ...patch } : item,
      ),
    );
  }

  async function pickConditionResource(
    index: number,
    field: RuleCondition["field"],
  ) {
    if (field === "collection") {
      const selection = await shopify.resourcePicker({
        type: "collection",
        multiple: true,
      });
      if (!selection) return;
      const ids: string[] = [];
      const nextLabels: Record<string, string> = {};
      for (const collection of selection) {
        if (!collection.id) continue;
        ids.push(collection.id);
        nextLabels[collection.id] = collection.title ?? collection.id;
      }
      if (!ids.length) return;
      setConditionLabels((current) => ({ ...current, ...nextLabels }));
      updateCondition(index, { value: ids, operator: "equals" });
      return;
    }

    // Only show the picker's per-variant checkboxes when the condition
    // itself is variant-scoped — a "Product" condition matches on the
    // product as a whole, so showing variant checkboxes there just invited
    // the merchant to check specific variants that then had no effect (the
    // product's own id was captured either way, collapsing every checked
    // variant into a single chip and looking like a bug).
    const selection = await shopify.resourcePicker({
      type: "product",
      multiple: true,
      filter: { variants: field === "variant" },
    });
    if (!selection) return;
    const ids: string[] = [];
    const nextLabels: Record<string, string> = {};
    for (const product of selection) {
      if (field === "variant") {
        for (const variant of product.variants ?? []) {
          if (!variant.id) continue;
          ids.push(variant.id);
          nextLabels[variant.id] =
            variant.title && variant.title !== "Default Title"
              ? `${product.title ?? "Untitled product"} — ${variant.title}`
              : product.title ?? variant.id;
        }
      } else if (product.id) {
        ids.push(product.id);
        nextLabels[product.id] = product.title ?? product.id;
      }
    }
    if (!ids.length) return;
    setConditionLabels((current) => ({ ...current, ...nextLabels }));
    // "equals" against an array means "cart contains any of these" (see
    // anyLine() in promotion-engine.server.ts) — the only sensible semantic
    // for identity-matching a set of products/variants, so it's set here
    // rather than left for the merchant to pick from an operator list that
    // otherwise reads like a numeric comparison ("At least", "At most").
    updateCondition(index, { value: ids, operator: "equals" });
  }

  function conditionValueIds(condition: RuleCondition): string[] {
    if (Array.isArray(condition.value)) return condition.value;
    return condition.value ? [String(condition.value)] : [];
  }

  return (
    <Form method="post">
      <input type="hidden" name="intent" value="save" />
      <input type="hidden" name="conditions" value={JSON.stringify(conditions)} />
      <input type="hidden" name="gifts" value={JSON.stringify(gifts)} />

      <s-page heading={title}>
        <s-link slot="breadcrumb-actions" href="/app/rules">
          Rules
        </s-link>
        <s-button
          slot="primary-action"
          type="submit"
          variant="primary"
          disabled={busy || !gifts.length}
        >
          {busy ? "Saving…" : "Save rule"}
        </s-button>
        <s-button slot="secondary-actions" onClick={() => navigate("/app/rules")}>
          Cancel
        </s-button>

        {actionData?.error && (
          <s-banner heading="Couldn't save this rule" tone="critical">
            <s-paragraph>{actionData.error}</s-paragraph>
          </s-banner>
        )}

        <s-section heading="Rule details">
          <s-stack direction="block" gap="base">
            <s-paragraph color="subdued">
              Name this promotion so your team can find it later.
            </s-paragraph>
            <s-grid gap="base">
              <s-text-field
                label="Rule name"
                name="name"
                value={value.name}
                placeholder="VIP cart gift"
                required
              ></s-text-field>
              <s-text-area
                label="Description"
                name="description"
                value={value.description ?? ""}
                placeholder="Internal note (optional)"
              ></s-text-area>
            </s-grid>
          </s-stack>
        </s-section>

        <s-section heading="Eligibility conditions">
          <s-stack direction="block" gap="base">
            <s-paragraph color="subdued">
              Choose whether every condition or any condition must match.
            </s-paragraph>
            <s-select
              label="Match mode"
              name="matchMode"
              value={value.matchMode}
            >
              <s-option value="ALL">Match all conditions (AND)</s-option>
              <s-option value="ANY">Match any condition (OR)</s-option>
            </s-select>

            {conditions.length > 0 && (
              <s-stack direction="block" gap="base">
                {conditions.map((condition, index) => {
                  const kind = conditionKind(condition.field);
                  const isResourceField =
                    kind === "product" || kind === "variant" || kind === "collection";
                  const resourceNoun =
                    kind === "product"
                      ? "products"
                      : kind === "variant"
                        ? "variants"
                        : "collections";
                  return (
                    <s-box
                      key={condition.id ?? index}
                      padding="base"
                      background="subdued"
                      borderRadius="base"
                    >
                      <s-grid
                        gridTemplateColumns={CONDITION_GRID}
                        gap="base"
                        alignItems="start"
                      >
                        <s-select
                          label="Field"
                          labelAccessibilityVisibility="exclusive"
                          value={condition.field}
                          onChange={(event: any) => {
                            const nextField = event.target
                              .value as RuleCondition["field"];
                            // A value/operator picked for the old field type
                            // never means anything for the new one (a number
                            // like "50" isn't a vendor name, "At least" isn't a
                            // valid comparison for a boolean), so both are reset
                            // to sensible defaults for whatever kind of field
                            // was just selected, rather than carried over.
                            updateCondition(index, {
                              field: nextField,
                              ...defaultValueAndOperator(conditionKind(nextField)),
                            });
                          }}
                        >
                          {fields.map(([id, label]) => (
                            <s-option value={id} key={id}>
                              {label}
                            </s-option>
                          ))}
                        </s-select>

                        {isResourceField ? (
                          <div style={{ gridColumn: "2 / span 2" }}>
                            <s-stack direction="block" gap="small-300">
                              <div
                                style={{
                                  display: "flex",
                                  flexWrap: "wrap",
                                  gap: "8px",
                                }}
                              >
                                {conditionValueIds(condition).length ? (
                                  conditionValueIds(condition).map((id) => (
                                    <s-chip key={id} color="strong">
                                      {conditionLabels[id] ?? id}
                                    </s-chip>
                                  ))
                                ) : (
                                  <s-text color="subdued">
                                    No {resourceNoun} selected
                                  </s-text>
                                )}
                              </div>
                              <s-button
                                onClick={() =>
                                  pickConditionResource(index, condition.field)
                                }
                              >
                                Pick {resourceNoun}
                              </s-button>
                            </s-stack>
                          </div>
                        ) : kind === "boolean" ? (
                          <div style={{ gridColumn: "2 / span 2" }}>
                            <s-select
                              label="Value"
                              labelAccessibilityVisibility="exclusive"
                              value={String(condition.value)}
                              onChange={(event: any) =>
                                updateCondition(index, {
                                  value: event.target.value,
                                  operator: "equals",
                                })
                              }
                            >
                              <s-option value="true">Logged in</s-option>
                              <s-option value="false">Guest checkout</s-option>
                            </s-select>
                          </div>
                        ) : (
                          <>
                            <s-select
                              label="Operator"
                              labelAccessibilityVisibility="exclusive"
                              value={condition.operator}
                              onChange={(event: any) =>
                                updateCondition(index, {
                                  operator: event.target
                                    .value as RuleCondition["operator"],
                                })
                              }
                            >
                              {(kind === "numeric"
                                ? numericOperators
                                : textOperators
                              ).map(([id, label]) => (
                                <s-option value={id} key={id}>
                                  {label}
                                </s-option>
                              ))}
                            </s-select>
                            {kind === "numeric" ? (
                              <s-number-field
                                label="Value"
                                labelAccessibilityVisibility="exclusive"
                                value={String(condition.value)}
                                onChange={(event: any) =>
                                  updateCondition(index, {
                                    value: event.target.value,
                                  })
                                }
                                placeholder="0"
                              ></s-number-field>
                            ) : (
                              <s-text-field
                                label="Value"
                                labelAccessibilityVisibility="exclusive"
                                value={String(condition.value)}
                                onChange={(event: any) =>
                                  updateCondition(index, {
                                    value: event.target.value,
                                  })
                                }
                                placeholder={
                                  fieldPlaceholders[condition.field] ?? "Value"
                                }
                              ></s-text-field>
                            )}
                          </>
                        )}

                        <s-button
                          icon="delete"
                          accessibilityLabel="Remove condition"
                          tone="critical"
                          variant="tertiary"
                          onClick={() =>
                            setConditions((current) =>
                              current.filter((_, itemIndex) => itemIndex !== index),
                            )
                          }
                        ></s-button>
                      </s-grid>
                    </s-box>
                  );
                })}
              </s-stack>
            )}

            <div>
              <s-button
                icon="plus"
                accessibilityLabel="Add condition"
                onClick={() =>
                  setConditions((current) => [
                    ...current,
                    {
                      id: crypto.randomUUID(),
                      field: "subtotal",
                      operator: "greater_or_equal",
                      value: "50",
                    },
                  ])
                }
              >
                Add condition
              </s-button>
            </div>
          </s-stack>
        </s-section>

        <s-section heading="Free gift products">
          <s-stack direction="block" gap="base">
            <s-stack direction="inline" gap="base" alignItems="start" justifyContent="space-between">
              <s-paragraph color="subdued">
                One or several variants can be added automatically.
              </s-paragraph>
              <s-button onClick={pickGifts}>Select products</s-button>
            </s-stack>

            <s-box padding="base" background="subdued" borderRadius="base">
              <s-stack direction="block" gap="base">
                <s-stack direction="inline" gap="base" alignItems="center">
                  <s-icon type="gift-card" tone="auto"></s-icon>
                  <s-stack direction="block" gap="small-100">
                    <s-text type="strong">{giftLabel}</s-text>
                    <s-text color="subdued">
                      Products are protected by the checkout discount function.
                    </s-text>
                  </s-stack>
                </s-stack>
                {gifts.some((gift) => gift.imageUrl) && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
                    {gifts
                      .filter((gift) => gift.imageUrl)
                      .map((gift) => (
                        <s-thumbnail
                          key={gift.variantId}
                          src={gift.imageUrl}
                          alt={gift.productTitle ?? "Product"}
                          size="small"
                        ></s-thumbnail>
                      ))}
                  </div>
                )}
              </s-stack>
            </s-box>

            {gifts.length > 0 && (
              <s-stack direction="block" gap="base">
                {gifts.map((gift, index) => (
                  <s-box
                    key={gift.variantId}
                    padding="base"
                    border="base"
                    borderRadius="base"
                  >
                    <s-stack direction="block" gap="small-300">
                      <s-grid gridTemplateColumns="auto 1fr auto" gap="base" alignItems="center">
                        {gift.imageUrl ? (
                          <s-thumbnail src={gift.imageUrl} alt={gift.productTitle ?? "Product"} size="small"></s-thumbnail>
                        ) : (
                          <s-box padding="small-300" background="subdued" borderRadius="base">
                            <s-icon type="product" tone="auto"></s-icon>
                          </s-box>
                        )}
                        <s-stack direction="block" gap="small-500">
                          <s-text type="strong">{gift.productTitle}</s-text>
                          {meaningfulVariantTitle(gift.productTitle, gift.variantTitle) ? (
                            <s-text color="subdued">
                              {meaningfulVariantTitle(gift.productTitle, gift.variantTitle)}
                            </s-text>
                          ) : null}
                        </s-stack>
                        <s-button
                          icon="delete"
                          accessibilityLabel="Remove gift"
                          tone="critical"
                          variant="tertiary"
                          onClick={() =>
                            setGifts((current) =>
                              current.filter((_, itemIndex) => itemIndex !== index),
                            )
                          }
                        ></s-button>
                      </s-grid>
                      <s-grid gridTemplateColumns="80px 1fr 1fr" gap="base">
                        <s-number-field
                          label="Qty"
                          min={1}
                          value={String(gift.quantity ?? 1)}
                          onChange={(event: any) =>
                            setGifts((current) =>
                              current.map((item, itemIndex) =>
                                itemIndex === index
                                  ? {
                                      ...item,
                                      quantity: Math.max(
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
                          label="Discount type"
                          value={gift.discountType ?? "FREE"}
                          onChange={(event: any) =>
                            setGifts((current) =>
                              current.map((item, itemIndex) =>
                                itemIndex === index
                                  ? {
                                      ...item,
                                      discountType: event.target.value as any,
                                      discountValue:
                                        event.target.value === "FREE"
                                          ? 100
                                          : item.discountValue ?? 10,
                                    }
                                  : item,
                              ),
                            )
                          }
                        >
                          <s-option value="FREE">Free (100% off)</s-option>
                          <s-option value="PERCENT_OFF">Percent off (%)</s-option>
                          <s-option value="FIXED_OFF">Fixed amount off ($)</s-option>
                        </s-select>
                        <s-number-field
                          label="Value"
                          min={0}
                          step={0.01}
                          disabled={!gift.discountType || gift.discountType === "FREE"}
                          value={String(gift.discountValue ?? 10)}
                          onChange={(event: any) =>
                            setGifts((current) =>
                              current.map((item, itemIndex) =>
                                itemIndex === index
                                  ? {
                                      ...item,
                                      discountValue: Math.max(
                                        0,
                                        Number(event.target.value),
                                      ),
                                    }
                                  : item,
                              ),
                            )
                          }
                        ></s-number-field>
                      </s-grid>
                    </s-stack>
                  </s-box>
                ))}
              </s-stack>
            )}
          </s-stack>
        </s-section>

        <s-section heading="Customer restrictions">
          <s-stack direction="block" gap="base">
            <s-paragraph color="subdued">
              Optional limits are verified again when an order is created.
            </s-paragraph>
            <s-grid gridTemplateColumns="1fr 1fr 1fr" gap="base">
              <s-checkbox
                label="One gift per order"
                name="onePerOrder"
                defaultChecked={value.restrictions.onePerOrder}
              ></s-checkbox>
              <s-checkbox
                label="One gift per customer"
                name="onePerCustomer"
                defaultChecked={value.restrictions.onePerCustomer}
              ></s-checkbox>
              <s-checkbox
                label="First purchase only"
                name="firstPurchaseOnly"
                defaultChecked={value.restrictions.firstPurchaseOnly}
              ></s-checkbox>
            </s-grid>
            <s-grid gridTemplateColumns="1fr 1fr" gap="base">
              <s-text-field
                label="Allowed customer tags"
                name="allowedCustomerTags"
                value={value.restrictions.allowedCustomerTags?.join(", ") ?? ""}
                placeholder="VIP, wholesale"
              ></s-text-field>
              <s-text-field
                label="Excluded customer tags"
                name="excludedCustomerTags"
                value={value.restrictions.excludedCustomerTags?.join(", ") ?? ""}
                placeholder="no-gifts"
              ></s-text-field>
            </s-grid>
          </s-stack>
        </s-section>

        <s-section slot="aside" heading="Status & priority">
          <s-stack direction="block" gap="base">
            <s-switch
              label="Rule enabled"
              details="Apply this promotion on the storefront"
              name="enabled"
              defaultChecked={value.enabled}
            ></s-switch>
            <s-switch
              label="Allow multiple gifts"
              details="Use several selected gifts"
              name="allowMultiple"
              defaultChecked={value.allowMultiple}
            ></s-switch>
            <s-switch
              label="Stack with other rules"
              details="Allow lower-priority rules too"
              name="stackable"
              defaultChecked={value.stackable}
            ></s-switch>
            <s-number-field
              label="Priority (lower runs first)"
              min={1}
              name="priority"
              value={String(value.priority)}
            ></s-number-field>
            <s-number-field
              label="Maximum gifts from this rule"
              min={1}
              name="maxGifts"
              value={String(value.maxGifts)}
            ></s-number-field>
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
            <s-text-area
              label="Storefront message"
              name="notification"
              value={
                value.notification ??
                "🎁 A free gift has been added to your cart."
              }
            ></s-text-area>
          </s-stack>
        </s-section>
      </s-page>
    </Form>
  );
}
