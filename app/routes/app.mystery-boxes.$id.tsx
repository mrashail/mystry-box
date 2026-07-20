import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import {
  MysteryBoxEditor,
  type MysteryEditorValue,
} from "../components/MysteryBoxEditor";
import { mysteryFormData } from "../lib/forms.server";
import { syncMysteryBoxProduct } from "../lib/mystery-box-product.server";
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

  // Always a single hidden variant, regardless of how many items are in the
  // pool — the real per-child data never becomes a storefront-visible option.
  const { boxProductId, boxVariantId } = await syncMysteryBoxProduct(admin, {
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

  let shopifyDiscountId = box.shopifyDiscountId;
  if (parsed.data.enabled && !shopifyDiscountId) {
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
  } else if (!parsed.data.enabled && shopifyDiscountId) {
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
  return redirect("/app/rules");
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
