import type { ActionFunctionArgs } from "react-router";
import { evaluateMysteryOnly, numericShopifyId } from "../lib/promotion-engine.server";
import type { CartSnapshot } from "../lib/promotions.types";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

// Mirrors the AjaxCart shape apps.giftlab.evaluate.tsx maps from — kept as a
// separate, mystery-only endpoint (see evaluateMysteryOnly's comment) so the
// storefront's already-solid free-gift path is never mixed with or overridden
// by a server response.
interface AjaxCart {
  token?: string;
  currency?: string;
  items_subtotal_price?: number;
  total_price?: number;
  items?: Array<{
    key: string;
    variant_id: number;
    product_id: number;
    title?: string;
    variant_title?: string;
    sku?: string;
    vendor?: string;
    product_type?: string;
    quantity: number;
    price: number;
    final_price?: number;
    properties?: Record<string, string | null> | null;
  }>;
  attributes?: Record<string, string> | null;
}

export async function action({ request }: ActionFunctionArgs) {
  let context;
  try {
    context = await authenticate.public.appProxy(request);
  } catch (err) {
    console.error("App Proxy Authentication Failed (mystery)!", err);
    throw err;
  }
  const url = new URL(request.url);
  const shop = context.session?.shop ?? url.searchParams.get("shop");
  if (!shop)
    return Response.json({ error: "Missing shop context" }, { status: 401 });

  let payload: { cart?: AjaxCart; customer?: CartSnapshot["customer"]; country?: string };
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }
  const cart = payload.cart;
  if (!cart?.items)
    return Response.json({ error: "Invalid cart" }, { status: 400 });

  const snapshot: CartSnapshot = {
    token: String(cart.token ?? "anonymous"),
    subtotal: cart.items_subtotal_price ?? cart.total_price ?? 0,
    currency: cart.currency,
    lines: cart.items.map((line) => ({
      key: line.key,
      variantId: numericShopifyId(line.variant_id),
      productId: numericShopifyId(line.product_id),
      title: line.title,
      variantTitle: line.variant_title,
      sku: line.sku,
      vendor: line.vendor,
      productType: line.product_type,
      quantity: line.quantity,
      price: line.price,
      finalPrice: line.final_price,
      properties: line.properties ?? {},
    })),
    customer: payload.customer,
    country: payload.country,
    attributes: cart.attributes ?? {},
  };

  // Return each box's TRUE per-unit price (cents) alongside the mystery
  // mutations, straight from the DB — authoritative and stable. The storefront
  // uses it to price a tiered box for gift eligibility instead of the cart
  // line's own `price`, which Shopify reports inflated (unit × quantity) for a
  // few seconds after a mutation before settling. This is fetched fresh here
  // (no metafield re-save needed) since this endpoint already runs whenever a
  // box is in the cart.
  const [result, boxes] = await Promise.all([
    evaluateMysteryOnly(shop, snapshot),
    prisma.mysteryBox.findMany({
      where: { shop, enabled: true },
      select: { id: true, boxVariantId: true, parentVariantId: true, boxPrice: true },
    }),
  ]);
  const boxPrices = boxes
    .filter((box) => box.boxVariantId)
    .map((box) => ({
      id: box.id,
      boxVariantId: String(numericShopifyId(box.boxVariantId as string)),
      parentVariantId: box.parentVariantId ? String(numericShopifyId(box.parentVariantId)) : null,
      basePrice: Math.round(Number(box.boxPrice) * 100),
    }));

  return Response.json({ ...result, boxPrices }, {
    headers: { "Cache-Control": "no-store" },
  });
}
