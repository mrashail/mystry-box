import assert from "node:assert/strict";
import type { GiftRule, MysteryBox, MysteryBoxChild } from "@prisma/client";
import {
  conditionMatches,
  desiredGiftMutations,
  effectiveLinePrice,
  giftRuleMatches,
  pickChildren,
  priceTierForQuantity,
} from "./promotion-engine.server";
import type { CartSnapshot } from "./promotions.types";

const cart: CartSnapshot = {
  token: "test-cart",
  subtotal: 8_000,
  lines: [
    {
      key: "paid",
      productId: "101",
      variantId: "201",
      quantity: 1,
      price: 3_000,
      tags: ["Summer"],
      properties: {},
    },
    {
      key: "gift",
      productId: "102",
      variantId: "202",
      quantity: 1,
      price: 5_000,
      properties: { _free_gift_rule: "rule" },
    },
  ],
  customer: { loggedIn: true, tags: ["VIP"], orderCount: 0 },
  country: "PK",
};

assert.equal(
  conditionMatches(
    { field: "subtotal", operator: "greater_or_equal", value: 40 },
    cart,
  ),
  false,
  "gift value must not inflate the qualifying subtotal",
);
assert.equal(
  conditionMatches(
    {
      field: "product",
      operator: "equals",
      value: "gid://shopify/Product/101",
    },
    cart,
  ),
  true,
  "GID conditions must match Ajax numeric IDs",
);
assert.equal(
  conditionMatches(
    { field: "product_tag", operator: "equals", value: "summer" },
    cart,
  ),
  true,
);

// effectiveLinePrice: a tiered mystery box must contribute its DISCOUNTED
// total to the subtotal, so a gift threshold is judged on what the shopper
// actually pays ($35), not the raw pre-discount price ($175). This is the
// regression guard for "gift appeared when the discounted total was only $35".
const mysteryCart: CartSnapshot = {
  token: "mystery-cart",
  subtotal: 0,
  lines: [
    {
      key: "box",
      productId: "301",
      variantId: "301",
      quantity: 5,
      price: 3_500, // $35/unit raw → $175 raw total
      properties: { _mystery_price_type: "PERCENT_OFF", _mystery_price_value: "80" },
    },
  ],
  customer: { loggedIn: true },
};
assert.equal(
  effectiveLinePrice(mysteryCart.lines[0]),
  3_500,
  "a tiered mystery box must contribute its discounted total (5 × $35 − 80% = $35), not $175",
);
assert.equal(
  conditionMatches(
    { field: "subtotal", operator: "greater_or_equal", value: 50 },
    mysteryCart,
  ),
  false,
  "a $50 gift threshold must NOT trigger when the mystery box's discounted total is only $35",
);
assert.equal(
  conditionMatches(
    { field: "subtotal", operator: "greater_or_equal", value: 30 },
    mysteryCart,
  ),
  true,
  "the discounted $35 subtotal still satisfies a $30 threshold",
);
assert.equal(
  effectiveLinePrice({
    key: "gift",
    productId: "9",
    variantId: "9",
    quantity: 1,
    price: 5_000,
    properties: { _free_gift_rule: "rule" },
  }),
  0,
  "a free gift line contributes 0 to the subtotal",
);

const rule = {
  id: "rule",
  shop: "test.myshopify.com",
  name: "VIP gift",
  description: null,
  enabled: true,
  priority: 1,
  matchMode: "ALL",
  conditions: [
    { field: "customer_tag", operator: "equals", value: "VIP" },
    { field: "country", operator: "equals", value: "PK" },
  ],
  gifts: [],
  allowMultiple: false,
  maxGifts: 1,
  stackable: true,
  startsAt: null,
  endsAt: null,
  restrictions: {},
  notification: null,
  createdAt: new Date(),
  updatedAt: new Date(),
} as unknown as GiftRule;
assert.equal(
  giftRuleMatches(rule, cart),
  true,
  "AND rules must require and accept every matching condition",
);

assert.deepEqual(
  priceTierForQuantity(
    [
      { minQuantity: 2, adjustmentType: "PERCENT_OFF", value: 30 },
      { minQuantity: 3, adjustmentType: "FIXED_PRICE", value: 10 },
    ],
    3,
  ),
  { minQuantity: 3, adjustmentType: "FIXED_PRICE", value: 10 },
);

// --- Sequential selection must be contiguous, not skip every other item ---
const seqChildren = ["A", "B", "C", "D", "E"].map(
  (id, position) =>
    ({
      variantId: id,
      productTitle: id,
      variantTitle: id,
      available: true,
      inventoryQuantity: 10,
      weight: 1,
      position,
    }) as unknown as MysteryBoxChild,
);
const seqBox = {
  selectionMethod: "SEQUENTIAL",
  inventoryBehavior: "IGNORE",
  allowDuplicateChoices: false,
  cursor: 0,
  children: seqChildren,
} as unknown as MysteryBox & { children: MysteryBoxChild[] };

assert.deepEqual(
  pickChildren(seqBox, 2, seqChildren).map((c) => c.variantId),
  ["A", "B"],
  "sequential picks must be consecutive (A,B) — not skip to A,C",
);
assert.deepEqual(
  pickChildren({ ...seqBox, cursor: 3 } as any, 3, seqChildren).map(
    (c) => c.variantId,
  ),
  ["D", "E", "A"],
  "sequential picks must wrap around the full pool from the cursor",
);

// --- Deleting a still-qualifying free gift must not silently re-add it ---
const giftRule = {
  ...rule,
  // Tied to the "paid" line's product (101) rather than rule's
  // customer/country conditions, so removing that line is what makes the
  // rule stop matching in the reset-cleanup assertion below.
  conditions: [
    { field: "product", operator: "equals", value: "101" },
  ],
  gifts: [{ variantId: "202", quantity: 1, discountType: "FREE", discountValue: 100 }],
} as unknown as GiftRule;

const cartMissingGift: CartSnapshot = {
  ...cart,
  lines: cart.lines.filter((line) => line.key !== "gift"),
};

assert.equal(
  desiredGiftMutations([giftRule], cartMissingGift, "secret", "STACK_ALL")
    .mutations.some((m) => m.type === "ADD"),
  true,
  "a genuinely missing gift (never added) must still be added",
);

const cartMissingGiftDeclined: CartSnapshot = {
  ...cartMissingGift,
  attributes: { _giftlab_declined_gifts: "rule" },
};
const declinedResult = desiredGiftMutations(
  [giftRule],
  cartMissingGiftDeclined,
  "secret",
  "STACK_ALL",
);
assert.equal(
  declinedResult.mutations.some((m) => m.type === "ADD"),
  false,
  "a gift the shopper explicitly declined must not be re-added while still declined",
);

const cartNoLongerQualifying: CartSnapshot = {
  ...cartMissingGiftDeclined,
  lines: cartMissingGiftDeclined.lines.filter((line) => line.key !== "paid"),
};
const resetResult = desiredGiftMutations(
  [giftRule],
  cartNoLongerQualifying,
  "secret",
  "STACK_ALL",
);
const attributesMutation = resetResult.mutations.find(
  (m) => m.type === "ATTRIBUTES",
);
assert.ok(
  attributesMutation,
  "once the rule stops matching, the stale decline must be cleared",
);
assert.equal(
  attributesMutation?.attributes?._giftlab_declined_gifts,
  "",
  "the cleared decline list must no longer contain the rule id",
);

console.log("promotion engine assertions passed");
