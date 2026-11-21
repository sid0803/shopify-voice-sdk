// Zoho workflow webhook receiver (P2 shell logic, framework-free).
// Mirrors the Shopify fast-ack route: verify → claim → enqueue → 2xx, with
// 401 on bad signature and 503 + claim-release on transient enqueue failure.
// Returns a plain outcome; the thin HTTP route maps it to a Response later.
import { createZohoAdapter } from "../adapter.js";
import type { ZohoJobQueue } from "../queue.js";
import type { ZohoEventClaim } from "../stores.js";
import { extractRecordId } from "../mapping.js";

export interface ZohoWebhookDelivery {
  headers: Record<string, string | string[] | undefined>;
  /** Org id from the route (query param configured in the workflow URL). */
  orgId: string;
  module: string;
  /** Raw record as delivered by the Zoho workflow. */
  record: Record<string, unknown>;
  /** Zoho delivery id when the workflow provides one (see D6). */
  deliveryId?: string;
  nowMs?: number;
}

export interface ZohoWebhookDeps {
  webhookSecret: string;
  dataCenter: string;
  claims: ZohoEventClaim;
  queue: ZohoJobQueue;
  maxAttempts?: number;
}

export interface ZohoWebhookOutcome {
  httpStatus: 200 | 401 | 503;
  detail: string;
}

/**
 * Claim key prefers the workflow delivery id. Without one we fall back to
 * module + record + update time — documented weak idempotency until D6 is
 * resolved against the test org. The lead processor's stable idempotency key
 * is the second line of defense against duplicate calls.
 */
export function claimKeyFor(delivery: Pick<ZohoWebhookDelivery, "module" | "record" | "deliveryId" | "nowMs">): string {
  if (delivery.deliveryId) return `zoho:${delivery.deliveryId}`;
  const recordId = extractRecordId(delivery.record) ?? "unknown";
  const updated = delivery.record["Modified_Time"] ?? delivery.record["Created_Time"] ?? delivery.nowMs ?? "no-ts";
  return `zoho:${delivery.module}:${recordId}:${String(updated)}`;
}

export async function handleZohoWebhook(delivery: ZohoWebhookDelivery, deps: ZohoWebhookDeps): Promise<ZohoWebhookOutcome> {
  const adapter = createZohoAdapter({ webhookSecret: deps.webhookSecret, dataCenter: deps.dataCenter });
  try {
    await adapter.verifyIncoming({ rawBody: "", headers: delivery.headers });
  } catch {
    return { httpStatus: 401, detail: "bad signature" };
  }

  const key = claimKeyFor(delivery);
  if (!(await deps.claims.claim(key))) {
    return { httpStatus: 200, detail: "duplicate" };
  }
  try {
    const enqueued = await deps.queue.enqueue({
      id: `zoho:lead:${key}`,
      type: "zoho.lead",
      payload: {
        orgId: delivery.orgId.toLowerCase(),
        module: delivery.module,
        recordId: extractRecordId(delivery.record) ?? "",
        record: delivery.record,
      },
      ...(deps.maxAttempts !== undefined ? { maxAttempts: deps.maxAttempts } : {}),
    });
    if (!enqueued) return { httpStatus: 200, detail: "duplicate job" };
  } catch {
    // Release the claim so Zoho's retry can reprocess safely.
    await Promise.resolve(deps.claims.release(key)).catch(() => undefined);
    return { httpStatus: 503, detail: "transient" };
  }
  return { httpStatus: 200, detail: "queued" };
}
