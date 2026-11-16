// Shared dispatcher for Shopify's mandatory GDPR compliance webhooks.
// Shopify sends all compliance topics to one URI, so the topic comes from the
// authenticated webhook context rather than the path.
import { extractCustomerId, handleGdprWebhook, type GdprTopic } from "@techladder/adapter-shopify";
import { authenticate, sessionStorage } from "../shopify.server";
import { getStores } from "./stores.server";

export async function handleGdprRoute(request: Request, fallbackTopic?: string) {
  let context: Awaited<ReturnType<typeof authenticate.webhook>>;
  try {
    context = await authenticate.webhook(request);
  } catch {
    return new Response("bad signature", { status: 401 });
  }

  const topic = String(context.topic ?? fallbackTopic ?? "").toLowerCase().replace(/^gdpr_/, "");
  const topicMap: Record<string, GdprTopic> = {
    customers_data_request: "customers/data_request",
    customers_redact: "customers/redact",
    shop_redact: "shop/redact",
    app_uninstalled: "app/uninstalled",
  };
  const normalized = topicMap[topic] ?? topic;

  const { shop, payload, webhookId } = context;
  const stores = await getStores();
  try {
    if (!(await stores.claims.claim(webhookId))) return new Response("duplicate", { status: 200 });
    const out = await handleGdprWebhook(normalized, shop, stores.gdpr, payload);
    if (normalized === "customers/redact") {
      const customerId = extractCustomerId((payload ?? {}) as Record<string, unknown>);
      if (customerId) await stores.queue.deleteForCustomer?.(shop, customerId);
    }
    if (normalized === "shop/redact" || normalized === "app/uninstalled") {
      await stores.queue.deleteForShop?.(shop);
    }
    if (normalized === "shop/redact") {
      const sessions = await sessionStorage.findSessionsByShop(shop);
      if (sessions.length > 0) await sessionStorage.deleteSessions(sessions.map((s) => s.id));
    }
    return new Response(JSON.stringify(out.body), {
      status: out.status,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    await Promise.resolve(stores.claims.release(webhookId)).catch(() => undefined);
    console.error(`[gdpr:${normalized}] failed`, String((err as Error)?.message ?? err));
    return new Response("transient", { status: 503 });
  }
}
