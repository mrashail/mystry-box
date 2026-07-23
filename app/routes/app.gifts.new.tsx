import type { ActionFunctionArgs } from "react-router";
import { GiftRuleEditor } from "../components/GiftRuleEditor";
import { checked, dateOrNull, integer, json, prismaJson, text } from "../lib/forms.server";
import type { GiftChoice, RuleCondition } from "../lib/promotions.types";
import { createPromotionDiscount, deletePromotionDiscount, ensurePromotionSecret } from "../lib/checkout-discount.server";
import { syncCartTransformRules } from "../lib/cart-transform.server";
import { findVariantConflicts, conflictErrorMessage } from "../lib/product-conflicts.server";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";

export async function action({ request }: ActionFunctionArgs) {
  const { session, admin, redirect } = await authenticate.admin(request);
  const form = await request.formData();
  const gifts = json<GiftChoice[]>(form, "gifts", []);
  const name = text(form, "name");
  if (!name || !gifts.length) return Response.json({ error: "Name and at least one gift are required." }, { status: 400 });

  // A product may only be used in one promotion at a time — block a gift that's
  // already awarded by another rule or pooled in a mystery box before anything
  // is created (see findVariantConflicts).
  const conflicts = await findVariantConflicts(
    session.shop,
    {},
    gifts.map((gift) => gift.variantId),
  );
  if (conflicts.length) {
    return Response.json({ error: conflictErrorMessage(conflicts) }, { status: 400 });
  }

  const enabled = checked(form, "enabled");

  let shopifyDiscountId: string | null = null;
  if (enabled) {
    try {
      const secret = await ensurePromotionSecret(session.shop);
      shopifyDiscountId = await createPromotionDiscount(admin, {
        title: `Free gift: ${name}`,
        secret,
      });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "Could not activate the checkout discount for this rule. Deploy the Function extension first." },
        { status: 400 },
      );
    }
  }

  let created;
  try {
    created = await prisma.giftRule.create({ data: {
      shop: session.shop, name, description: text(form, "description") || null,
      enabled, priority: integer(form, "priority", 100, 1), matchMode: text(form, "matchMode", "ALL"),
      conditions: prismaJson(json<RuleCondition[]>(form, "conditions", [])), gifts: prismaJson(gifts), allowMultiple: checked(form, "allowMultiple"), maxGifts: integer(form, "maxGifts", 1, 1), stackable: checked(form, "stackable"),
      startsAt: dateOrNull(form, "startsAt"), endsAt: dateOrNull(form, "endsAt"), notification: text(form, "notification") || null,
      shopifyDiscountId,
      restrictions: { onePerOrder: checked(form, "onePerOrder"), onePerCustomer: checked(form, "onePerCustomer"), firstPurchaseOnly: checked(form, "firstPurchaseOnly"), allowedCustomerTags: text(form, "allowedCustomerTags").split(",").map((item) => item.trim()).filter(Boolean), excludedCustomerTags: text(form, "excludedCustomerTags").split(",").map((item) => item.trim()).filter(Boolean) },
    } });
  } catch (error) {
    // Don't leave the just-created automatic discount orphaned in Shopify if
    // the owning rule row never gets written.
    if (shopifyDiscountId) await deletePromotionDiscount(admin, shopifyDiscountId);
    return Response.json(
      { error: error instanceof Error ? error.message : "Could not save this rule." },
      { status: 500 },
    );
  }
  // Storefront metafield sync is best-effort and MUST NOT be inside the fatal
  // save try above: the rule row is already committed, so a transient GraphQL
  // hiccup here used to surface a scary "Could not save this rule" banner over
  // a rule that had in fact saved. Log it and move on — the next save retries.
  try {
    await syncCartTransformRules(admin, session.shop);
  } catch (error) {
    console.error("Gift rule saved, but storefront sync failed (will retry on next save):", error);
  }
  // Land on the new rule's own edit page (not the rules list) so the merchant
  // stays in the form and can keep editing what they just created.
  return redirect(`/app/gifts/${created.id}`);
}

export default function NewGiftRule() {
  return <GiftRuleEditor title="Create free gift rule" value={{ name: "", enabled: true, priority: 100, matchMode: "ALL", conditions: [{ id: "initial", field: "subtotal", operator: "greater_or_equal", value: "50" }], gifts: [], allowMultiple: false, maxGifts: 1, stackable: true, restrictions: { onePerOrder: true } }} />;
}
