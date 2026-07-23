import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import {
  MysteryBoxEditor,
  type MysteryEditorValue,
} from "../components/MysteryBoxEditor";
import { mysteryFormData } from "../lib/forms.server";
import { syncMysteryBoxProduct } from "../lib/mystery-box-product.server";
import { syncMysteryBoxConfig } from "../lib/cart-transform.server";
import { findVariantConflicts, conflictErrorMessage } from "../lib/product-conflicts.server";
import {
  createPromotionDiscount,
  deletePromotionDiscount,
  ensurePromotionSecret,
} from "../lib/checkout-discount.server";
import type {
  BogoConfiguration,
  MatchingRule,
  PriceTier,
} from "../lib/promotions.types";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const [box, boxes] = await Promise.all([
    prisma.mysteryBox.findFirst({
      where: { id: params.id, shop: session.shop },
      include: { children: { orderBy: { position: "asc" } } },
    }),
    prisma.mysteryBox.findMany({
      where: { shop: session.shop },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
  ]);
  if (!box) throw new Response("Not found", { status: 404 });
  // Convert the Decimal here, server-side — React Router's loader data
  // serialization doesn't know how to carry a Prisma Decimal instance across
  // the wire intact, so leaving it as-is silently turns into 0 on the client
  // (and then gets written back as 0 the next time the rule is saved).
  return { box: { ...box, boxPrice: Number(box.boxPrice) }, boxes };
}
export async function action({ request, params }: ActionFunctionArgs) {
  const { session, admin, redirect } = await authenticate.admin(request);
  const box = await prisma.mysteryBox.findFirst({
    where: { id: params.id, shop: session.shop },
  });
  if (!box) throw new Response("Not found", { status: 404 });
  const form = await request.formData();
  const parsed = mysteryFormData(form);
  const isBogo = (parsed.data.bogo as any)?.enabled;
  const priceTiers = (parsed.data.priceTiers as any[]) || [];

  if (
    !parsed.data.name ||
    (isBogo && !parsed.parent.productId) ||
    (!parsed.children.length && !parsed.matchingRules.length)
  )
    return Response.json(
      {
        error:
          "Name, trigger product (for BOGO), and at least one child or matching rule are required.",
      },
      { status: 400 },
    );

  // A standard mystery box is a product the shopper pays for — it must have a
  // real price (BOGO boxes price off their trigger product, so they're exempt).
  if (!isBogo && !(Number(parsed.data.boxPrice) > 0))
    return Response.json(
      { error: "Please set a box price greater than 0 before saving." },
      { status: 400 },
    );

  // A product may only be used in one promotion at a time — block a pool child
  // already awarded by a gift rule or pooled in ANOTHER box (this box excluded)
  // before any Shopify side effects run (see findVariantConflicts).
  const conflicts = await findVariantConflicts(
    session.shop,
    { boxId: box.id },
    parsed.children.map((child) => child.variantId),
  );
  if (conflicts.length) {
    return Response.json({ error: conflictErrorMessage(conflicts) }, { status: 400 });
  }

  // Always a single hidden variant, regardless of how many items are in the
  // pool — the real per-child data never becomes a storefront-visible option.
  const { boxProductId, boxVariantId } = await syncMysteryBoxProduct(admin, session.shop, {
    boxProductId: box.boxProductId,
    boxVariantId: box.boxVariantId,
    name: parsed.data.name,
    boxPrice: parsed.data.boxPrice,
    boxImageUrl: parsed.data.boxImageUrl,
  });

  const finalParentId = isBogo ? parsed.parent.productId : boxProductId;
  const finalParentTitle = isBogo ? parsed.parent.productTitle : parsed.data.name;
  const finalParentVariantId = isBogo ? parsed.parent.variantId || null : boxVariantId;
  const finalParentVariantTitle = isBogo ? parsed.parent.variantTitle || null : "Default Title";

  // Only BOGO or price-tier boxes need a native Discounts-page entry; a plain
  // priced box needs none. Create it when newly needed, and remove a stale one
  // if the box is disabled OR no longer has tiers/BOGO.
  const needsDiscount = isBogo || priceTiers.length > 0;

  let shopifyDiscountId = box.shopifyDiscountId;
  if (parsed.data.enabled && needsDiscount && !shopifyDiscountId) {
    try {
      const secret = await ensurePromotionSecret(session.shop);
      shopifyDiscountId = await createPromotionDiscount(admin, {
        title: `${isBogo ? "Mystery Box BOGO" : "Mystery box"}: ${parsed.data.name}`,
        secret,
      });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "Could not activate the checkout discount for this box." },
        { status: 400 },
      );
    }
  } else if ((!parsed.data.enabled || !needsDiscount) && shopifyDiscountId) {
    await deletePromotionDiscount(admin, shopifyDiscountId);
    shopifyDiscountId = null;
  }

  await prisma.$transaction([
    prisma.mysteryBoxChild.deleteMany({ where: { mysteryBoxId: box.id } }),
    prisma.mysteryBox.update({
      where: { id: box.id },
      data: {
        ...parsed.data,
        parentProductId: finalParentId,
        parentProductTitle: finalParentTitle,
        parentVariantId: finalParentVariantId,
        parentVariantTitle: finalParentVariantTitle,
        boxProductId,
        boxVariantId,
        shopifyDiscountId,
        children: {
          create: parsed.children.map((child, position) => ({
            productId: child.productId,
            productTitle: child.productTitle,
            variantId: child.variantId,
            variantTitle: child.variantTitle,
            sku: child.sku || null,
            imageUrl: child.imageUrl || null,
            inventoryQuantity: child.inventoryQuantity ?? null,
            available: child.available ?? true,
            weight: child.weight ?? 1,
            position,
          })),
        },
      },
    }),
  ]);
  // Best-effort storefront sync — the box is already saved, so a transient
  // sync failure must not error out over a committed row; retried next save.
  try {
    await syncMysteryBoxConfig(admin, session.shop);
  } catch (error) {
    console.error("Mystery box updated, but storefront sync failed (will retry on next save):", error);
  }
  // Stay on this box's own edit page after saving instead of the rules list.
  return redirect(`/app/mystery-boxes/${box.id}`);
}

export default function EditMysteryBox() {
  const { box, boxes } = useLoaderData<typeof loader>();
  const value: MysteryEditorValue = {
    ...box,
    boxPrice: Number(box.boxPrice),
    matchingRules: box.matchingRules as unknown as MatchingRule[],
    priceTiers: box.priceTiers as unknown as PriceTier[],
    bogo: box.bogo as unknown as BogoConfiguration,
    restrictions: box.restrictions as MysteryEditorValue["restrictions"],
    startsAt: box.startsAt?.toISOString(),
    endsAt: box.endsAt?.toISOString(),
    children: box.children,
  };
  return (
    <MysteryBoxEditor
      availableBoxes={boxes}
      title={`Edit ${box.name}`}
      value={value}
    />
  );
}
