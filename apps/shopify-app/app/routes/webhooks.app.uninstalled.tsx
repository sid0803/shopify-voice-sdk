import type { ActionFunctionArgs } from "react-router";
import { authenticate, sessionStorage } from "../shopify.server";
import { getStores } from "../lib/stores.server";

/**
 * app/uninstalled: revoke the offline token, stop calling, keep historical
 * call rows until the mandatory shop/redact topic arrives.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  let context: Awaited<ReturnType<typeof authenticate.webhook>>;
  try {
    context = await authenticate.webhook(request);
  } catch {
    return new Response("bad signature", { status: 401 });
  }

  const { shop, webhookId } = context;
  const stores = await getStores();
  try {
    if (!(await stores.claims.claim(webhookId))) return new Response("duplicate", { status: 200 });

    const settings = await stores.settings.get(shop);
    if (settings) await stores.settings.save({ ...settings, enabled: false });
    await stores.shops.remove(shop);
    await stores.queue.deleteForShop?.(shop);

    const sessions = await sessionStorage.findSessionsByShop(shop);
    if (sessions.length > 0) {
      await sessionStorage.deleteSessions(sessions.map((s) => s.id));
    }
  } catch (err) {
    await Promise.resolve(stores.claims.release(webhookId)).catch(() => undefined);
    console.error("[app/uninstalled] failed", String((err as Error)?.message ?? err));
    return new Response("transient", { status: 503 });
  }

  return new Response("uninstalled", { status: 200 });
};
