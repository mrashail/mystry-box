import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useSearchParams } from "react-router";
import { MysteryBoxEditor } from "../components/MysteryBoxEditor";
import { mysteryFormData } from "../lib/forms.server";
import { syncMysteryBoxProduct, deleteMysteryBoxProduct } from "../lib/mystery-box-product.server";
import { createPromotionDiscount, deletePromotionDiscount, ensurePromotionSecret } from "../lib/checkout-discount.server";
import { syncMysteryBoxConfig } from "../lib/cart-transform.server";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";

export async function action({ request }: ActionFunctionArgs) {
  const { session, admin, redirect } = await authenticate.admin(request);
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

  // A standard mystery box IS a product the shopper pays for, so it must have a
  // real price — a $0 box would be given away free. (BOGO boxes are priced off
  // their trigger product, so this doesn't apply to them.)
  if (!isBogo && !(Number(parsed.data.boxPrice) > 0))
    return Response.json(
      { error: "Please set a box price greater than 0 before saving." },
      { status: 400 },
    );

  // Automatically create or sync Mystery Box product in Shopify — always a
  // single hidden variant, regardless of how many items are in the pool.
  const { boxProductId, boxVariantId } = await syncMysteryBoxProduct(admin, session.shop, {
    name: parsed.data.name,
    boxPrice: parsed.data.boxPrice,
    boxImageUrl: parsed.data.boxImageUrl,
  });

  const finalParentId = isBogo ? parsed.parent.productId : boxProductId;
  const finalParentTitle = isBogo ? parsed.parent.productTitle : parsed.data.name;
  const finalParentVariantId = isBogo ? parsed.parent.variantId || null : boxVariantId;
  const finalParentVariantTitle = isBogo ? parsed.parent.variantTitle || null : "Default Title";

  // Only a box whose checkout Function actually does something needs a native
  // Discounts-page entry: BOGO (zeroes the bonus line) or progressive price
  // tiers (adjusts the box price by quantity). A plain box is just a priced
  // product — creating an empty automatic discount for it only clutters the
  // merchant's Discounts page and does nothing.
  const needsDiscount = isBogo || priceTiers.length > 0;

  let shopifyDiscountId: string | null = null;
  if (parsed.data.enabled && needsDiscount) {
    try {
      const secret = await ensurePromotionSecret(session.shop);
      shopifyDiscountId = await createPromotionDiscount(admin, {
        title: `${isBogo ? "Mystery Box BOGO" : "Mystery box"}: ${parsed.data.name}`,
        secret,
      });
    } catch (error) {
      // The shadow product was already created above; don't leave it orphaned
      // in the catalog when the discount step fails (e.g. Function not yet
      // deployed) — every retry would otherwise pile up another dead product.
      if (boxProductId) await deleteMysteryBoxProduct(admin, boxProductId);
      return Response.json(
        { error: error instanceof Error ? error.message : "Could not activate the checkout discount for this box." },
        { status: 400 },
      );
    }
  }

  let createdBox;
  try {
    createdBox = await prisma.mysteryBox.create({
      data: {
        shop: session.shop,
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
    });
  } catch (error) {
    // Roll back the Shopify-side resources so a failed DB insert can't strand
    // an orphan product + discount that no rule row owns.
    if (shopifyDiscountId) await deletePromotionDiscount(admin, shopifyDiscountId);
    if (boxProductId) await deleteMysteryBoxProduct(admin, boxProductId);
    return Response.json(
      { error: error instanceof Error ? error.message : "Could not save this mystery box." },
      { status: 500 },
    );
  }
  await syncMysteryBoxConfig(admin, session.shop);
  // Land on the new box's own edit page so the merchant stays in the form.
  return redirect(`/app/mystery-boxes/${createdBox.id}`);
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  return {
    boxes: await prisma.mysteryBox.findMany({
      where: { shop: session.shop },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
  };
}

export default function NewMysteryBox() {
  const { boxes } = useLoaderData<typeof loader>();
  const [searchParams] = useSearchParams();
  const isBogo = searchParams.get("type") === "BOGO";
  return (
    <MysteryBoxEditor
      availableBoxes={boxes}
      title={isBogo ? "Create Mystery Box BOGO" : "Create mystery box"}
      value={{
        name: "",
        enabled: true,
        priority: 100,
        parentProductId: "",
        parentProductTitle: "",
        selectionMethod: "RANDOM",
        inventoryBehavior: "IN_STOCK_ONLY",
        selectionCount: 1,
        allowDuplicateChoices: false,
        boxPrice: 0,
        boxImageUrl: null,
        matchingRules: [],
        priceTiers: [],
        bogo: {
          enabled: isBogo,
          buyQuantity: 1,
          freeQuantity: 1,
          target: "SAME_BOX",
        },
        restrictions: {},
        children: [],
      }}
    />
  );
}
