import type { InputJsonValue } from "@prisma/client/runtime/library";
import type { ChildChoice } from "../components/MysteryBoxEditor";
import type { BogoConfiguration, MatchingRule, PriceTier } from "./promotions.types";

export function text(form: FormData, key: string, fallback = "") {
  const value = form.get(key);
  return typeof value === "string" ? value.trim() : fallback;
}

export function integer(form: FormData, key: string, fallback: number, min = 0) {
  const value = Number(text(form, key));
  return Number.isFinite(value) ? Math.max(min, Math.floor(value)) : fallback;
}

export function decimal(form: FormData, key: string, fallback: number, min = 0) {
  const value = Number(text(form, key));
  return Number.isFinite(value) ? Math.max(min, value) : fallback;
}

export function checked(form: FormData, key: string) {
  return form.get(key) === "on" || form.get(key) === "true" || form.get(key) === "1";
}

export function json<T>(form: FormData, key: string, fallback: T): T {
  try {
    const raw = text(form, key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function dateOrNull(form: FormData, key: string) {
  const raw = text(form, key);
  if (!raw) return null;
  const value = new Date(raw);
  return Number.isNaN(value.getTime()) ? null : value;
}

export function prismaJson(value: unknown) {
  return value as InputJsonValue;
}

export function mysteryFormData(form: FormData) {
  const parent = json<{ productId: string; productTitle: string; variantId?: string; variantTitle?: string }>(form, "parent", { productId: "", productTitle: "" });
  const children = json<ChildChoice[]>(form, "children", []);
  const matchingRules = json<MatchingRule[]>(form, "matchingRules", []).filter((rule) => rule.value.trim());
  const priceTiers = json<PriceTier[]>(form, "priceTiers", []);
  const bogo: BogoConfiguration = { enabled: checked(form, "bogoEnabled"), buyQuantity: integer(form, "buyQuantity", 1, 1), freeQuantity: integer(form, "freeQuantity", 1, 1), target: text(form, "bogoTarget", "SAME_BOX") as BogoConfiguration["target"], targetBoxId: text(form, "targetBoxId") || undefined, pool: text(form, "bogoTarget") === "DIFFERENT_BOX" ? "DIFFERENT_POOL" : "SAME_POOL", randomizeGifts: checked(form, "randomizeGifts") };
  return {
    parent,
    children,
    matchingRules,
    data: {
      name: text(form, "name"), description: text(form, "description") || null, enabled: checked(form, "enabled"), priority: integer(form, "priority", 100, 1),
      parentProductId: parent.productId, parentProductTitle: parent.productTitle, parentVariantId: parent.variantId || null, parentVariantTitle: parent.variantTitle || null,
      selectionMethod: text(form, "selectionMethod", "RANDOM"), inventoryBehavior: text(form, "inventoryBehavior", "IN_STOCK_ONLY"), selectionCount: integer(form, "selectionCount", 1, 1), allowDuplicateChoices: checked(form, "allowDuplicateChoices"),
      boxPrice: decimal(form, "boxPrice", 0), boxImageUrl: text(form, "boxImageUrl") || null,
      matchingRules: prismaJson(matchingRules), priceTiers: prismaJson(priceTiers), bogo: prismaJson(bogo), restrictions: prismaJson({ onePerOrder: checked(form, "onePerOrder"), onePerCustomer: checked(form, "onePerCustomer"), firstPurchaseOnly: checked(form, "firstPurchaseOnly"), allowedCustomerTags: text(form, "allowedCustomerTags").split(",").map((item) => item.trim()).filter(Boolean), excludedCustomerTags: text(form, "excludedCustomerTags").split(",").map((item) => item.trim()).filter(Boolean) }), startsAt: dateOrNull(form, "startsAt"), endsAt: dateOrNull(form, "endsAt"),
    },
  };
}
