import { unauthenticated } from "./shopify.server";
import prisma from "./db.server";

async function main() {
  const shop = "mrashail-2.myshopify.com";
  const { admin } = await unauthenticated.admin(shop);

  const queryResponse = await admin.graphql(
    `#graphql
    query ListTransforms {
      cartTransforms(first: 10) {
        nodes {
          id
          functionId
        }
      }
      shopifyFunctions(first: 20) {
        nodes {
          id
          title
          apiType
        }
      }
    }`,
  );

  const qJson = await queryResponse.json();
  console.log("SHOPIFY FUNCTIONS AND TRANSFORMS:", JSON.stringify(qJson, null, 2));
}

main().catch(console.error).finally(() => prisma.$disconnect());
