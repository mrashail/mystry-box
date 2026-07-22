import prisma from "./db.server";

async function main() {
  const shop = "mrashail-2.myshopify.com";
  const session = await prisma.session.findFirst({
    where: { shop, isOnline: false },
  });

  if (!session) {
    console.error("No offline session found for shop:", shop);
    return;
  }

  console.log("Found session for shop:", shop, "accessToken:", session.accessToken?.substring(0, 10) + "...");

  // 1. Query shopifyFunctions
  const queryResp = await fetch(`https://${shop}/admin/api/2026-04/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": session.accessToken,
    },
    body: JSON.stringify({
      query: `
        query ListFunctionsAndTransforms {
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
        }
      `,
    }),
  });

  const queryJson = await queryResp.json();
  console.log("DIRECT GRAPHQL QUERY RESULT:", JSON.stringify(queryJson, null, 2));

  // Find giftlab-gift-transform function GID
  const functions = queryJson.data?.shopifyFunctions?.nodes || [];
  const transformFunc = functions.find((f: any) => f.title?.includes("gift-transform") || f.title?.includes("Gift"));
  console.log("Found Transform Function:", transformFunc);

  if (transformFunc) {
    // 2. Create CartTransform using functionId
    const createResp = await fetch(`https://${shop}/admin/api/2026-04/graphql.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": session.accessToken,
      },
      body: JSON.stringify({
        query: `
          mutation CreateCartTransform($functionId: String!) {
            cartTransformCreate(functionId: $functionId) {
              cartTransform { id }
              userErrors { field message }
            }
          }
        `,
        variables: {
          functionId: transformFunc.id,
        },
      }),
    });

    const createJson = await createResp.json();
    console.log("CART TRANSFORM CREATE RESULT:", JSON.stringify(createJson, null, 2));

    const transformId = createJson.data?.cartTransformCreate?.cartTransform?.id;
    if (transformId) {
      await prisma.shopSettings.upsert({
        where: { shop },
        update: { cartTransformId: transformId },
        create: { shop, cartTransformId: transformId },
      });
      console.log("Saved cartTransformId to DB:", transformId);
    }
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
