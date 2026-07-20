import { randomUUID } from "node:crypto";
import prisma from "../db.server";

interface AdminClient {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
}

// Every shop needs a stable secret so the checkout Function can verify that a
// line's "free" properties were really signed by this app, not forged by a
// shopper. Created lazily the first time any rule needs a discount.
export async function ensurePromotionSecret(shop: string) {
  const settings = await prisma.shopSettings.upsert({
    where: { shop },
    update: {},
    create: { shop },
  });
  if (settings.promotionSecret) return settings.promotionSecret;
  const secret = randomUUID();
  await prisma.shopSettings.update({ where: { shop }, data: { promotionSecret: secret } });
  return secret;
}

// Gives a Free Gift Rule or Mystery Box its own real, named entry in Shopify's
// native Discounts admin — same underlying checkout Function as every other
// rule, just a separate visible instance so merchants can see/schedule each
// promotion from Shopify's own UI. Native "Buy X Get Y" discounts can't do
// this job themselves: they only discount items a shopper already added,
// they can't auto-add the free item the way this app's rules do.
export async function createPromotionDiscount(
  admin: AdminClient,
  { title, secret }: { title: string; secret: string },
) {
  const response = await admin.graphql(
    `#graphql
    mutation CreateGiftLabDiscount($input: DiscountAutomaticAppInput!) {
      discountAutomaticAppCreate(automaticAppDiscount: $input) {
        automaticAppDiscount { discountId }
        userErrors { field message }
      }
    }`,
    {
      variables: {
        input: {
          title,
          functionHandle: "giftlab-checkout-discounts",
          discountClasses: ["PRODUCT"],
          startsAt: new Date().toISOString(),
          combinesWith: {
            orderDiscounts: true,
            productDiscounts: true,
            shippingDiscounts: true,
          },
        },
      },
    },
  );
  const json = (await response.json()) as {
    data?: {
      discountAutomaticAppCreate?: {
        automaticAppDiscount?: { discountId: string };
        userErrors: Array<{ message: string }>;
      };
    };
    errors?: Array<{ message: string }>;
  };
  const payload = json.data?.discountAutomaticAppCreate;
  const discountId = payload?.automaticAppDiscount?.discountId;
  if (!discountId) {
    const message =
      payload?.userErrors.map((item) => item.message).join(", ") ||
      json.errors?.map((item) => item.message).join(", ") ||
      "Could not create the checkout discount.";
    throw new Error(message);
  }

  const configResponse = await admin.graphql(
    `#graphql
    mutation ConfigureGiftLabDiscount($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) { metafields { id } userErrors { field message } }
    }`,
    {
      variables: {
        metafields: [
          {
            ownerId: discountId,
            namespace: "$app:giftlab-checkout-discounts",
            key: "signature-secret",
            type: "single_line_text_field",
            value: secret,
          },
        ],
      },
    },
  );
  const configJson = (await configResponse.json()) as {
    data?: {
      metafieldsSet?: {
        metafields?: Array<{ id: string }>;
        userErrors: Array<{ message: string }>;
      };
    };
  };
  const configErrors = configJson.data?.metafieldsSet?.userErrors ?? [];
  if (configErrors.length || !configJson.data?.metafieldsSet?.metafields?.length) {
    await admin.graphql(
      `#graphql mutation CleanupGiftLabDiscount($id: ID!) { discountAutomaticDelete(id: $id) { deletedAutomaticDiscountId userErrors { message } } }`,
      { variables: { id: discountId } },
    );
    throw new Error(
      configErrors.map((item) => item.message).join(", ") ||
        "Checkout security configuration could not be saved.",
    );
  }

  return discountId;
}

export async function deletePromotionDiscount(admin: AdminClient, discountId: string) {
  // Best-effort: disabling/deleting a rule in this app should never get stuck
  // because Shopify's side of it is already gone (e.g. removed manually).
  try {
    const response = await admin.graphql(
      `#graphql mutation DeleteGiftLabDiscount($id: ID!) { discountAutomaticDelete(id: $id) { deletedAutomaticDiscountId userErrors { message } } }`,
      { variables: { id: discountId } },
    );
    const json = (await response.json()) as {
      data?: {
        discountAutomaticDelete?: {
          deletedAutomaticDiscountId?: string;
          userErrors: Array<{ message: string }>;
        };
      };
    };
    const errors = json.data?.discountAutomaticDelete?.userErrors ?? [];
    if (errors.length) {
      console.warn(
        `GiftLab: could not delete checkout discount ${discountId} due to Shopify userErrors:`,
        errors.map((item) => item.message).join(", "),
      );
    } else {
      console.log("GiftLab: successfully deleted checkout discount", discountId);
    }
  } catch (error) {
    console.warn("GiftLab: exception while deleting checkout discount", error);
  }
}
