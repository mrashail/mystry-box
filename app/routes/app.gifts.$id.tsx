import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { GiftRuleEditor, type GiftRuleEditorValue } from "../components/GiftRuleEditor";
import { checked, dateOrNull, integer, json, prismaJson, text } from "../lib/forms.server";
import type { GiftChoice, RuleCondition } from "../lib/promotions.types";
import {
  createPromotionDiscount,
  deletePromotionDiscount,
  ensurePromotionSecret,
} from "../lib/checkout-discount.server";
import { syncCartTransformRules } from "../lib/cart-transform.server";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { resolveConditionLabels } from "../lib/condition-labels.server";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const { session, admin } = await authenticate.admin(request);
  const rule = await prisma.giftRule.findFirst({ where: { id: params.id, shop: session.shop } });
  if (!rule) throw new Response("Not found", { status: 404 });

  const conditions = rule.conditions as unknown as RuleCondition[];
  const conditionLabels = await resolveConditionLabels(admin, conditions);

  return { rule, conditionLabels };
}

export async function action({ request, params }: ActionFunctionArgs) {
  const { session, admin, redirect } = await authenticate.admin(request);
  const current = await prisma.giftRule.findFirst({ where: { id: params.id, shop: session.shop } });
  if (!current) throw new Response("Not found", { status: 404 });
  const form = await request.formData();
  const gifts = json<GiftChoice[]>(form, "gifts", []);
  const name = text(form, "name");
  const enabled = checked(form, "enabled");

  let shopifyDiscountId = current.shopifyDiscountId;
  if (enabled && !shopifyDiscountId) {
    try {
      const secret = await ensurePromotionSecret(session.shop);
      shopifyDiscountId = await createPromotionDiscount(admin, {
        title: `Free gift: ${name}`,
        secret,
      });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "Could not activate the checkout discount for this rule." },
        { status: 400 },
      );
    }
  } else if (!enabled && shopifyDiscountId) {
    await deletePromotionDiscount(admin, shopifyDiscountId);
    shopifyDiscountId = null;
  }

  await prisma.giftRule.update({ where: { id: current.id }, data: {
    name, description: text(form, "description") || null, enabled, priority: integer(form, "priority", 100, 1), matchMode: text(form, "matchMode", "ALL"),
    conditions: prismaJson(json<RuleCondition[]>(form, "conditions", [])), gifts: prismaJson(gifts), allowMultiple: checked(form, "allowMultiple"), maxGifts: integer(form, "maxGifts", 1, 1), stackable: checked(form, "stackable"), startsAt: dateOrNull(form, "startsAt"), endsAt: dateOrNull(form, "endsAt"), notification: text(form, "notification") || null,
    shopifyDiscountId,
    restrictions: { onePerOrder: checked(form, "onePerOrder"), onePerCustomer: checked(form, "onePerCustomer"), firstPurchaseOnly: checked(form, "firstPurchaseOnly"), allowedCustomerTags: text(form, "allowedCustomerTags").split(",").map((item) => item.trim()).filter(Boolean), excludedCustomerTags: text(form, "excludedCustomerTags").split(",").map((item) => item.trim()).filter(Boolean) },
  } });
  await syncCartTransformRules(admin, session.shop);
  return redirect("/app/rules");
}

export default function EditGiftRule() {
  const { rule, conditionLabels } = useLoaderData<typeof loader>();
  const value: GiftRuleEditorValue = { ...rule, conditions: rule.conditions as unknown as RuleCondition[], gifts: rule.gifts as unknown as GiftChoice[], restrictions: rule.restrictions as GiftRuleEditorValue["restrictions"], startsAt: rule.startsAt?.toISOString(), endsAt: rule.endsAt?.toISOString(), conditionLabels };
  return <GiftRuleEditor title={`Edit ${rule.name}`} value={value} />;
}
