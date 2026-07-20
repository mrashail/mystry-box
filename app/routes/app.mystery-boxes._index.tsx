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
  const form = await request.formData(); const id = String(form.get("id") ?? ""); const intent = String(form.get("intent") ?? "");
  const box = await prisma.mysteryBox.findFirst({ where: { id, shop: session.shop }, include: { children: true } });
  if (!box) return Response.json({ ok: false }, { status: 404 });
  if (intent === "delete") {
    if (box.shopifyDiscountId) {
      await deletePromotionDiscount(admin, box.shopifyDiscountId);
    }
    await prisma.mysteryBox.delete({ where: { id } });
  }
  if (intent === "toggle") await prisma.mysteryBox.update({ where: { id }, data: { enabled: !box.enabled } });
  if (intent === "duplicate") await prisma.mysteryBox.create({ data: { shop: session.shop, name: `${box.name} (copy)`, description: box.description, enabled: false, priority: box.priority, parentProductId: box.parentProductId, parentProductTitle: box.parentProductTitle, parentVariantId: box.parentVariantId, parentVariantTitle: box.parentVariantTitle, selectionMethod: box.selectionMethod, inventoryBehavior: box.inventoryBehavior, selectionCount: box.selectionCount, allowDuplicateChoices: box.allowDuplicateChoices, matchingRules: prismaJson(box.matchingRules), priceTiers: prismaJson(box.priceTiers), bogo: prismaJson(box.bogo), restrictions: prismaJson(box.restrictions), startsAt: box.startsAt, endsAt: box.endsAt, children: { create: box.children.map((child) => ({ productId: child.productId, productTitle: child.productTitle, variantId: child.variantId, variantTitle: child.variantTitle, sku: child.sku, imageUrl: child.imageUrl, inventoryQuantity: child.inventoryQuantity, available: child.available, weight: child.weight, position: child.position })) } } });
  return { ok: true };
}

export default function MysteryBoxes() {
  return null;
}
