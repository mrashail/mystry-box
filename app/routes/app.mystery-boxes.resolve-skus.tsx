import type { ActionFunctionArgs } from "react-router";
import { resolveSkus } from "../lib/catalog.server";
import { authenticate } from "../shopify.server";

export async function action({ request }: ActionFunctionArgs) {
  const { admin } = await authenticate.admin(request);
  const form = await request.formData();
  const skus = String(form.get("skus") ?? "")
    .split(/[\n,]/)
    .map((sku) => sku.trim())
    .filter(Boolean);
  if (!skus.length) return { variants: [], notFound: [] };
  return resolveSkus(admin, skus);
}
