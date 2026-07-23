import prisma from "../db.server";
import {
  numericShopifyId,
  promotionSignature,
  encodeConditionsForFunction,
} from "./promotion-engine.server";
import { ensurePromotionSecret } from "./checkout-discount.server";
import type { PriceTier, RuleCondition } from "./promotions.types";

interface AdminClient {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
}

export async function ensureCartTransform(admin: AdminClient, shop: string): Promise<string> {
  const settings = await prisma.shopSettings.findUnique({ where: { shop } });
  if (settings?.cartTransformId) {
    return settings.cartTransformId;
  }

  // 1. Check if a CartTransform is already registered on the shop
  try {
    const listResponse = await admin.graphql(
      `#graphql
      query ListCartTransforms {
        cartTransforms(first: 10) {
          nodes { id functionId }
        }
      }`,
    );
    const listJson = (await listResponse.json()) as any;
    const existing = listJson.data?.cartTransforms?.nodes?.[0]?.id;
    if (existing) {
      await prisma.shopSettings.upsert({
        where: { shop },
        update: { cartTransformId: existing },
        create: { shop, cartTransformId: existing },
      });
      return existing;
    }
  } catch (err) {
    console.warn("Could not list CartTransforms:", err);
  }

  // 2. If not existing, create it using functionHandle
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

  const json = (await response.json()) as {
    data?: {
      cartTransformCreate?: {
        cartTransform?: { id: string };
        userErrors?: Array<{ message: string }>;
      };
    };
    errors?: Array<{ message: string }>;
  };

  const payload = json.data?.cartTransformCreate;
  const cartTransformId = payload?.cartTransform?.id;

  if (!cartTransformId) {
    // If creation failed, try listing again in case it was created concurrently
    const listResponse = await admin.graphql(
      `#graphql
      query ListCartTransformsRetry {
        cartTransforms(first: 10) {
          nodes { id functionId }
        }
      }`,
    );
    const listJson = (await listResponse.json()) as any;
    const existing = listJson.data?.cartTransforms?.nodes?.[0]?.id;
    if (existing) {
      await prisma.shopSettings.upsert({
        where: { shop },
        update: { cartTransformId: existing },
        create: { shop, cartTransformId: existing },
      });
      return existing;
    }

    const errorMsg =
      payload?.userErrors?.map((e) => e.message).join(", ") ||
      json.errors?.map((e) => e.message).join(", ") ||
      "Could not create Cart Transform instance.";
    throw new Error(errorMsg);
  }

  await prisma.shopSettings.upsert({
    where: { shop },
    update: { cartTransformId: cartTransformId },
    create: { shop, cartTransformId: cartTransformId },
  });

  return cartTransformId;
}

