import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

// This index route was superseded by the unified /app/rules hub. It is kept
// only so the old path still resolves (redirect) — all rule mutations now go
// through /app/rules, which keeps each rule's Shopify discount in sync. The
// old action here toggled `enabled` WITHOUT creating/removing the backing
// discount, so it's replaced with a redirect to avoid a stray POST desyncing
// rule state from checkout behavior.
export async function loader({ request }: LoaderFunctionArgs) {
  const { redirect } = await authenticate.admin(request);
  return redirect("/app/rules");
}

export async function action({ request }: ActionFunctionArgs) {
  const { redirect } = await authenticate.admin(request);
  return redirect("/app/rules");
}

export default function GiftRules() {
  return null;
}
