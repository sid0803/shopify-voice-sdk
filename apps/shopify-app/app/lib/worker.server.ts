// Background worker for the v1 pilot. One in-process loop consumes the durable
// job queue; in production this should be a separate worker process, but the
// queue interface is identical so it can move without route changes.
import { BatchesResource, CallsResource, type CallCompletedEvent } from "@techladder/core";
import {
  defaultSettings,
  reconcileCalls,
  withEnvFallbacks,
} from "@techladder/adapter-shopify";
import type { JobRecord } from "@techladder/adapter-shopify";
import { getStores } from "./stores.server.js";
import { processOrderJob, type OrderJobPayload } from "./orderProcessor.server.js";
import { applyOrderTag, processResultJob, type ResultJobPayload } from "./resultProcessor.server.js";
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
  const client = techladderClient(settings);
  const batches = new BatchesResource(client);
  const calls = new CallsResource(client);

  const olderThanMinutes = Number(payload["olderThanMinutes"] ?? 15);
  const limit = Number(payload["limit"] ?? 50);

  const handleResult = async (result: CallCompletedEvent) => {
    if (!settings.tagsEnabled) return;
    await applyOrderTag(shop, result, settings.tagNames);
  };

  const summary = await reconcileCalls({
    shop,
    ledger: stores.ledger,
    client: {
      getResult: (id: string) => calls.getResult(id),
      listCallsByExternalId: async (id: string, opts?: { limit?: number; page?: number }) => {
        const res = await batches.listCallsByExternalId(id, opts);
        return { items: res.items as unknown as Array<Record<string, unknown>> };
      },
    },
    handleResult,
    tagNames: settings.tagNames,
    olderThanMinutes,
    limit,
    claimStore: stores.claims,
  });

  return `reconciled:${summary.reconciled}/${summary.inspected}`;
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
