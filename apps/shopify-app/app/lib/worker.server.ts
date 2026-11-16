// Background worker for the v1 pilot. One in-process loop consumes the durable
// job queue; in production this should be a separate worker process, but the
// queue interface is identical so it can move without route changes.
import { BatchesResource } from "@techladder/core";
import { defaultSettings, withEnvFallbacks } from "@techladder/adapter-shopify";
import type { JobRecord } from "@techladder/adapter-shopify";
import { getStores } from "./stores.server.js";
import { processOrderJob, type OrderJobPayload } from "./orderProcessor.server.js";
import { processResultJob, type ResultJobPayload } from "./resultProcessor.server.js";
import { techladderClient } from "./techladder.server.js";

const IDLE_MS = 2_000;

type WorkerGlobal = typeof globalThis & {
  __techladderWorkerStarted?: boolean;
};
const workerGlobal = globalThis as WorkerGlobal;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function processReconcileJob(payload: Record<string, unknown>): Promise<string> {
  const shop = String(payload["shop"] ?? "").toLowerCase();
  if (!shop) return "ignored:no-shop";
  const stores = await getStores();
  const stored = (await stores.settings.get(shop)) ?? defaultSettings(shop);
  const settings = withEnvFallbacks(stored);
  const batches = new BatchesResource(techladderClient(settings));
  const records = await stores.ledger.list(shop, 100);
  let checked = 0;
  for (const record of records) {
    if (record.status !== "queued" && record.status !== "calling") continue;
    const res = await batches.listCallsByExternalId(record.orderId, { limit: 20 });
    for (const item of res.items) {
      checked += 1;
      if (!item.outcomes && !item.call_status) continue;
      await processResultJob({
        shop,
        envelope: { event: "analysis.ready", data: item as unknown as Record<string, unknown> },
      });
    }
  }
  return `reconciled:${checked}`;
}

async function run(job: JobRecord): Promise<string> {
  switch (job.type) {
    case "order.create":
      return processOrderJob(job.payload as unknown as OrderJobPayload);
    case "techladder.result":
      return processResultJob(job.payload as unknown as ResultJobPayload);
    case "reconcile":
      return processReconcileJob(job.payload);
    default:
      return `ignored:${job.type}`;
  }
}

async function loop(): Promise<void> {
  for (;;) {
    try {
      const stores = await getStores();
      const job = await stores.queue.claimNext();
      if (!job) {
        // Reconciliation stays manual (admin action) until a shop-list store
        // exists; do not silently invent a periodic scan here.
        await sleep(IDLE_MS);
        continue;
      }
      try {
        const detail = await run(job);
        console.log(`[worker] ${job.type} ${job.id} -> ${detail}`);
        await stores.queue.complete(job.id);
      } catch (err) {
        const message = String((err as Error)?.message ?? err);
        console.error(`[worker] ${job.type} ${job.id} failed: ${message}`);
        const finalAttempt = job.attempts >= job.maxAttempts;
        await stores.queue.fail(job.id, message);
        // A permanently failed result must release its dedupe claim, otherwise
        // TechLadder's redelivery would be silently swallowed forever.
        if (finalAttempt && job.type === "techladder.result") {
          const eventId = (job.payload as { eventId?: unknown }).eventId;
          if (typeof eventId === "string" && eventId) {
            await Promise.resolve(stores.claims.release(eventId)).catch(() => undefined);
          }
        }
      }
    } catch (err) {
      console.error("[worker] loop error", String((err as Error)?.message ?? err));
      await sleep(IDLE_MS);
    }
  }
}

/** Idempotent: safe to call from the entry module and from routes. */
export function ensureWorkerStarted(): void {
  if (workerGlobal.__techladderWorkerStarted) return;
  workerGlobal.__techladderWorkerStarted = true;
  void loop();
}
