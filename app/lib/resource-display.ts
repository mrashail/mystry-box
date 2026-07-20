// Shared display helpers for the gift / mystery-box editors. Pure UI logic,
// safe to import from client components (no server-only dependencies).

// The App Bridge resource picker exposes an image on either the variant or
// the product, and the field name has drifted across versions
// (image/originalSrc/url/src), so probe all of them defensively.
export function resourceImage(product: any, variant?: any): string | undefined {
  const fromVariant =
    variant?.image?.originalSrc ?? variant?.image?.url ?? variant?.image?.src;
  const firstProductImage = product?.images?.[0];
  const fromProduct =
    firstProductImage?.originalSrc ??
    firstProductImage?.url ??
    firstProductImage?.src ??
    product?.featuredImage?.url ??
    product?.featuredImage?.originalSrc;
  return fromVariant ?? fromProduct ?? undefined;
}

// A single "Default Title" variant carries no extra information beyond the
// product name, so showing "Ski Wax" then "Ski Wax" again reads as a bug.
// Only surface the variant title when it actually distinguishes the variant.
export function meaningfulVariantTitle(
  productTitle?: string | null,
  variantTitle?: string | null,
): string | null {
  if (!variantTitle) return null;
  const generic = ["default title", "default"];
  if (generic.includes(variantTitle.trim().toLowerCase())) return null;
  if (variantTitle.trim() === productTitle?.trim()) return null;
  return variantTitle;
}