export async function syncCartTransformRules(admin: AdminClient, shop: string): Promise<void> {
  let cartTransformId: string | null = null;
  try {
    cartTransformId = await ensureCartTransform(admin, shop);
  } catch (err) {
    console.error("Failed to ensure CartTransform instance for shop:", shop, err);
    return;
  }

  const rules = await prisma.giftRule.findMany({
    where: { shop, enabled: true },
    orderBy: { priority: "asc" },
  });

  // The storefront client adds the gift as a REAL cart line and the checkout
  // Discount Function ($giftlab-checkout-discounts) later zeroes it — but only
  // if the line carries a valid HMAC signature over its rule/gift/conditions.
  // So the synced rules must ship each gift's signature + conditions blob (the
  // exact same encoding the app-proxy evaluate loader produces), letting the
  // client attach signed properties synchronously with no extra round trip.
  const secret = await ensurePromotionSecret(shop);

  const now = new Date();
  const validRules = rules.filter((rule) => {
    if (rule.startsAt && new Date(rule.startsAt) > now) return false;
    if (rule.endsAt && new Date(rule.endsAt) < now) return false;
    return true;
  });

  const formattedRules = validRules.map((rule) => {
    const { blob: conditionsBlob, unverifiable } = encodeConditionsForFunction(
      rule.matchMode || "ALL",
      (rule.conditions as unknown as RuleCondition[]) || [],
    );
    const rawGifts = (rule.gifts as any[]) || [];
    const gifts = rawGifts.map((gift) => {
      const variantId = String(numericShopifyId(gift.variantId || gift.variant_id));
      const quantity = Math.max(1, gift.quantity || 1);
      const discountType = gift.discountType || "FREE";
      const discountValue = gift.discountValue ?? 100;
      const signature = promotionSignature(
        secret,
        variantId,
        "free_gift_discount",
        rule.id,
        `${discountType}|${discountValue}|${quantity}|${unverifiable ? "UNVERIFIABLE" : conditionsBlob}`,
      );
      return { variantId, quantity, discountType, discountValue, signature };
    });

    const restrictions = (rule.restrictions as any) || {};

    return {
      id: rule.id,
      name: rule.name,
      matchMode: rule.matchMode || "ALL",
      conditions: (rule.conditions as unknown as RuleCondition[]) || [],
      gifts,
      conditionsBlob,
      unverifiable,
      notification: rule.notification || "",
      allowMultiple: rule.allowMultiple || false,
      maxGifts: rule.maxGifts || 1,
      stackable: rule.stackable || false,
      priority: rule.priority ?? 100,
      restrictions: {
        onePerOrder: restrictions.onePerOrder || false,
        onePerCustomer: restrictions.onePerCustomer || false,
        firstPurchaseOnly: restrictions.firstPurchaseOnly || false,
        allowedCustomerTags: restrictions.allowedCustomerTags || [],
        excludedCustomerTags: restrictions.excludedCustomerTags || [],
      },
    };
  });

  const metafieldValue = JSON.stringify(formattedRules);

  const shopRes = await admin.graphql(`query GetShopId { shop { id } }`);
  const shopData = (await shopRes.json()) as any;
  const shopId = shopData.data?.shop?.id;

  const metafieldsToSet: Array<{ ownerId: string; namespace: string; key: string; type: string; value: string }> = [
    {
      ownerId: cartTransformId,
      namespace: "$app:giftlab-gift-transform",
      key: "rules-config",
      type: "json",
      value: metafieldValue,
    },
  ];
  if (shopId) {
    metafieldsToSet.push({
      ownerId: shopId,
      namespace: "$app:giftlab-gift-transform",
      key: "rules-config",
      type: "json",
      value: metafieldValue,
    });
  }

  const response = await admin.graphql(
    `#graphql
    mutation SetCartTransformMetafield($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id }
        userErrors { field message }
      }
    }`,
    {
      variables: {
        metafields: metafieldsToSet,
      },
    },
  );

  const json = (await response.json()) as any;
  const userErrors = json.data?.metafieldsSet?.userErrors;
  if (userErrors && userErrors.length > 0) {
    console.error("User errors setting CartTransform rules metafield:", userErrors);
  } else {
    console.log("Successfully synced CartTransform rules metafield for shop:", shop, "metafieldValue:", metafieldValue);
  }
}

