import prisma from "../db.server";
import {
  numericShopifyId,
  promotionSignature,
  encodeConditionsForFunction,
} from "./promotion-engine.server";
import { ensurePromotionSecret } from "./checkout-discount.server";
import type { RuleCondition } from "./promotions.types";

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
