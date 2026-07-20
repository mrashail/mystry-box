import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
} from "react-router";
import { syncCatalog } from "../lib/catalog.server";
import { checked, integer, text } from "../lib/forms.server";
import { createPromotionDiscount, ensurePromotionSecret } from "../lib/checkout-discount.server";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";

type ActionResult = {
  saved: boolean;
  synced: number;
  repaired: number;
  error: string;
};

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const [settings, catalogCount, missingDiscounts] = await Promise.all([
    prisma.shopSettings.upsert({
      where: { shop: session.shop },
      update: {},
      create: { shop: session.shop },
    }),
    prisma.catalogVariant.count({ where: { shop: session.shop } }),
    Promise.all([
      prisma.giftRule.count({ where: { shop: session.shop, enabled: true, shopifyDiscountId: null } }),
      prisma.mysteryBox.count({ where: { shop: session.shop, enabled: true, shopifyDiscountId: null } }),
    ]).then(([gifts, boxes]) => gifts + boxes),
  ]);

  return { settings, catalogCount, missingDiscounts };
}

export async function action({
  request,
}: ActionFunctionArgs): Promise<ActionResult> {
  const { session, admin } = await authenticate.admin(request);
  const form = await request.formData();
  if (form.get("intent") === "sync")
    return {
      synced: await syncCatalog(session.shop, admin),
      saved: false,
      repaired: 0,
      error: "",
    };

  if (form.get("intent") === "repair-discounts") {
    const secret = await ensurePromotionSecret(session.shop);
    const [gifts, boxes] = await Promise.all([
      prisma.giftRule.findMany({ where: { shop: session.shop, enabled: true, shopifyDiscountId: null } }),
      prisma.mysteryBox.findMany({ where: { shop: session.shop, enabled: true, shopifyDiscountId: null } }),
    ]);
    let repaired = 0;
    const errors: string[] = [];
    for (const rule of gifts) {
      try {
        const shopifyDiscountId = await createPromotionDiscount(admin, {
          title: `Free gift: ${rule.name}`,
          secret,
        });
        await prisma.giftRule.update({ where: { id: rule.id }, data: { shopifyDiscountId } });
        repaired += 1;
      } catch (error) {
        errors.push(`${rule.name}: ${error instanceof Error ? error.message : "failed"}`);
      }
    }
    for (const box of boxes) {
      try {
        const isBogo = (box.bogo as { enabled?: boolean } | null)?.enabled;
        const shopifyDiscountId = await createPromotionDiscount(admin, {
          title: `${isBogo ? "Mystery Box BOGO" : "Mystery box"}: ${box.name}`,
          secret,
        });
        await prisma.mysteryBox.update({ where: { id: box.id }, data: { shopifyDiscountId } });
        repaired += 1;
      } catch (error) {
        errors.push(`${box.name}: ${error instanceof Error ? error.message : "failed"}`);
      }
    }
    return { saved: false, synced: 0, repaired, error: errors.join(", ") };
  }

  await prisma.shopSettings.upsert({
    where: { shop: session.shop },
    create: { shop: session.shop },
    update: {
      storefrontEnabled: checked(form, "storefrontEnabled"),
      giftMessageEnabled: checked(form, "giftMessageEnabled"),
      giftMessage: text(form, "giftMessage"),
      mysteryMessage: text(form, "mysteryMessage"),
      conflictStrategy: text(form, "conflictStrategy", "PRIORITY"),
      maxAutomaticAdds: integer(form, "maxAutomaticAdds", 10, 1),
    },
  });
  return {
    saved: true,
    synced: 0,
    repaired: 0,
    error: "",
  };
}

