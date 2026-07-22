import { unauthenticated } from "./shopify.server";
import prisma from "./db.server";

async function main() {
  const shop = "mrashail-2.myshopify.com";
  const { admin } = await unauthenticated.admin(shop);

  const response = await admin.graphql(
    `#graphql
    mutation CreateCartTransform($functionHandle: String!) {
      cartTransformCreate(functionHandle: $functionHandle) {
        cartTransform { id }
        userErrors { field message }
      }
    }`,
    {
      variables: {
        functionHandle: "giftlab-gift-transform",
      },
    },
  );

  const json = await response.json();
  console.dir(json, { depth: null });
}

main().catch(console.error).finally(() => prisma.$disconnect());
