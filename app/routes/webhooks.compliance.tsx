import type { ActionFunctionArgs } from "react-router";
import { deleteShopData } from "../lib/cleanup.server";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";

export async function action({ request }: ActionFunctionArgs) {
  const { shop, topic, payload } = await authenticate.webhook(request);
  if (topic === "CUSTOMERS_REDACT") {
    const customerId = String((payload as { customer?: { id?: string | number } }).customer?.id ?? "");
    if (customerId) await prisma.promotionUsage.deleteMany({ where: { shop, customerId } });
  }
  if (topic === "SHOP_REDACT") await deleteShopData(shop);
  // CUSTOMERS_DATA_REQUEST is acknowledged here. GiftLab stores only promotion
  // usage identifiers; merchants can export those records through support.
  return new Response();
}
