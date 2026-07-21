interface AdminClient {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
}

// Keyed by shop: the Online Store publication GID differs per shop, so a
// single process-wide cache would hand shop A's publication id to shop B and
// silently fail to publish B's mystery-box product (leaving it unaddable).
const onlineStorePublicationIdByShop = new Map<string, string>();

async function getOnlineStorePublicationId(admin: AdminClient, shop: string) {
  const cached = onlineStorePublicationIdByShop.get(shop);
  if (cached) return cached;
  const response = await admin.graphql(
    `#graphql
    query OnlineStorePublication { publications(first: 25) { nodes { id catalog { title } } } }`,
  );
  const json = (await response.json()) as {
    data?: { publications: { nodes: Array<{ id: string; catalog?: { title?: string } }> } };
  };
  const match = json.data?.publications.nodes.find((node) =>
    node.catalog?.title?.endsWith("for Online Store"),
  );
  if (match?.id) onlineStorePublicationIdByShop.set(shop, match.id);
  return match?.id ?? null;
}

// Creates (or updates) the hidden real product that represents a Mystery Box in
// cart/checkout: its title, image, and price are what the shopper sees, while the
// actual randomly-picked child product stays hidden. Shopify requires every cart
// line to be backed by a real product/variant, so this is the only way to show a
// dedicated "Mystery Box" line without renaming a real product's line (which is
// restricted to development stores / Shopify Plus).
//
// Always exactly one "Default Title" variant, no matter how large the child pool
// is (it can be 2 or 20 — that's an internal selection pool, not something the
// shopper ever picks from). A separate variant per pool item would put the real
// product names in a storefront dropdown, defeating the entire point of a
// mystery box: the shopper must never be able to see or choose which item they
// get. The hidden pick itself happens later, server-side, once the box is
// already in the cart (see pickChildren()/mysteryMutations in promotion-engine).
export async function syncMysteryBoxProduct(
  admin: AdminClient,
  shop: string,
  box: {
    boxProductId?: string | null;
    boxVariantId?: string | null;
    name: string;
    boxPrice: number | string;
    boxImageUrl?: string | null;
  },
) {
  const input: Record<string, unknown> = {
    title: box.name,
    status: "ACTIVE",
    productOptions: [{ name: "Title", values: [{ name: "Default Title" }] }],
    variants: [
      {
        ...(box.boxVariantId ? { id: box.boxVariantId } : {}),
        price: String(box.boxPrice ?? 0),
        optionValues: [{ optionName: "Title", name: "Default Title" }],
      },
    ],
  };
  if (box.boxImageUrl)
    input.files = [{ originalSource: box.boxImageUrl, contentType: "IMAGE" }];

  const response = await admin.graphql(
    `#graphql
    mutation SyncMysteryBoxProduct($input: ProductSetInput!, $identifier: ProductSetIdentifiers) {
      productSet(synchronous: true, input: $input, identifier: $identifier) {
        product { id variants(first: 100) { nodes { id title sku } } }
        userErrors { field message }
      }
    }`,
    {
      variables: {
        input,
        identifier: box.boxProductId ? { id: box.boxProductId } : null,
      },
    },
  );
  const json = (await response.json()) as {
    data?: {
      productSet?: {
        product?: { id: string; variants: { nodes: Array<{ id: string }> } };
        userErrors: Array<{ message: string }>;
      };
    };
    errors?: Array<{ message: string }>;
  };
  const payload = json.data?.productSet;
  const product = payload?.product;
  if (!product)
    throw new Error(
      payload?.userErrors.map((item) => item.message).join(", ") ||
        JSON.stringify(json.errors) ||
        "Could not create the Mystery Box product.",
    );

  // Publishing is required for the variant to be addable via the storefront cart,
  // but must never block the product itself from being created/saved: if it fails
  // here (e.g. a transient API hiccup), the next save retries it against the same
  // product instead of creating a duplicate.
  try {
    const publicationId = await getOnlineStorePublicationId(admin, shop);
    if (publicationId) {
      await admin.graphql(
        `#graphql
        mutation PublishMysteryBoxProduct($id: ID!, $input: [PublicationInput!]!) {
          publishablePublish(id: $id, input: $input) { userErrors { field message } }
        }`,
        { variables: { id: product.id, input: [{ publicationId }] } },
      );
    }
  } catch (error) {
    console.warn("GiftLab: could not publish Mystery Box product", error);
  }

  return {
    boxProductId: product.id,
    boxVariantId: product.variants.nodes[0]?.id ?? null,
  };
}

// Removes the hidden shadow product a Mystery Box rule created, so deleting
// the rule doesn't leave an orphaned product sitting in the catalog forever.
export async function deleteMysteryBoxProduct(admin: AdminClient, productId: string) {
  try {
    const response = await admin.graphql(
      `#graphql
      mutation DeleteMysteryBoxProduct($input: ProductDeleteInput!) { productDelete(input: $input) { deletedProductId userErrors { field message } } }`,
      { variables: { input: { id: productId } } },
    );
    const json = (await response.json()) as {
      data?: { productDelete?: { deletedProductId?: string; userErrors: Array<{ message: string }> } };
    };
    const errors = json.data?.productDelete?.userErrors ?? [];
    if (errors.length) {
      console.warn(
        `GiftLab: could not delete Mystery Box product ${productId}:`,
        errors.map((item) => item.message).join(", "),
      );
    }
  } catch (error) {
    console.warn("GiftLab: exception while deleting Mystery Box product", error);
  }
}
