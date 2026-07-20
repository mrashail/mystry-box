import type { ActionFunctionArgs } from "react-router";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
export async function action({ request }: ActionFunctionArgs) {
  const { shop, payload } = await authenticate.webhook(request);
  const data = payload as unknown as {
    inventory_item_id: number;
    available: number | null;
  };
  await prisma.catalogVariant.updateMany({
    where: {
      shop,
      inventoryItemId: `gid://shopify/InventoryItem/${data.inventory_item_id}`,
    },
    data: {
      inventoryQuantity: data.available,
      available: data.available === null || data.available > 0,
    },
  });
  await prisma.mysteryBoxChild.updateMany({
    where: {
      mysteryBox: { shop },
      variantId: {
        in: (
          await prisma.catalogVariant.findMany({
            where: {
              shop,
              inventoryItemId: `gid://shopify/InventoryItem/${data.inventory_item_id}`,
            },
            select: { variantId: true },
          })
        ).map((item) => item.variantId),
      },
    },
    data: {
      inventoryQuantity: data.available,
      available: data.available === null || data.available > 0,
    },
  });
  return new Response();
}
