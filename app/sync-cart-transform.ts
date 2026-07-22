import { unauthenticated } from "./shopify.server";
import { syncCartTransformRules } from "./lib/cart-transform.server";
import prisma from "./db.server";

async function main() {
  const settings = await prisma.shopSettings.findMany();
  for (const setting of settings) {
    console.log("Syncing CartTransform for shop:", setting.shop);
    try {
      const { admin } = await unauthenticated.admin(setting.shop);
      await syncCartTransformRules(admin, setting.shop);
      console.log("CartTransform synced successfully for:", setting.shop);
    } catch (err) {
      console.error("CartTransform sync error for:", setting.shop, err);
    }
  }

  const updatedSettings = await prisma.shopSettings.findMany();
  console.log("Updated ShopSettings:", JSON.stringify(updatedSettings, null, 2));
}

main().catch(console.error).finally(() => prisma.$disconnect());
