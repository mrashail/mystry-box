import prisma from "../db.server";

interface AdminClient {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
}
interface VariantNode {
  id: string;
  title: string;
  sku?: string | null;
  price: string;
  inventoryQuantity?: number | null;
  inventoryItem?: { id: string } | null;
  image?: { url: string } | null;
}
interface ProductNode {
  id: string;
  title: string;
  handle: string;
  productType: string;
  vendor: string;
  tags: string[];
  collections: { nodes: Array<{ id: string }> };
  featuredImage?: { url: string } | null;
  variants: {
    nodes: VariantNode[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

export interface ResolvedSkuVariant {
  productId: string;
  productTitle: string;
  variantId: string;
  variantTitle: string;
  sku: string | null;
  imageUrl: string | null;
  inventoryQuantity: number | null;
  available: boolean;
}

// Looks up exact SKUs via the Admin API so merchants can bulk-add a mystery box's
// child pool by pasting a SKU list instead of searching for each product one by one.
export async function resolveSkus(admin: AdminClient, skus: string[]) {
  const unique = [...new Set(skus.map((sku) => sku.trim()).filter(Boolean))];
  if (!unique.length) return { variants: [], notFound: [] as string[] };
  const query = unique.map((sku) => `sku:${JSON.stringify(sku)}`).join(" OR ");
  const response = await admin.graphql(
    `#graphql
    query VariantsBySku($query: String!) {
      productVariants(first: 250, query: $query) {
        nodes {
          id
          title
          sku
          inventoryQuantity
          availableForSale
          image { url }
          product { id title featuredImage { url } }
        }
      }
    }`,
    { variables: { query } },
  );
  const json = (await response.json()) as {
    data?: {
      productVariants: {
        nodes: Array<{
          id: string;
          title: string;
          sku: string | null;
          inventoryQuantity: number | null;
          availableForSale: boolean;
          image?: { url: string } | null;
          product: {
            id: string;
            title: string;
            featuredImage?: { url: string } | null;
          };
        }>;
      };
    };
    errors?: unknown;
  };
  if (!json.data)
    throw new Error(`SKU lookup failed: ${JSON.stringify(json.errors)}`);
  const nodes = json.data.productVariants.nodes;
  const variants: ResolvedSkuVariant[] = nodes.map((variant) => ({
    productId: variant.product.id,
    productTitle: variant.product.title,
    variantId: variant.id,
    variantTitle: variant.title,
    sku: variant.sku,
    imageUrl: variant.image?.url ?? variant.product.featuredImage?.url ?? null,
    inventoryQuantity: variant.inventoryQuantity,
    available: variant.availableForSale,
  }));
  const foundSkus = new Set(
    variants.map((variant) => variant.sku?.toLowerCase()).filter(Boolean),
  );
  const notFound = unique.filter(
    (sku) => !foundSkus.has(sku.toLowerCase()),
  );
  return { variants, notFound };
}

export async function syncCatalog(shop: string, admin: AdminClient) {
  let cursor: string | null = null;
  let synced = 0;
  let hasNextPage = true;
  while (hasNextPage) {
    const response = await admin.graphql(
      `#graphql
      query CatalogProducts($after: String) { products(first: 100, after: $after) { nodes { id title handle productType vendor tags collections(first: 250) { nodes { id } } featuredImage { url } variants(first: 250) { nodes { id title sku price inventoryQuantity inventoryItem { id } image { url } } pageInfo { hasNextPage endCursor } } } pageInfo { hasNextPage endCursor } } }`,
      { variables: { after: cursor } },
    );
    const json = (await response.json()) as {
      data?: {
        products: {
          nodes: ProductNode[];
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      };
      errors?: unknown;
    };
    if (!json.data)
      throw new Error(`Catalog sync failed: ${JSON.stringify(json.errors)}`);
    for (const product of json.data.products.nodes) {
      const variants = [...product.variants.nodes];
      let variantPage = product.variants.pageInfo;
      while (variantPage.hasNextPage) {
        const variantResponse = await admin.graphql(
          `#graphql query CatalogProductVariants($id: ID!, $after: String) { product(id: $id) { variants(first: 250, after: $after) { nodes { id title sku price inventoryQuantity inventoryItem { id } image { url } } pageInfo { hasNextPage endCursor } } } }`,
          { variables: { id: product.id, after: variantPage.endCursor } },
        );
        const variantJson = (await variantResponse.json()) as {
          data?: {
            product?: {
              variants: {
                nodes: VariantNode[];
                pageInfo: { hasNextPage: boolean; endCursor: string | null };
              };
            };
          };
          errors?: unknown;
        };
        if (!variantJson.data?.product)
          throw new Error(
            `Variant catalog sync failed: ${JSON.stringify(variantJson.errors)}`,
          );
        variants.push(...variantJson.data.product.variants.nodes);
        variantPage = variantJson.data.product.variants.pageInfo;
      }
      for (const variant of variants) {
        const inventoryQuantity = variant.inventoryQuantity ?? null;
        const collectionIds = product.collections.nodes.map(
          (collection) => collection.id,
        );
        await prisma.catalogVariant.upsert({
          where: { shop_variantId: { shop, variantId: variant.id } },
          update: {
            productId: product.id,
            productTitle: product.title,
            productHandle: product.handle,
            productType: product.productType,
            vendor: product.vendor,
            tags: product.tags,
            collectionIds,
            variantTitle: variant.title,
            sku: variant.sku,
            inventoryItemId: variant.inventoryItem?.id ?? null,
            imageUrl: variant.image?.url ?? product.featuredImage?.url ?? null,
            price: variant.price,
            inventoryQuantity,
            available: inventoryQuantity === null || inventoryQuantity > 0,
          },
          create: {
            shop,
            productId: product.id,
            productTitle: product.title,
            productHandle: product.handle,
            productType: product.productType,
            vendor: product.vendor,
            tags: product.tags,
            collectionIds,
            variantId: variant.id,
            inventoryItemId: variant.inventoryItem?.id ?? null,
            variantTitle: variant.title,
            sku: variant.sku,
            imageUrl: variant.image?.url ?? product.featuredImage?.url ?? null,
            price: variant.price,
            inventoryQuantity,
            available: inventoryQuantity === null || inventoryQuantity > 0,
          },
        });
        synced += 1;
      }
    }
    hasNextPage = json.data.products.pageInfo.hasNextPage;
    cursor = json.data.products.pageInfo.endCursor;
  }
  return synced;
}
