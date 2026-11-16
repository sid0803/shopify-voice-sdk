import type { ActionFunctionArgs } from "react-router";
import { extractCustomerId, isTestDelivery } from "@techladder/adapter-shopify";
import { authenticate } from "../shopify.server";
import { getStores } from "../lib/stores.server";
import { ensureWorkerStarted } from "../lib/worker.server";

/**
 * Fast-ack order webhook. The request only verifies Shopify's HMAC, claims the
 * webhook id atomically, enqueues the job, and returns 2xx. All TechLadder and
 * tag work happens in the worker so Shopify never times out (<5s).
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  ensureWorkerStarted();

  let context: Awaited<ReturnType<typeof authenticate.webhook>>;
  try {
    context = await authenticate.webhook(request);
  } catch {
    // HMAC/verification failure: explicit 401 so Shopify does not treat this
    // as a transient application error.
    return new Response("bad signature", { status: 401 });
  }

  const { shop, payload, webhookId, topic } = context;
  if (topic !== "ORDERS_CREATE" && topic !== "orders/create") {
    return new Response("ignored topic", { status: 200 });
  }
  const headers = Object.fromEntries(request.headers.entries());
  if (isTestDelivery(headers)) return new Response("test skipped", { status: 200 });

  const stores = await getStores();
  try {
    if (!(await stores.claims.claim(webhookId))) {
      return new Response("duplicate", { status: 200 });
    }
    const enqueued = await stores.queue.enqueue({
      id: `order:${webhookId}`,
      type: "order.create",
      payload: { shop, customerId: extractCustomerId(payload as Record<string, unknown>), payload },
      maxAttempts: 5,
    });
    if (!enqueued) return new Response("duplicate job", { status: 200 });
  } catch (err) {
    // Release the claim so Shopify's retry can reprocess safely.
    await Promise.resolve(stores.claims.release(webhookId)).catch(() => undefined);
    console.error("[orders/create] enqueue failed", String((err as Error)?.message ?? err));
    return new Response("transient", { status: 503 });
  }

  return new Response("queued", { status: 200 });
};
