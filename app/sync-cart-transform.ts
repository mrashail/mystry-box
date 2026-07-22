import { unauthenticated } from "./shopify.server";
import { syncCartTransformRules } from "./lib/cart-transform.server";
import prisma from "./db.server";

async function main() {
  const shop = "mrashail-2.myshopify.com";
  console.log("Syncing CartTransform rules for shop:", shop);
  const { admin } = await unauthenticated.admin(shop);
  await syncCartTransformRules(admin, shop);
  console.log("Done!");
}

main().catch(console.error).finally(() => prisma.$disconnect());
