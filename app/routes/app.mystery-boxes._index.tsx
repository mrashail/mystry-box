import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

// Superseded by the unified /app/rules hub. Kept only as a redirect so the old
// path still resolves; the previous action toggled/duplicated boxes without
// syncing the Shopify discount or shadow product, so it's replaced with a
// redirect to prevent a stray POST from desyncing state.
export async function loader({ request }: LoaderFunctionArgs) {
  const { redirect } = await authenticate.admin(request);
  return redirect("/app/rules");
}

export async function action({ request }: ActionFunctionArgs) {
  const { redirect } = await authenticate.admin(request);
  return redirect("/app/rules");
}

export default function MysteryBoxes() {
  return null;
}
