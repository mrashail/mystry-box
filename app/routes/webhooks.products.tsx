import type { ActionFunctionArgs } from "react-router";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";

interface ProductWebhook {
  id: number;
  title: string;
  handle?: string;
  product_type?: string;
  vendor?: string;
  tags?: string;
  image?: { src?: string } | null;
  variants?: Array<{
    id: number;
    title: string;
    sku?: string;
    price?: string;
    inventory_quantity?: number | null;
    inventory_item_id?: number;
  }>;
}
export async function action({ request }: ActionFunctionArgs) {
  const { shop, topic, payload } = await authenticate.webhook(request);
  const product = payload as unknown as ProductWebhook;
  const productId = `gid://shopify/Product/${product.id}`;
  if (topic === "PRODUCTS_DELETE") {
    await prisma.catalogVariant.deleteMany({ where: { shop, productId } });
    return new Response();
  }
  for (const variant of product.variants ?? []) {
    const variantId = `gid://shopify/ProductVariant/${variant.id}`;
    const inventory = variant.inventory_quantity ?? null;
    const existing = await prisma.catalogVariant.findUnique({
      where: { shop_variantId: { shop, variantId } },
      select: { collectionIds: true },
    });
    await prisma.catalogVariant.upsert({
      where: { shop_variantId: { shop, variantId } },
      update: {
        productId,
        productTitle: product.title,
        productHandle: product.handle,
        productType: product.product_type,
        vendor: product.vendor,
        tags: (product.tags ?? "")
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean),
        variantTitle: variant.title,
        sku: variant.sku,
        price: variant.price,
        inventoryItemId: variant.inventory_item_id
          ? `gid://shopify/InventoryItem/${variant.inventory_item_id}`
          : null,
        inventoryQuantity: inventory,
        available: inventory === null || inventory > 0,
        imageUrl: product.image?.src ?? null,
      },
      create: {
        shop,
        productId,
        productTitle: product.title,
        productHandle: product.handle,
        productType: product.product_type,
        vendor: product.vendor,
        tags: (product.tags ?? "")
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean),
        collectionIds: existing?.collectionIds ?? [],
        variantId,
        variantTitle: variant.title,
        sku: variant.sku,
        price: variant.price,
        inventoryItemId: variant.inventory_item_id
          ? `gid://shopify/InventoryItem/${variant.inventory_item_id}`
          : null,
        inventoryQuantity: inventory,
        available: inventory === null || inventory > 0,
        imageUrl: product.image?.src ?? null,
      },
    });
  }
  return new Response();
}
