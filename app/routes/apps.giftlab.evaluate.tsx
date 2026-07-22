import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { evaluateCart, numericShopifyId, promotionSignature, activeBetween, restrictionsMatch, encodeConditionsForFunction } from "../lib/promotion-engine.server";
import type { CartSnapshot, RuleCondition } from "../lib/promotions.types";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

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
  cart_level_discount_applications?: Array<{ title?: string }>;
  discount_codes?: Array<{ code?: string; applicable?: boolean }>;
  attributes?: Record<string, string> | null;
}

export async function action({ request }: ActionFunctionArgs) {
  let context;
  try {
    context = await authenticate.public.appProxy(request);
  } catch (err) {
    console.error("App Proxy Authentication Failed!", err);
    if (err instanceof Response) {
      try {
        const text = await err.text();
        console.error("Auth response status:", err.status, "body:", text);
      } catch (e) {}
    }
    throw err;
  }
  const url = new URL(request.url);
  const shop = context.session?.shop ?? url.searchParams.get("shop");
  if (!shop)
    return Response.json({ error: "Missing shop context" }, { status: 401 });
  let payload: {
    cart?: AjaxCart;
    customer?: CartSnapshot["customer"];
    country?: string;
  };
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
    discountCodes: [
      ...(cart.discount_codes ?? [])
        .filter((discount) => discount.applicable !== false)
        .map((discount) => discount.code ?? ""),
      ...(cart.cart_level_discount_applications ?? []).map(
        (discount) => discount.title ?? "",
      ),
    ].filter(Boolean),
    customer: payload.customer,
    country: payload.country,
    attributes: cart.attributes ?? {},
  };
  return Response.json(await evaluateCart(shop, snapshot), {
    headers: { "Cache-Control": "no-store" },
  });
}

export async function loader({ request }: LoaderFunctionArgs) {
  let context;
  try {
    context = await authenticate.public.appProxy(request);
  } catch (err) {
    console.error("App Proxy Loader Auth Failed:", err);
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const url = new URL(request.url);
  const shop = context.session?.shop ?? url.searchParams.get("shop");
  if (!shop)
    return Response.json({ error: "Missing shop context" }, { status: 400 });

  const customerParam = url.searchParams.get("customer");
  let customerData = null;
  if (customerParam) {
    try {
      customerData = JSON.parse(decodeURIComponent(customerParam));
    } catch (e) {}
  }

  const [settings, rules] = await Promise.all([
    prisma.shopSettings.findUnique({ where: { shop } }),
    prisma.giftRule.findMany({ where: { shop, enabled: true } }),
  ]);
  const secret = settings?.promotionSecret || "";

  const now = new Date();
  const validRules = rules.filter((rule) => {
    if (!rule.enabled || !activeBetween(rule.startsAt, rule.endsAt, now))
      return false;
    if (customerData) {
      const fakeCart = { lines: [], customer: customerData } as any;
      if (!restrictionsMatch((rule.restrictions ?? {}) as any, fakeCart)) {
        return false;
      }
    }
    return true;
  });

  const responseRules = validRules.map((rule) => {
    // Same encoding the server-side engine signs onto a gift line (see
    // desiredGiftMutations in promotion-engine.server.ts) — kept identical
    // here so the checkout Function can re-verify either path's line the
    // same way, regardless of which one actually added it to the cart.
    const { blob: conditionsBlob, unverifiable } = encodeConditionsForFunction(
      rule.matchMode,
      (rule.conditions as unknown as RuleCondition[]) ?? [],
    );
    const gifts = (rule.gifts as any[] || []).map((gift) => {
      const variantId = numericShopifyId(gift.variantId);
      const discountType = gift.discountType || "FREE";
      const discountValue = gift.discountValue || 100.0;
      const quantity = Math.max(1, gift.quantity || 1);
      // Quantity is part of the signed payload (see desiredGiftMutations in
      // promotion-engine.server.ts) so the checkout Function only discounts
      // the awarded number of units, not an AJAX-inflated line quantity.
      const signature = promotionSignature(
        secret,
        variantId,
        "free_gift_discount",
        rule.id,
        `${discountType}|${discountValue}|${quantity}|${unverifiable ? "UNVERIFIABLE" : conditionsBlob}`
      );
      return {
        variantId,
        quantity,
        discountType,
        discountValue,
        signature,
      };
    });

    return {
      id: rule.id,
      name: rule.name,
      matchMode: rule.matchMode,
      conditions: rule.conditions,
      gifts,
      maxGifts: rule.maxGifts,
      allowMultiple: rule.allowMultiple,
      notification: rule.notification,
      conditionsBlob,
      unverifiable,
    };
  });

  return Response.json({ rules: responseRules }, {
    headers: { "Cache-Control": "no-store" },
  });
}
