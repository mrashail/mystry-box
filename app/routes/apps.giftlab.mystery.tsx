import type { ActionFunctionArgs } from "react-router";
import { evaluateMysteryOnly, numericShopifyId } from "../lib/promotion-engine.server";
import type { CartSnapshot } from "../lib/promotions.types";
import { authenticate } from "../shopify.server";

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

  return Response.json(await evaluateMysteryOnly(shop, snapshot), {
    headers: { "Cache-Control": "no-store" },
  });
}
