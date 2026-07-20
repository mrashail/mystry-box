import type { RuleCondition } from "./promotions.types";

type AdminClient = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
};

const RESOURCE_FIELDS = new Set(["product", "variant", "collection"]);

// The condition itself only stores raw product/variant/collection GIDs, so
// their display names have to be resolved separately for the editor to show
// something readable instead of "gid://shopify/Product/...".
export async function resolveConditionLabels(
  admin: AdminClient,
  conditions: RuleCondition[],
): Promise<Record<string, string>> {
  const resourceIds = Array.from(
    new Set(
      conditions
        .filter((item) => RESOURCE_FIELDS.has(item.field))
        .flatMap((item) => (Array.isArray(item.value) ? item.value : [item.value]))
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  );
  if (!resourceIds.length) return {};

  const response = await admin.graphql(
    `#graphql
    query ConditionLabels($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on Product { id title }
        ... on ProductVariant { id title product { title } }
        ... on Collection { id title }
      }
    }`,
    { variables: { ids: resourceIds } },
  );
  const data = await response.json();
  const labels: Record<string, string> = {};
  for (const node of data.data?.nodes ?? []) {
    if (!node) continue;
    if (node.product) {
      labels[node.id] =
        node.title && node.title !== "Default Title"
          ? `${node.product.title} — ${node.title}`
          : node.product.title;
    } else if (node.title) {
      labels[node.id] = node.title;
    }
  }
  return labels;
}
