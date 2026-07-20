import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, Link, useLoaderData } from "react-router";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { prismaJson } from "../lib/forms.server";
import { deletePromotionDiscount } from "../lib/checkout-discount.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { redirect } = await authenticate.admin(request);
  return redirect("/app/rules");
}

export async function action({ request }: ActionFunctionArgs) {
  const { session, admin } = await authenticate.admin(request);
  const form = await request.formData();
  const id = String(form.get("id") ?? "");
  const intent = String(form.get("intent") ?? "");
  const rule = await prisma.giftRule.findFirst({ where: { id, shop: session.shop } });
  if (!rule) return Response.json({ ok: false }, { status: 404 });
  if (intent === "delete") {
    if (rule.shopifyDiscountId) {
      await deletePromotionDiscount(admin, rule.shopifyDiscountId);
    }
    await prisma.giftRule.delete({ where: { id } });
  }
  if (intent === "toggle") await prisma.giftRule.update({ where: { id }, data: { enabled: !rule.enabled } });
  if (intent === "duplicate") await prisma.giftRule.create({ data: { shop: session.shop, name: `${rule.name} (copy)`, description: rule.description, enabled: false, priority: rule.priority, matchMode: rule.matchMode, conditions: prismaJson(rule.conditions), gifts: prismaJson(rule.gifts), allowMultiple: rule.allowMultiple, maxGifts: rule.maxGifts, stackable: rule.stackable, startsAt: rule.startsAt, endsAt: rule.endsAt, restrictions: prismaJson(rule.restrictions), notification: rule.notification } });
  return { ok: true };
}

export default function GiftRules() {
  return null;
}
