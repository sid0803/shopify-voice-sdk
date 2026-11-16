import type { ActionFunctionArgs } from "react-router";
import { verifyWebhook } from "@techladder/core";
import { defaultSettings, withEnvFallbacks } from "@techladder/adapter-shopify";
import { getStores } from "../lib/stores.server";
import { ensureWorkerStarted } from "../lib/worker.server";

function lookupKeys(envelope: Record<string, unknown>): string[] {
  const data = (envelope["data"] as Record<string, unknown> | undefined) ?? envelope;
  const meta = data["metadata"] as Record<string, unknown> | undefined;
  return [
    data["call_id"],
    data["external_id"],
    data["batch_id"],
    data["contact_id"],
    meta?.["external_id"],
  ]
    .filter((v) => v !== undefined && v !== null && v !== "")
    .map(String);
}

/**
 * TechLadder -> Shopify result webhook.
 *
 * The shop is resolved from OUR ledger (written at call creation) before the
 * signature is checked; the payload is never trusted for shop identity. Each
 * shop has its own signing secret stored encrypted at rest.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  ensureWorkerStarted();
  const rawBody = await request.text();
  let envelope: Record<string, unknown>;
  try {
    envelope = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return new Response("bad json", { status: 400 });
  }

  const stores = await getStores();
  let shop = "";
  for (const key of lookupKeys(envelope)) {
    const hit = await stores.ledger.lookup(key);
    if (hit) {
      shop = hit.shop.toLowerCase();
      break;
    }
  }
  if (!shop) return new Response("unknown call", { status: 200 });

  const settings = withEnvFallbacks(
    (await stores.settings.get(shop)) ?? defaultSettings(shop),
  );
  const secret =
    settings.techladderWebhookSecretRef || process.env.TECHLADDER_WEBHOOK_SECRET || "";
  if (!secret) {
    console.error(`[techladder-webhook] no signing secret for shop=${shop}`);
    return new Response("not configured", { status: 503 });
  }

  let eventId: string;
  try {
    eventId = verifyWebhook({
      rawBody,
      headers: Object.fromEntries(request.headers.entries()),
      secret,
      toleranceSeconds: Number(process.env.TECHLADDER_WEBHOOK_TOLERANCE ?? "300"),
    }).eventId;
  } catch {
    return new Response("bad signature", { status: 401 });
  }

  try {
    if (!(await stores.claims.claim(eventId))) return new Response("duplicate", { status: 200 });
    const enqueued = await stores.queue.enqueue({
      id: `result:${eventId}`,
      type: "techladder.result",
      payload: { shop, eventId, envelope },
      maxAttempts: 8,
    });
    if (!enqueued) return new Response("duplicate job", { status: 200 });
  } catch (err) {
    await Promise.resolve(stores.claims.release(eventId)).catch(() => undefined);
    console.error("[techladder-webhook] enqueue failed", String((err as Error)?.message ?? err));
    return new Response("transient", { status: 503 });
  }

  return new Response("queued", { status: 200 });
};