export default function Settings() {
  const { settings, catalogCount, missingDiscounts } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const busy = navigation.state === "submitting";

  return (
    <s-page heading="Settings">
      {result?.saved && <s-banner tone="success">Settings saved.</s-banner>}
      {result?.synced ? (
        <s-banner tone="success">Synced {result.synced} product variants.</s-banner>
      ) : null}
      {result?.repaired ? (
        <s-banner tone="success">
          Activated checkout discount for {result.repaired} rule
          {result.repaired === 1 ? "" : "s"}.
        </s-banner>
      ) : null}
      {result?.error && <s-banner tone="critical">{result.error}</s-banner>}

      <s-section heading="Storefront automation">
        <Form method="post">
          <s-stack direction="block" gap="base">
            <s-paragraph color="subdued">Master controls for cart processing.</s-paragraph>
            <s-switch
              label="Enable storefront automation"
              details="Evaluate gifts and mystery boxes after cart changes"
              name="storefrontEnabled"
              defaultChecked={settings.storefrontEnabled}
            ></s-switch>
            <s-switch
              label="Show gift notification"
              details="Display a discreet toast after automatic additions"
              name="giftMessageEnabled"
              defaultChecked={settings.giftMessageEnabled}
            ></s-switch>
            <s-text-field
              label="Free gift message"
              name="giftMessage"
              value={settings.giftMessage ?? ""}
            ></s-text-field>
            <s-text-field
              label="Mystery box message"
              name="mysteryMessage"
              value={settings.mysteryMessage ?? ""}
            ></s-text-field>
            <s-grid gridTemplateColumns="1fr 1fr" gap="base">
              <s-select
                label="Rule conflict strategy"
                name="conflictStrategy"
                value={settings.conflictStrategy}
              >
                <s-option value="PRIORITY">Priority order</s-option>
                <s-option value="STACK_ALL">Stack every match</s-option>
                <s-option value="FIRST_MATCH">First match only</s-option>
              </s-select>
              <s-number-field
                label="Automatic-add safety limit"
                min={1}
                name="maxAutomaticAdds"
                value={String(settings.maxAutomaticAdds)}
              ></s-number-field>
            </s-grid>
            <div>
              <s-button type="submit" variant="primary" disabled={busy}>
                {busy ? "Saving…" : "Save settings"}
              </s-button>
            </div>
          </s-stack>
        </Form>
      </s-section>
 
      <s-section slot="aside" heading="Protected gift pricing">
        <s-stack direction="block" gap="base">
          <s-text color="subdued">CHECKOUT FUNCTION</s-text>
          <s-paragraph color="subdued">
            Every Free Gift Rule and Mystery Box gets its own signed,
            automatic discount in Shopify the moment you turn it on — no
            manual activation needed. Signed cart markers prevent customers
            from forging free items; the Function also applies quantity
            tiers.
          </s-paragraph>
          {missingDiscounts > 0 ? (
            <s-stack direction="block" gap="base">
              <s-banner tone="warning">
                {missingDiscounts} active rule
                {missingDiscounts === 1 ? "" : "s"} missing its checkout
                discount.
              </s-banner>
              <Form method="post">
                <input type="hidden" name="intent" value="repair-discounts" />
                <s-button type="submit" variant="primary">
                  Fix now
                </s-button>
              </Form>
            </s-stack>
          ) : (
            <s-banner tone="success">All rules secured</s-banner>
          )}
        </s-stack>
      </s-section>
 
      <s-section slot="aside" heading="Manual sync">
        <s-stack direction="block" gap="base">
          <s-paragraph color="subdued">Updates our cache from Shopify catalog.</s-paragraph>
          <s-box padding="base" background="subdued" borderRadius="base">
            <s-stack direction="block" gap="small-100" alignItems="center">
              <s-text type="strong">{catalogCount}</s-text>
              <s-text color="subdued">Synced variants</s-text>
            </s-stack>
          </s-box>
          <Form method="post">
            <input type="hidden" name="intent" value="sync" />
            <s-button type="submit" variant="primary">
              Sync catalog now
            </s-button>
          </Form>
        </s-stack>
      </s-section>

        <s-section slot="aside" heading="Theme integration">
          <s-paragraph>
            Enable "GiftLab Cart Engine" once in the Shopify theme editor. It
            uses Shopify&apos;s app extension system and never edits theme
            files.
          </s-paragraph>
        </s-section>
    </s-page>
  );
}
