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

  try {
    const json = await response.json();
    console.log("JSON DATA:", JSON.stringify(json, null, 2));
  } catch (err: any) {
    if (err.response) {
      const text = await err.response.text();
      console.log("RAW TEXT RESPONSE:", text);
    } else {
      console.log("ERR:", err);
    }
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