// Lets the storefront client cheaply tell "does this cart contain a mystery
// box parent line?" from just the variant id — no server round trip needed
// for carts that don't have one. This is NOT read by the Cart Transform
// Function (mystery boxes are real single lines already visible in the
// drawer/cart page; they don't have the gift's "invisible in the drawer"
// problem), so there's no cartTransformId-owned copy, only the shop-level one.
export async function syncMysteryBoxConfig(admin: AdminClient, shop: string): Promise<void> {
  const boxes = await prisma.mysteryBox.findMany({
    where: { shop, enabled: true },
    orderBy: { priority: "asc" },
  });

  const now = new Date();
  const activeBoxes = boxes.filter((box) => {
    if (box.startsAt && new Date(box.startsAt) > now) return false;
    if (box.endsAt && new Date(box.endsAt) < now) return false;
    return true;
  });

  // Every quantity-tier discount's signature (see the identical formula in
  // mysteryMutations, promotion-engine.server.ts:813-819) depends only on the
  // box + tier configuration — never on the shopper's chosen quantity — so it
  // can be precomputed once here for every configured tier instead of only
  // at reconcile time. That's what lets the client apply the correct tier's
  // signed properties in the SAME /cart/change.js request that changes the
  // quantity: without this, bumping quantity showed the undiscounted price
  // for a beat (then a follow-up call corrected it), and dropping back below
  // a tier's threshold left the old discount visibly applied for a beat too.
  const secret = await ensurePromotionSecret(shop);
  const formattedBoxes = activeBoxes.map((box) => {
    // BOGO boxes have no shadow product/boxVariantId of their own to sign a
    // price-tier discount onto — tiers only apply to a standard priced box.
    const tiers = !box.boxVariantId
      ? []
      : ((box.priceTiers as unknown as PriceTier[]) ?? [])
          .map((tier) => {
            const triggerProductId = String(numericShopifyId(box.parentProductId));
            const triggerVariantId = box.parentVariantId ? String(numericShopifyId(box.parentVariantId)) : "";
            const signature = promotionSignature(
              secret,
              String(numericShopifyId(box.boxVariantId as string)),
              "price",
              box.id,
              `${tier.adjustmentType}|${tier.value}|${triggerProductId}|${triggerVariantId}`,
            );
            return {
              minQuantity: tier.minQuantity,
              adjustmentType: tier.adjustmentType,
              value: tier.value,
              triggerProductId,
              triggerVariantId,
              signature,
            };
          })
          .sort((a, b) => b.minQuantity - a.minQuantity);

    return {
      id: box.id,
      name: box.name,
      parentVariantId: box.parentVariantId ? String(numericShopifyId(box.parentVariantId)) : null,
      boxVariantId: box.boxVariantId ? String(numericShopifyId(box.boxVariantId)) : null,
      isBogo: Boolean((box.bogo as { enabled?: boolean } | null)?.enabled),
      maxPerOrder: box.maxPerOrder ?? null,
      // The box's true per-unit price in CENTS. The storefront uses this to
      // price a tiered box for gift-eligibility instead of the cart line's own
      // `price`, which Shopify reports at line level (unit × quantity)
      // transiently right after a cart mutation before settling to per-unit —
      // reading that transient value made a subtotal-gated gift wrongly appear
      // (and then never leave). A config value is stable and correct the
      // instant it's read.
      basePrice: box.boxVariantId ? Math.round(Number(box.boxPrice) * 100) : null,
      tiers,
    };
  });

  const metafieldValue = JSON.stringify(formattedBoxes);

  const shopRes = await admin.graphql(`query GetShopIdForMystery { shop { id } }`);
  const shopData = (await shopRes.json()) as any;
  const shopId = shopData.data?.shop?.id;
  if (!shopId) {
    console.error("Could not resolve shop id to sync mystery-config metafield for shop:", shop);
    return;
  }

  const response = await admin.graphql(
    `#graphql
    mutation SetMysteryConfigMetafield($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id }
        userErrors { field message }
      }
    }`,
    {
      variables: {
        metafields: [
          {
            ownerId: shopId,
            namespace: "$app:giftlab-gift-transform",
            key: "mystery-config",
            type: "json",
            value: metafieldValue,
          },
        ],
      },
    },
  );

  const json = (await response.json()) as any;
  const userErrors = json.data?.metafieldsSet?.userErrors;
  if (userErrors && userErrors.length > 0) {
    console.error("User errors setting mystery-config metafield:", userErrors);
  } else {
    console.log("Successfully synced mystery-config metafield for shop:", shop, "metafieldValue:", metafieldValue);
  }
}
