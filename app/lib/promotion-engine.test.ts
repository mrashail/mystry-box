import assert from "node:assert/strict";
import type { GiftRule, MysteryBox, MysteryBoxChild } from "@prisma/client";
import {
  conditionMatches,
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

console.log("promotion engine assertions passed");
