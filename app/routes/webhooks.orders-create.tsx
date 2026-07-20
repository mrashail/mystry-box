import type { ActionFunctionArgs } from "react-router";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
interface OrderPayload {
  id: number;
  cart_token?: string | null;
  customer?: { id: number } | null;
  line_items?: Array<{
    quantity: number;
    properties?: Array<{ name: string; value: string }>;
  }>;
}
export async function action({ request }: ActionFunctionArgs) {
  const { shop, payload } = await authenticate.webhook(request);
  const order = payload as unknown as OrderPayload;
  const orderId = String(order.id);
  const customerId = order.customer?.id ? String(order.customer.id) : null;
  const usage = new Map<
    string,
    { type: string; id: string; quantity: number }
  >();
  // (customer, box, variant) rows for every mystery box line, so a future
  // pick can exclude what this customer has already been shipped. Only
  // recorded here — from the confirmed order, not the cart-side pick — so an
  // abandoned cart never counts as "already received".
  const customerHistory: Array<{ mysteryBoxId: string; variantId: string }> =
    [];
  for (const line of order.line_items ?? []) {
    const properties = Object.fromEntries(
      (line.properties ?? []).map((item) => [item.name, item.value]),
    );
    const type = properties._free_gift_rule
      ? "GIFT"
      : properties._mystery_box_id
        ? "MYSTERY"
        : null;
    const promotionId =
      properties._free_gift_rule || properties._mystery_box_id;
    if (!type || !promotionId) continue;
    const key = `${type}:${promotionId}`;
    const current = usage.get(key);
    usage.set(key, {
      type,
      id: promotionId,
      quantity: (current?.quantity ?? 0) + line.quantity,
    });
    if (customerId && properties._mystery_box_id && properties._mystery_selection) {
      for (const variantId of properties._mystery_selection.split(",")) {
        if (variantId) {
          customerHistory.push({
            mysteryBoxId: properties._mystery_box_id,
            variantId,
          });
        }
      }
    }
  }
  for (const item of usage.values()) {
    await prisma.promotionUsage.upsert({
      where: {
        shop_promotionType_promotionId_orderId: {
          shop,
          promotionType: item.type,
          promotionId: item.id,
          orderId,
        },
      },
      update: { quantity: item.quantity, customerId },
      create: {
        shop,
        promotionType: item.type,
        promotionId: item.id,
        orderId,
        customerId,
        quantity: item.quantity,
      },
    });
  }
  if (order.cart_token)
    await prisma.mysterySelection.updateMany({
      where: { shop, cartToken: order.cart_token, status: "CART" },
      data: { status: "ORDERED", orderId },
    });
  if (customerId) {
    for (const entry of customerHistory) {
      await prisma.mysteryCustomerHistory.upsert({
        where: {
          shop_customerId_mysteryBoxId_variantId_orderId: {
            shop,
            customerId,
            mysteryBoxId: entry.mysteryBoxId,
            variantId: entry.variantId,
            orderId,
          },
        },
        update: {},
        create: {
          shop,
          customerId,
          mysteryBoxId: entry.mysteryBoxId,
          variantId: entry.variantId,
          orderId,
        },
      });
    }
  }
  return new Response();
}
