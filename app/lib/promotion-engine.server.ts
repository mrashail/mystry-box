import { createHash, createHmac, randomInt, randomUUID } from "node:crypto";
import type { GiftRule, MysteryBox, MysteryBoxChild } from "@prisma/client";
import prisma from "../db.server";
import type {
  BogoConfiguration,
  CartEvaluation,
  CartLineSnapshot,
  CartMutation,
  CartSnapshot,
  CustomerRestrictions,
  GiftChoice,
  MatchingRule,
  PriceTier,
  RuleCondition,
} from "./promotions.types";

type BoxWithChildren = MysteryBox & { children: MysteryBoxChild[] };

export function numericShopifyId(id: string | number | null | undefined) {
  if (id === null || id === undefined) return "";
  return String(id).split("/").pop() ?? String(id);
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

export function promotionSignature(
  secret: string,
  variantId: string,
  kind: string,
  promotionId: string,
  details = "",
) {
  const payload = [numericShopifyId(variantId), kind, promotionId, details]
    .filter(Boolean)
    .join("|");
  return createHmac("sha256", secret).update(payload).digest("hex");
}

function normalized(value: unknown) {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

function compare(
  actual: unknown,
  operator: RuleCondition["operator"],
  expected: unknown,
) {
  const actualNumber = Number(actual);
  const expectedNumber = Number(expected);
  const bothNumbers =
    Number.isFinite(actualNumber) && Number.isFinite(expectedNumber);
  const left = normalized(actual);
  const right = normalized(expected);

  switch (operator) {
    case "equals":
      return bothNumbers ? actualNumber === expectedNumber : left === right;
    case "not_equals":
      return bothNumbers ? actualNumber !== expectedNumber : left !== right;
    case "greater_than":
      return actualNumber > expectedNumber;
    case "greater_or_equal":
      return actualNumber >= expectedNumber;
    case "less_than":
      return actualNumber < expectedNumber;
    case "less_or_equal":
      return actualNumber <= expectedNumber;
    case "contains":
      return left.includes(right);
    case "not_contains":
      return !left.includes(right);
    case "starts_with":
      return left.startsWith(right);
    case "ends_with":
      return left.endsWith(right);
    case "in":
      return asArray<unknown>(expected).some(
        (item) => normalized(item) === left,
      );
  }
}

function anyLine(
  lines: CartLineSnapshot[],
  read: (line: CartLineSnapshot) => unknown,
  condition: RuleCondition,
) {
  const expected = Array.isArray(condition.value)
    ? condition.value
    : [condition.value];
  return lines.some((line) => {
    const value = read(line);
    const actual = Array.isArray(value) ? value : [value];
    return actual.some((left) =>
      expected.some((right) => compare(left, condition.operator, right)),
    );
  });
}

export function conditionMatches(condition: RuleCondition, cart: CartSnapshot) {
  const purchasable = cart.lines.filter(
    (line) =>
      !line.properties?._mystery_box_reward &&
      !line.properties?._free_gift_rule,
  );
  const idCondition = {
    ...condition,
    value: Array.isArray(condition.value)
      ? condition.value.map(numericShopifyId)
      : numericShopifyId(condition.value as string | number),
  };
  switch (condition.field) {
    case "subtotal":
      return compare(
        purchasable.reduce(
          (sum, line) => sum + (line.finalPrice ?? line.price) * line.quantity,
          0,
        ) / 100,
        condition.operator,
        condition.value,
      );
    case "quantity":
      return compare(
        purchasable.reduce((sum, line) => sum + line.quantity, 0),
        condition.operator,
        condition.value,
      );
    case "distinct_products":
      return compare(
        new Set(purchasable.map((line) => line.productId)).size,
        condition.operator,
        condition.value,
      );
    case "product":
      return anyLine(
        purchasable,
        (line) => numericShopifyId(line.productId),
        idCondition,
      );
    case "variant":
      return anyLine(
        purchasable,
        (line) => numericShopifyId(line.variantId),
        idCondition,
      );
    case "sku":
      return anyLine(purchasable, (line) => line.sku, condition);
    case "product_tag":
      return anyLine(purchasable, (line) => line.tags ?? [], condition);
    case "vendor":
      return anyLine(purchasable, (line) => line.vendor, condition);
    case "product_type":
      return anyLine(purchasable, (line) => line.productType, condition);
    case "collection":
      return anyLine(
        purchasable,
        (line) => (line.collectionIds ?? []).map(numericShopifyId),
        idCondition,
      );
    case "customer_tag":
      return (cart.customer?.tags ?? []).some((tag) =>
        compare(tag, condition.operator, condition.value),
      );
    case "customer_logged_in":
      return compare(
        Boolean(cart.customer?.loggedIn),
        condition.operator,
        condition.value,
      );
    case "country":
      return compare(cart.country, condition.operator, condition.value);
    case "discount_code":
      return (cart.discountCodes ?? []).some((code) =>
        compare(code, condition.operator, condition.value),
      );
  }
}

export function activeBetween(startsAt: Date | null, endsAt: Date | null, now: Date) {
  return (!startsAt || startsAt <= now) && (!endsAt || endsAt >= now);
}

// Fields the checkout Function cannot independently re-verify. Two separate
// constraints force this list:
// - product_tag/customer_tag/collection: Shopify's Function input schema only
//   exposes tag/collection membership as static boolean predicates
//   (hasAnyTag/inAnyCollection) that must be compiled into the query ahead of
//   time, so a per-rule value can't be plugged in at runtime.
// - sku/vendor/product_type/customer_logged_in/country/discount_code: fetching
//   their live values would push the Function's input query past Shopify's
//   hard cap of 30 on calculated query cost
//   (shopify.dev/docs/api/functions/latest#input-query-limits) once combined
//   with the fields this fix already needs.
// Any rule using one of these is left unverifiable — the Function falls back
// to trusting the signature alone, same as before this fix.
const UNVERIFIABLE_CONDITION_FIELDS = new Set<RuleCondition["field"]>([
  "product_tag",
  "customer_tag",
  "collection",
  "sku",
  "vendor",
  "product_type",
  "customer_logged_in",
  "country",
  "discount_code",
]);

// Serializes a rule's conditions into a compact string the checkout Function
// can re-evaluate against the live cart, so a shopper who strips the
// triggering product from the cart and jumps straight to checkout (bypassing
// the storefront JS that would otherwise remove the gift) doesn't still get
// the discount. Signed alongside the rest of the line's properties.
export function encodeConditionsForFunction(
  matchMode: string,
  conditions: RuleCondition[],
) {
  if (conditions.some((condition) => UNVERIFIABLE_CONDITION_FIELDS.has(condition.field)))
    return { blob: "", unverifiable: true };
  const encoded = conditions
    .map((condition) => {
      const values = Array.isArray(condition.value)
        ? condition.value
        : [condition.value];
      return `${condition.field}::${condition.operator}::${values.map((value) => numericShopifyId(value as string) || String(value)).join("||")}`;
    })
    .join("~~");
  return { blob: `${matchMode}|${encoded}`, unverifiable: false };
}

export function restrictionsMatch(
  restrictions: CustomerRestrictions,
  cart: CartSnapshot,
) {
  const tags = (cart.customer?.tags ?? []).map(normalized);
  if (restrictions.firstPurchaseOnly && (cart.customer?.orderCount ?? 0) > 0)
    return false;
  if (
    restrictions.allowedCustomerTags?.length &&
    !restrictions.allowedCustomerTags.some((tag) =>
      tags.includes(normalized(tag)),
    )
  )
    return false;
  if (
    restrictions.excludedCustomerTags?.some((tag) =>
      tags.includes(normalized(tag)),
    )
  )
    return false;
  return true;
}

export function giftRuleMatches(
  rule: GiftRule,
  cart: CartSnapshot,
  now = new Date(),
) {
  if (!rule.enabled || !activeBetween(rule.startsAt, rule.endsAt, now))
    return false;
  if (
    !restrictionsMatch(
      (rule.restrictions ?? {}) as unknown as CustomerRestrictions,
      cart,
    )
  )
    return false;
  const conditions = asArray<RuleCondition>(rule.conditions);
  if (!conditions.length) return true;
  return rule.matchMode === "ANY"
    ? conditions.some((condition) => conditionMatches(condition, cart))
    : conditions.every((condition) => conditionMatches(condition, cart));
}

// Cart attribute holding the comma-separated ids of gift rules the shopper
// has explicitly declined (by deleting the gift line themselves) while the
// rule still qualifies. Without this, every cart mutation re-evaluates from
// scratch — sees the qualifying purchase still in the cart, sees the gift
// line missing because the shopper just removed it — and adds it straight
// back, making the gift impossible to actually remove. A cart attribute
// (rather than a client-only in-memory flag) is what lets this survive page
// reloads and stays visible to this server-side path too.
export const GIFTLAB_DECLINED_GIFTS_ATTRIBUTE = "_giftlab_declined_gifts";

function parseDeclinedGiftIds(cart: CartSnapshot): Set<string> {
  const raw = cart.attributes?.[GIFTLAB_DECLINED_GIFTS_ATTRIBUTE] ?? "";
  return new Set(
    raw
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
}

export function desiredGiftMutations(
  rules: GiftRule[],
  cart: CartSnapshot,
  secret: string,
  conflictStrategy: string,
) {
  const mutations: CartMutation[] = [];
  const matchedIds: string[] = [];
  const messages: string[] = [];
  const matched = rules.filter((rule) => giftRuleMatches(rule, cart));
  const effective =
    conflictStrategy === "FIRST_MATCH"
      ? matched.slice(0, 1)
      : conflictStrategy === "STACK_ALL"
        ? matched
        : matched.some((rule) => !rule.stackable)
          ? matched.slice(0, 1)
          : matched;

  const declinedIds = parseDeclinedGiftIds(cart);

  for (const rule of effective) {
    matchedIds.push(rule.id);
    // Respect an explicit decline: the condition still matches, but the
    // shopper already said no to this exact gift, so don't re-add it or
    // re-announce it. It stays declined only while the rule keeps matching —
    // see the stale-decline cleanup below.
    if (declinedIds.has(rule.id)) continue;
    const restrictions = (rule.restrictions ??
      {}) as unknown as CustomerRestrictions;
    const configured = asArray<GiftChoice>(rule.gifts);
    const chosen = restrictions.onePerOrder
      ? configured.slice(0, 1)
      : rule.allowMultiple
        ? configured.slice(0, rule.maxGifts)
        : configured.slice(0, 1);
    const { blob: conditionsBlob, unverifiable } = encodeConditionsForFunction(
      rule.matchMode,
      asArray<RuleCondition>(rule.conditions),
    );
    for (const gift of chosen) {
      const variantId = numericShopifyId(gift.variantId);
      const desiredQuantity = restrictions.onePerOrder
        ? 1
        : Math.max(1, gift.quantity ?? 1);
      const current = cart.lines.find(
        (line) =>
          line.properties?._free_gift_rule === rule.id &&
          numericShopifyId(line.variantId) === variantId,
      );
      const discountType = gift.discountType ?? "FREE";
      const discountValue = gift.discountValue ?? 100.0;
      const properties: Record<string, string> = {
        _free_gift_rule: rule.id,
        _promotion_kind: "free_gift",
        _free_gift_discount_type: discountType,
        _free_gift_discount_value: String(discountValue),
        // The awarded quantity is bound into the signature so a shopper can't
        // raise the gift line's quantity via the cart AJAX API (which keeps
        // the signed properties) and have the checkout Function discount all
        // of the inflated units — the Function only discounts this many.
        _free_gift_qty: String(desiredQuantity),
        _free_gift_name: rule.name,
        ...(unverifiable
          ? { _free_gift_unverifiable: "true" }
          : { _free_gift_conditions: conditionsBlob }),
        _promotion_signature: promotionSignature(
          secret,
          variantId,
          "free_gift_discount",
          rule.id,
          `${discountType}|${discountValue}|${desiredQuantity}|${unverifiable ? "UNVERIFIABLE" : conditionsBlob}`,
        ),
        "Free gift": rule.name,
      };
      if (!current) {
        mutations.push({
          type: "ADD",
          variantId,
          quantity: desiredQuantity,
          properties,
        });
      } else if (
        current.quantity !== desiredQuantity ||
        current.properties?._promotion_signature !==
          properties._promotion_signature
      ) {
        mutations.push({
          type: "CHANGE",
          lineKey: current.key,
          quantity: desiredQuantity,
          properties: {
            ...Object.fromEntries(
              Object.entries(current.properties ?? {}).filter(
                (entry): entry is [string, string] => entry[1] !== null,
              ),
            ),
            ...properties,
          },
        });
      }
    }
    if (rule.notification) messages.push(rule.notification);
  }

  for (const line of cart.lines.filter(
    (item) => item.properties?._free_gift_rule,
  )) {
    if (
      !effective.some((rule) => rule.id === line.properties?._free_gift_rule)
    ) {
      mutations.push({ type: "CHANGE", lineKey: line.key, quantity: 0 });
    }
  }

  // A decline only holds while its rule's condition keeps matching. The
  // moment the cart no longer qualifies at all, forget it — a later,
  // independent qualification is a fresh offer, not a re-add of something
  // already declined.
  const matchedIdSet = new Set(matched.map((rule) => rule.id));
  const staleDeclines = [...declinedIds].filter((id) => !matchedIdSet.has(id));
  if (staleDeclines.length) {
    const remaining = new Set(declinedIds);
    staleDeclines.forEach((id) => remaining.delete(id));
    mutations.push({
      type: "ATTRIBUTES",
      attributes: {
        ...cart.attributes,
        [GIFTLAB_DECLINED_GIFTS_ATTRIBUTE]: [...remaining].join(","),
      },
      silent: true,
    });
  }

  return { mutations, matchedIds, messages };
}

function matchingDynamicChild(
  child: { variantTitle: string; sku: string | null },
  rules: MatchingRule[],
) {
  if (!rules.length) return false;
  return rules.every((rule) => {
    const actual = normalized(
      rule.field === "sku" ? child.sku : child.variantTitle,
    );
    const value = normalized(rule.value);
    if (rule.operator === "starts_with") return actual.startsWith(value);
    if (rule.operator === "ends_with") return actual.endsWith(value);
    return actual.includes(value);
  });
}

function chooseWeighted<T extends { weight?: number }>(items: T[]) {
  const total = items.reduce(
    (sum, item) => sum + Math.max(1, item.weight ?? 1),
    0,
  );
  let ticket = randomInt(Math.max(1, total));
  for (const item of items) {
    ticket -= Math.max(1, item.weight ?? 1);
    if (ticket < 0) return item;
  }
  return items[0];
}

export function pickChildren(
  box: BoxWithChildren,
  count: number,
  customPool?: MysteryBoxChild[],
  overrideMethod?: string,
  excludeVariantIds?: Set<string>,
) {
  let candidates = (customPool || box.children).filter((child) => {
    if (box.inventoryBehavior === "IGNORE") return true;
    if (box.inventoryBehavior === "SKIP_UNAVAILABLE") return child.available;
    return (
      child.available &&
      (child.inventoryQuantity === null || child.inventoryQuantity > 0)
    );
  });
  if (!candidates.length && box.inventoryBehavior === "NEXT_AVAILABLE") {
    candidates = (customPool || box.children).filter((child) => child.available);
  }
  if (!candidates.length) return [];

  // Prefer variants this customer hasn't already been shipped before. If
  // their history covers the whole (or most of the) pool, fall back to the
  // full candidate list rather than picking nothing — a repeat is better
  // than no mystery box contents at all.
  if (excludeVariantIds?.size) {
    const unseen = candidates.filter(
      (child) => !excludeVariantIds.has(numericShopifyId(child.variantId)),
    );
    if (unseen.length) candidates = unseen;
  }

  const method = overrideMethod || box.selectionMethod;
  const selected: MysteryBoxChild[] = [];
  for (let index = 0; index < count; index += 1) {
    let child: MysteryBoxChild;
    if (method === "SEQUENTIAL" || method === "ROUND_ROBIN") {
      // Walk the full candidate list from the persisted cursor, taking
      // consecutive items. Indexing the whole list (not a pool that shrinks
      // as items are picked) is what keeps the sequence contiguous —
      // A,B,C… — instead of skipping every other entry, and because
      // `candidates` has no duplicate variants, consecutive indices are
      // already distinct until the list wraps.
      if (!candidates.length) break;
      child = candidates[(box.cursor + index) % candidates.length];
    } else {
      // Random / weighted / inventory-ranked: draw from a pool that excludes
      // what's already been picked this round (unless duplicates are allowed),
      // so the same variant isn't chosen twice.
      const pool = box.allowDuplicateChoices
        ? candidates
        : candidates.filter(
            (candidate) =>
              !selected.some((item) => item.variantId === candidate.variantId),
          );
      if (!pool.length) break;
      if (method === "WEIGHTED") child = chooseWeighted(pool);
      else if (method === "HIGHEST_INVENTORY")
        child = [...pool].sort(
          (a, b) => (b.inventoryQuantity ?? 0) - (a.inventoryQuantity ?? 0),
        )[0];
      else if (method === "LOWEST_INVENTORY")
        child = [...pool].sort(
          (a, b) => (a.inventoryQuantity ?? 0) - (b.inventoryQuantity ?? 0),
        )[0];
      else child = pool[randomInt(pool.length)];
    }
    selected.push(child);
  }
  return selected;
}

export function priceTierForQuantity(tiers: PriceTier[], quantity: number) {
  return (
    [...tiers]
      .filter((tier) => tier.minQuantity <= quantity)
      .sort((a, b) => b.minQuantity - a.minQuantity)[0] ?? null
  );
}

function bogoRewardCount(config: BogoConfiguration, purchasedQuantity: number) {
  if (!config.enabled) return 0;
  const buy = Math.max(1, config.buyQuantity ?? 1);
  return (
    Math.floor(purchasedQuantity / buy) * Math.max(1, config.freeQuantity ?? 1)
  );
}

async function mysteryMutations(
  shop: string,
  boxes: BoxWithChildren[],
  cart: CartSnapshot,
  secret: string,
  catalogByVariant: Map<string, any>,
  customerHistory: Map<string, Set<string>> = new Map(),
) {
  const mutations: CartMutation[] = [];
  const matchedIds: string[] = [];
  const messages: string[] = [];
  const claimedParentLines = new Set<string>();
  const now = new Date();
  const activeBoxes = boxes.filter(
    (box) =>
      box.enabled &&
      activeBetween(box.startsAt, box.endsAt, now) &&
      restrictionsMatch(
        (box.restrictions ?? {}) as unknown as CustomerRestrictions,
        cart,
      ),
  );

  // Merchant-facing label for every possible child variant, so the hidden order
  // note can record what was selected without revealing it to the shopper.
  const childLabel = new Map<string, string>();
  for (const box of activeBoxes) {
    for (const child of box.children) {
      childLabel.set(
        numericShopifyId(child.variantId),
        child.variantTitle && child.variantTitle !== "Default Title"
          ? `${child.productTitle} — ${child.variantTitle}`
          : child.productTitle,
      );
    }
  }

  const contentsOf = (ids: string[]) =>
    ids
      .map((id) => {
        const numId = numericShopifyId(id);
        const childLabelVal = childLabel.get(numId);
        if (childLabelVal) return childLabelVal;

        const catalog = catalogByVariant.get(numId);
        if (catalog) {
          return catalog.variantTitle && catalog.variantTitle !== "Default Title"
            ? `${catalog.productTitle} — ${catalog.variantTitle}`
            : catalog.productTitle;
        }
        return numId;
      })
      .join(", ");

  // Desired visible lines, keyed so the same box always reconciles to the same
  // line: "<boxId>:paid" for the box the shopper is charged for, and
  // "<boxId>:bonus:<sourceBoxId>" for a BOGO-earned free box (which may be a
  // different box's own product when the reward pool differs).
  const desiredLines = new Map<
    string,
    { variantId: string; quantity: number; properties: Record<string, string> }
  >();
  // For a standard (non-BOGO) box, the shopper adds the box's own product
  // directly — there is no separate "trigger" line, so the raw line they just
  // added *is* the line that needs the hidden pick attached. Tracking it here
  // means the reconcile loop below updates that exact line in place instead
  // of failing to recognize it (it has no _mystery_box_id yet) and adding a
  // second, duplicate line for the same box.
  const desiredLineTargets = new Map<string, CartLineSnapshot>();

  for (const box of activeBoxes) {
    if (!box.boxVariantId) continue;
    const parentLines = cart.lines.filter(
      (line) =>
        !line.properties?._mystery_box_reward &&
        !line.properties?._free_gift_rule &&
        // A standard box's "trigger" and its own managed paid line are the
        // same product, so a line already tagged for *this* box (from an
        // earlier evaluation) still counts as its parent line — otherwise it
        // would stop being recognized on the very next cart evaluation and
        // get treated as stale. A line tagged for a *different* box/reward
        // never qualifies.
        (!line.properties?._mystery_box_id ||
          line.properties._mystery_box_id === box.id) &&
        !claimedParentLines.has(line.key) &&
        (numericShopifyId(line.productId) ===
          numericShopifyId(box.parentProductId) ||
          (box.parentVariantId &&
            numericShopifyId(line.variantId) ===
              numericShopifyId(box.parentVariantId))),
    );
    if (!parentLines.length) {
      // The box was removed from the cart. Its earlier hidden pick(s) are
      // keyed only by (cart.token, box.id, variant), which survives the
      // removal — so re-adding the same box to the same cart later found the
      // old MysterySelection row and reused the exact same item every time
      // instead of rolling again. Clear it now so a future re-add starts
      // fresh.
      await prisma.mysterySelection.deleteMany({
        where: { shop, cartToken: cart.token, mysteryBoxId: box.id, status: "CART" },
      });
      continue;
    }
    parentLines.forEach((line) => claimedParentLines.add(line.key));
    matchedIds.push(box.id);
    const boxRestrictions = (box.restrictions ??
      {}) as unknown as CustomerRestrictions;
    const totalParentQuantity = parentLines.reduce(
      (sum, line) => sum + line.quantity,
      0,
    );
    const tier = priceTierForQuantity(
      asArray<PriceTier>(box.priceTiers),
      totalParentQuantity,
    );
    const bogo = box.bogo as unknown as BogoConfiguration;
    const targetBox =
      bogo.target === "DIFFERENT_BOX" && bogo.targetBoxId
        ? activeBoxes.find((item) => item.id === bogo.targetBoxId)
        : box;

    const paidTokens: string[] = [];
    const paidPicks: string[] = [];
    const bonusTokens: string[] = [];
    const bonusPicks: string[] = [];
    let bonusQuantity = 0;

    for (const parent of parentLines) {
      const parentToken = createHash("sha256")
        .update(`${cart.token}|${box.id}|${numericShopifyId(parent.variantId)}`)
        .digest("hex")
        .slice(0, 20);
      paidTokens.push(parentToken);

      const existing = await prisma.mysterySelection.findUnique({
        where: {
          shop_cartToken_parentLineKey_mysteryBoxId: {
            shop,
            cartToken: cart.token,
            parentLineKey: parentToken,
            mysteryBoxId: box.id,
          },
        },
      });
      const rewardCount = bogoRewardCount(bogo, parent.quantity);
      // When "one per order" caps the visible/charged box to a single unit,
      // only one box's worth of hidden contents must be picked — multiplying
      // by the full parent quantity here would record (and ship) N items for
      // the one box the shopper actually pays for.
      const effectiveParentQty = boxRestrictions.onePerOrder
        ? Math.min(1, parent.quantity)
        : parent.quantity;
      const baseCount = !bogo.enabled
        ? Math.max(1, box.selectionCount) * effectiveParentQty
        : 0;
      const shouldReselect =
        !existing || existing.selectionQuantity !== parent.quantity;
      const boxIsSequential =
        box.selectionMethod === "SEQUENTIAL" ||
        box.selectionMethod === "ROUND_ROBIN";

      let selectedIds: string[];
      let baseDrawn = 0;
      if (shouldReselect) {
        const basePicks = !bogo.enabled
          ? pickChildren(
              box,
              baseCount,
              box.children,
              undefined,
              customerHistory.get(box.id),
            )
          : [];
        const rewardPicks =
          rewardCount && targetBox
            ? pickChildren(
                targetBox,
                rewardCount,
                targetBox.children,
                bogo.randomizeGifts ? "RANDOM" : targetBox.selectionMethod,
                customerHistory.get(targetBox.id),
              )
            : [];
        baseDrawn = basePicks.length;
        selectedIds = [...basePicks, ...rewardPicks].map((child) => child.variantId);
      } else {
        selectedIds = asArray<string>(existing.selectedVariants);
      }

      if (!existing && selectedIds.length) {
        await prisma.mysterySelection.create({
          data: {
            shop,
            cartToken: cart.token,
            parentLineKey: parentToken,
            mysteryBoxId: box.id,
            selectedVariants: selectedIds,
            selectionQuantity: parent.quantity,
          },
        });
      } else if (existing && shouldReselect) {
        await prisma.mysterySelection.update({
          where: { id: existing.id },
          data: {
            selectedVariants: selectedIds,
            selectionQuantity: parent.quantity,
          },
        });
      }

      // Advance the sequential cursor whenever fresh base picks were actually
      // drawn — on first creation AND on a re-roll (quantity change). Only
      // incrementing on creation left the cursor frozen after any re-roll, so
      // the "sequential" rotation stalled and repeated the same items. Advance
      // by the number of base picks (not reward picks), keyed to this box.
      if (shouldReselect && boxIsSequential && baseDrawn > 0) {
        await prisma.mysteryBox.update({
          where: { id: box.id },
          data: { cursor: { increment: baseDrawn } },
        });
        box.cursor += baseDrawn;
      }

      if (!bogo.enabled) {
        paidPicks.push(...selectedIds.slice(0, baseCount));
      }
      const rewardPicks = !bogo.enabled ? selectedIds.slice(baseCount) : selectedIds;
      if (rewardPicks.length) {
        bonusTokens.push(parentToken);
        bonusPicks.push(...rewardPicks);
        bonusQuantity += rewardCount;
      }
    }

    // The paid box: the shopper is charged the box's own price (optionally
    // reduced by a quantity tier); the picked child(ren) stay hidden.
    if (!bogo.enabled) {
      // _promotion_kind/_promotion_signature are only ever read by the
      // checkout Function on this line when a price tier applies (its price
      // branch) — a plain box sold at its own flat price has nothing for the
      // Function to verify, so they're only attached inside the `if (tier)`
      // block below. Keeps a merchant's order view down to what's actually
      // meaningful (which box, what's hidden inside) instead of every
      // internal bookkeeping field the cart phase needed along the way.
      const paidProperties: Record<string, string> = {
        _mystery_box_id: box.id,
        _mystery_selection: paidPicks.map(numericShopifyId).join(","),
      };
      if (paidPicks.length) paidProperties._mystery_contents = contentsOf(paidPicks);
      if (tier) {
        // The quantity-tier discount only makes sense while the triggering
        // parent product is actually still in the cart, so the checkout
        // Function re-checks it independently before granting the discount.
        const triggerProductId = numericShopifyId(box.parentProductId);
        const triggerVariantId = box.parentVariantId
          ? numericShopifyId(box.parentVariantId)
          : "";
        paidProperties._mystery_price_type = tier.adjustmentType;
        paidProperties._mystery_price_value = String(tier.value);
        paidProperties._mystery_pricing_box = box.id;
        paidProperties._mystery_trigger_product_id = triggerProductId;
        paidProperties._mystery_trigger_variant_id = triggerVariantId;
        paidProperties._promotion_signature = promotionSignature(
          secret,
          box.boxVariantId,
          "price",
          box.id,
          `${tier.adjustmentType}|${tier.value}|${triggerProductId}|${triggerVariantId}`,
        );
      }
      desiredLines.set(`${box.id}:paid`, {
        variantId: box.boxVariantId,
        quantity: boxRestrictions.onePerOrder
          ? Math.min(1, totalParentQuantity)
          : totalParentQuantity,
        properties: paidProperties,
      });
      // The first raw parent line becomes the managed line in place; if the
      // shopper's units ended up split across more than one raw line (e.g.
      // two separate add-to-cart calls before Shopify merged them), fold the
      // rest into it rather than leaving duplicate box lines behind.
      desiredLineTargets.set(`${box.id}:paid`, parentLines[0]);
      for (const extra of parentLines.slice(1)) {
        mutations.push({ type: "CHANGE", lineKey: extra.key, quantity: 0 });
      }
    }

    // A BOGO-earned free box: same hidden-contents treatment, fully discounted
    // by the existing checkout function (same mechanism as free gifts). The
    // reward is only valid while the shopper still has the required quantity
    // of the triggering (source box's parent) product in the cart, so the
    // checkout Function re-checks that independently before granting it.
    if (bonusQuantity > 0 && targetBox?.boxVariantId) {
      const bogoLabel = bogo.freeQuantity
        ? `Buy ${bogo.buyQuantity || 1} Get ${bogo.freeQuantity} Free`
        : "Buy 1 Get 1 Free";
      const triggerProductId = numericShopifyId(box.parentProductId);
      const triggerVariantId = box.parentVariantId
        ? numericShopifyId(box.parentVariantId)
        : "";
      const triggerMinQty = String(Math.max(1, bogo.buyQuantity ?? 1));
      desiredLines.set(`${targetBox.id}:bonus:${box.id}`, {
        variantId: targetBox.boxVariantId,
        quantity: bonusQuantity,
        properties: {
          _mystery_box_id: targetBox.id,
          _mystery_source_box_id: box.id,
          _mystery_parent_tokens: bonusTokens.join(","),
          _mystery_selection: bonusPicks.map(numericShopifyId).join(","),
          _mystery_contents: contentsOf(bonusPicks),
          _mystery_box_reward: "true",
          _mystery_reward_name: bogoLabel,
          _mystery_trigger_product_id: triggerProductId,
          _mystery_trigger_variant_id: triggerVariantId,
          _mystery_trigger_min_qty: triggerMinQty,
          _promotion_kind: "mystery_box",
          _promotion_signature: promotionSignature(
            secret,
            targetBox.boxVariantId,
            "mystery_box_bonus",
            targetBox.id,
            `${triggerProductId}|${triggerVariantId}|${triggerMinQty}`,
          ),
        },
      });
    }
  }

  const lineKeyOf = (line: CartLineSnapshot) => {
    const boxId = line.properties?._mystery_box_id;
    if (!boxId) return null;
    return line.properties?._mystery_box_reward
      ? `${boxId}:bonus:${line.properties?._mystery_source_box_id}`
      : `${boxId}:paid`;
  };

  for (const [key, desired] of desiredLines) {
    const current =
      desiredLineTargets.get(key) ??
      cart.lines.find(
        (line) =>
          lineKeyOf(line) === key &&
          numericShopifyId(line.variantId) === numericShopifyId(desired.variantId),
      );
    if (!current) {
      mutations.push({
        type: "ADD",
        variantId: numericShopifyId(desired.variantId),
        quantity: desired.quantity,
        properties: desired.properties,
      });
    } else if (
      current.quantity !== desired.quantity ||
      current.properties?._promotion_signature !==
        desired.properties._promotion_signature ||
      // The paid-line signature only covers (box, kind, box id) — it never
      // changes with quantity, so a standard box being "converted in place"
      // (its own trigger line becomes the managed line) would otherwise look
      // unchanged even when the hidden pick genuinely needs to be redrawn
      // for a new quantity. Comparing the actual hidden selection catches it.
      current.properties?._mystery_selection !==
        desired.properties._mystery_selection
    ) {
      mutations.push({
        type: "CHANGE",
        lineKey: current.key,
        quantity: desired.quantity,
        properties: desired.properties,
      });
    }
  }

  // Remove any box line (paid or BOGO-bonus) that no longer has a matching
  // desired entry — the parent was removed, the box was disabled, or the BOGO
  // condition no longer qualifies.
  for (const line of cart.lines.filter((item) => item.properties?._mystery_box_id)) {
    const key = lineKeyOf(line);
    if (!key || !desiredLines.has(key)) {
      mutations.push({ type: "CHANGE", lineKey: line.key, quantity: 0 });
    }
  }

  return { mutations, matchedIds, messages };
}

// Mystery-box-only evaluation, deliberately separate from evaluateCart (which
// also computes free-gift mutations). The storefront client already owns the
// entire free-gift decision locally (conditions, decline-tracking, priority/
// stacking) and must never have that overridden or duplicated by a mixed
// server response — so this path returns ONLY mystery mutations, called
// solely to attach/refresh the hidden random pick on a mystery box line,
// which genuinely requires the server (randomness, inventory, per-customer
// history, and the persisted MysterySelection roll all live here only).
export async function evaluateMysteryOnly(
  shop: string,
  cart: CartSnapshot,
): Promise<{ mutations: CartMutation[]; messages: string[]; matchedMysteryBoxIds: string[] }> {
  const [settings, allBoxes, dynamicCatalog, priorUsage] = await Promise.all([
    prisma.shopSettings.upsert({ where: { shop }, update: {}, create: { shop } }),
    prisma.mysteryBox.findMany({
      where: { shop, enabled: true },
      include: { children: { orderBy: { position: "asc" } } },
      orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
    }),
    prisma.catalogVariant.findMany({ where: { shop } }),
    cart.customer?.id
      ? prisma.promotionUsage.findMany({
          where: { shop, customerId: cart.customer.id },
          select: { promotionType: true, promotionId: true },
        })
      : Promise.resolve([]),
  ]);
  if (!settings.storefrontEnabled)
    return { mutations: [], messages: [], matchedMysteryBoxIds: [] };
  let secret = settings.promotionSecret;
  if (!secret) {
    secret = randomUUID();
    await prisma.shopSettings.update({ where: { shop }, data: { promotionSecret: secret } });
  }

  const catalogByVariant = new Map(
    dynamicCatalog.map((item) => [numericShopifyId(item.variantId), item]),
  );
  cart.lines = cart.lines.map((line) => {
    const catalog = catalogByVariant.get(numericShopifyId(line.variantId));
    return catalog
      ? {
          ...line,
          sku: line.sku || catalog.sku || undefined,
          vendor: catalog.vendor || undefined,
          productType: catalog.productType || undefined,
          tags: asArray<string>(catalog.tags),
          collectionIds: asArray<string>(catalog.collectionIds),
        }
      : line;
  });

  const used = new Set(
    priorUsage.map((usage) => `${usage.promotionType}:${usage.promotionId}`),
  );
  const rawBoxes = allBoxes.filter((box) => {
    const restrictions = (box.restrictions ?? {}) as unknown as CustomerRestrictions;
    return !restrictions.onePerCustomer || !used.has(`MYSTERY:${box.id}`);
  });
  const boxes: BoxWithChildren[] = rawBoxes.map((box) => {
    const rules = asArray<MatchingRule>(box.matchingRules);
    if (!rules.length) return box;
    const known = new Set(box.children.map((child) => child.variantId));
    const dynamic = dynamicCatalog
      .filter(
        (child) =>
          !known.has(child.variantId) && matchingDynamicChild(child, rules),
      )
      .map((child, position) => ({
        id: `dynamic-${child.id}`,
        mysteryBoxId: box.id,
        productId: child.productId,
        productTitle: child.productTitle,
        variantId: child.variantId,
        variantTitle: child.variantTitle,
        sku: child.sku,
        imageUrl: child.imageUrl,
        inventoryQuantity: child.inventoryQuantity,
        available: child.available,
        weight: 1,
        position: box.children.length + position,
        createdAt: child.createdAt,
        updatedAt: child.updatedAt,
      }));
    return { ...box, children: [...box.children, ...dynamic] };
  });

  const customerHistory = new Map<string, Set<string>>();
  if (cart.customer?.id && boxes.length) {
    const historyRows = await prisma.mysteryCustomerHistory.findMany({
      where: {
        shop,
        customerId: cart.customer.id,
        mysteryBoxId: { in: boxes.map((box) => box.id) },
      },
      select: { mysteryBoxId: true, variantId: true },
    });
    for (const row of historyRows) {
      const set = customerHistory.get(row.mysteryBoxId) ?? new Set<string>();
      set.add(row.variantId);
      customerHistory.set(row.mysteryBoxId, set);
    }
  }
  const mystery = await mysteryMutations(shop, boxes, cart, secret, catalogByVariant, customerHistory);
  return { mutations: mystery.mutations, messages: mystery.messages, matchedMysteryBoxIds: mystery.matchedIds };
}

export async function evaluateCart(
  shop: string,
  cart: CartSnapshot,
): Promise<CartEvaluation> {
  const [settings, allRules, allBoxes, dynamicCatalog, priorUsage] =
    await Promise.all([
      prisma.shopSettings.upsert({
        where: { shop },
        update: {},
        create: { shop },
      }),
      prisma.giftRule.findMany({
        where: { shop, enabled: true },
        orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
      }),
      prisma.mysteryBox.findMany({
        where: { shop, enabled: true },
        include: { children: { orderBy: { position: "asc" } } },
        orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
      }),
      prisma.catalogVariant.findMany({ where: { shop } }),
      cart.customer?.id
        ? prisma.promotionUsage.findMany({
            where: { shop, customerId: cart.customer.id },
            select: { promotionType: true, promotionId: true },
          })
        : Promise.resolve([]),
    ]);
  if (!settings.storefrontEnabled)
    return {
      mutations: [],
      messages: [],
      matchedGiftRuleIds: [],
      matchedMysteryBoxIds: [],
      signature: "disabled",
    };
  let secret = settings.promotionSecret;
  if (!secret) {
    secret = randomUUID();
    await prisma.shopSettings.update({
      where: { shop },
      data: { promotionSecret: secret },
    });
  }

  const catalogByVariant = new Map(
    dynamicCatalog.map((item) => [numericShopifyId(item.variantId), item]),
  );
  cart.lines = cart.lines.map((line) => {
    const catalog = catalogByVariant.get(numericShopifyId(line.variantId));
    return catalog
      ? {
          ...line,
          sku: line.sku || catalog.sku || undefined,
          vendor: catalog.vendor || undefined,
          productType: catalog.productType || undefined,
          tags: asArray<string>(catalog.tags),
          collectionIds: asArray<string>(catalog.collectionIds),
        }
      : line;
  });

  const used = new Set(
    priorUsage.map((usage) => `${usage.promotionType}:${usage.promotionId}`),
  );
  const rules = allRules.filter((rule) => {
    const restrictions = (rule.restrictions ??
      {}) as unknown as CustomerRestrictions;
    return !restrictions.onePerCustomer || !used.has(`GIFT:${rule.id}`);
  });
  const rawBoxes = allBoxes.filter((box) => {
    const restrictions = (box.restrictions ??
      {}) as unknown as CustomerRestrictions;
    return !restrictions.onePerCustomer || !used.has(`MYSTERY:${box.id}`);
  });
  const boxes: BoxWithChildren[] = rawBoxes.map((box) => {
    const rules = asArray<MatchingRule>(box.matchingRules);
    if (!rules.length) return box;
    const known = new Set(box.children.map((child) => child.variantId));
    const dynamic = dynamicCatalog
      .filter(
        (child) =>
          !known.has(child.variantId) && matchingDynamicChild(child, rules),
      )
      .map((child, position) => ({
        id: `dynamic-${child.id}`,
        mysteryBoxId: box.id,
        productId: child.productId,
        productTitle: child.productTitle,
        variantId: child.variantId,
        variantTitle: child.variantTitle,
        sku: child.sku,
        imageUrl: child.imageUrl,
        inventoryQuantity: child.inventoryQuantity,
        available: child.available,
        weight: 1,
        position: box.children.length + position,
        createdAt: child.createdAt,
        updatedAt: child.updatedAt,
      }));
    return { ...box, children: [...box.children, ...dynamic] };
  });

  const gifts = desiredGiftMutations(
    rules,
    cart,
    secret,
    settings.conflictStrategy,
  );
  const customerHistory = new Map<string, Set<string>>();
  if (cart.customer?.id && boxes.length) {
    const historyRows = await prisma.mysteryCustomerHistory.findMany({
      where: {
        shop,
        customerId: cart.customer.id,
        mysteryBoxId: { in: boxes.map((box) => box.id) },
      },
      select: { mysteryBoxId: true, variantId: true },
    });
    for (const row of historyRows) {
      const set = customerHistory.get(row.mysteryBoxId) ?? new Set<string>();
      set.add(row.variantId);
      customerHistory.set(row.mysteryBoxId, set);
    }
  }
  const mystery = await mysteryMutations(shop, boxes, cart, secret, catalogByVariant, customerHistory);
  const planned = [...gifts.mutations, ...mystery.mutations];
  const mutations = [
    ...planned.filter((mutation) => mutation.type === "CHANGE"),
    ...planned.filter((mutation) => mutation.type === "ATTRIBUTES"),
    ...planned
      .filter((mutation) => mutation.type === "ADD")
      .slice(0, settings.maxAutomaticAdds),
  ];
  const signature = createHash("sha256")
    .update(JSON.stringify(mutations))
    .digest("hex")
    .slice(0, 16);
  return {
    mutations,
    messages: [...gifts.messages, ...mystery.messages],
    matchedGiftRuleIds: gifts.matchedIds,
    matchedMysteryBoxIds: mystery.matchedIds,
    signature,
  };
}
