import prisma from "../db.server";
import { numericShopifyId } from "./promotion-engine.server";

export interface VariantConflict {
  variantId: string;
  usedIn: string;
  usedInType: "rule" | "box";
}

// Finds which of the given candidate variant ids are ALREADY awarded as a gift
// by another gift rule, or pooled as a child in another mystery box (all
// shop-scoped). Comparison is variant-level and by numeric id, so GID vs bare
// id never causes a miss. Only "given / pooled" uses count — a product used
// merely as a rule condition or a box trigger is intentionally NOT a conflict.
// The record currently being edited is excluded so re-saving it isn't flagged
// against itself. This is the single source of truth for the cross-promotion
// product-conflict check; every save action calls it before writing.
export async function findVariantConflicts(
  shop: string,
  exclude: { ruleId?: string; boxId?: string },
  candidateVariantIds: Array<string | null | undefined>,
): Promise<VariantConflict[]> {
  const wanted = new Set(
    candidateVariantIds
      .map((id) => String(numericShopifyId(id ?? "")))
      .filter((id) => id && id !== "0"),
  );
  if (wanted.size === 0) return [];

  const conflicts: VariantConflict[] = [];
  const seen = new Set<string>();

  const rules = await prisma.giftRule.findMany({
    where: { shop, ...(exclude.ruleId ? { id: { not: exclude.ruleId } } : {}) },
    select: { id: true, name: true, gifts: true },
  });
  for (const rule of rules) {
    const gifts = (rule.gifts as Array<Record<string, unknown>>) || [];
    for (const gift of gifts) {
      const raw = (gift?.variantId ?? gift?.variant_id) as string | undefined;
      const vid = String(numericShopifyId(raw ?? ""));
      if (wanted.has(vid)) {
        const key = `${vid}|rule|${rule.id}`;
        if (!seen.has(key)) {
          seen.add(key);
          conflicts.push({ variantId: vid, usedIn: rule.name, usedInType: "rule" });
        }
      }
    }
  }

  const children = await prisma.mysteryBoxChild.findMany({
    where: {
      mysteryBox: { shop, ...(exclude.boxId ? { id: { not: exclude.boxId } } : {}) },
    },
    select: { variantId: true, mysteryBox: { select: { id: true, name: true } } },
  });
  for (const child of children) {
    const vid = String(numericShopifyId(child.variantId));
    if (wanted.has(vid)) {
      const key = `${vid}|box|${child.mysteryBox.id}`;
      if (!seen.has(key)) {
        seen.add(key);
        conflicts.push({ variantId: vid, usedIn: child.mysteryBox.name, usedInType: "box" });
      }
    }
  }

  return conflicts;
}

// A single user-facing sentence naming where the product is already in use.
export function conflictErrorMessage(conflicts: VariantConflict[]): string {
  const places = Array.from(
    new Set(
      conflicts.map(
        (c) => `“${c.usedIn}” (${c.usedInType === "rule" ? "free gift rule" : "mystery box"})`,
      ),
    ),
  );
  return `This product is already used in ${places.join(", ")}. A product can only be used in one promotion at a time — remove it there first, or choose a different product.`;
}
