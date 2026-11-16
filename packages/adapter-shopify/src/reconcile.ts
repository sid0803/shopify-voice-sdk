// Reconciliation engine for missed webhooks (Task 7).
// Polls calls in the ledger without an outcome after a grace window (default 15m),
// checks TechLadder results, and writes back the tag to Shopify.

import type { CallCompletedEvent } from "../../core/src/events/types.js";
import { resolveResultTag } from "./index.js";
import { toCallResultAsync, type AsyncResultLedger } from "./result.js";
import type { CallLedger, CallRecord } from "./stores.js";

export interface ReconcileResultClient {
  getResult?(callId: string): Promise<Record<string, unknown> | null>;
  listCallsByExternalId?(
    externalId: string,
    opts?: { limit?: number; page?: number },
  ): Promise<{ items: Array<Record<string, unknown>> } | null>;
}

export interface ReconcileClaimStore {
  claim(key: string): Promise<boolean> | boolean;
  release?(key: string): Promise<void> | void;
}

export interface ReconcileOptions {
  shop: string;
  ledger: CallLedger;
  client: ReconcileResultClient;
  /** Function to write the tag to the platform (e.g. adapter.handleResult or tagsAdd) */
  handleResult: (result: CallCompletedEvent) => Promise<void>;
  /** Optional custom tag overrides */
  tagNames?: Record<string, string>;
  /** Skip calls created more recently than this window in minutes. Default: 15. */
  olderThanMinutes?: number;
  /** Maximum number of records to inspect per run. Default: 50. */
  limit?: number;
  /** Optional claim store for distributed deduplication across worker instances */
  claimStore?: ReconcileClaimStore;
  /** Current time in ms (for deterministic testing). Default: Date.now */
  now?: () => number;
}

export interface ReconcileSummary {
  inspected: number;
  skippedRecent: number;
  skippedSettled: number;
  reconciled: number;
  noResultFound: number;
  errors: number;
}

export async function reconcileCalls(options: ReconcileOptions): Promise<ReconcileSummary> {
  const {
    shop,
    ledger,
    client,
    handleResult,
    tagNames = {},
    olderThanMinutes = 15,
    limit = 50,
    claimStore,
    now = () => Date.now(),
  } = options;

  const summary: ReconcileSummary = {
    inspected: 0,
    skippedRecent: 0,
    skippedSettled: 0,
    reconciled: 0,
    noResultFound: 0,
    errors: 0,
  };

  const records = await Promise.resolve(ledger.list(shop, limit));
  const currentTime = now();
  const cutoffTime = currentTime - olderThanMinutes * 60 * 1000;

  for (const record of records) {
    summary.inspected += 1;

    // 1. Skip if already settled, tagged, or has an outcome
    if (
      record.outcome ||
      record.tagApplied ||
      record.status === "tagged" ||
      record.status === "result" ||
      record.status === "failed"
    ) {
      summary.skippedSettled += 1;
      continue;
    }

    // 2. Skip if younger than threshold window (give normal webhooks time to arrive)
    const createdAtMs = new Date(record.createdAt).getTime();
    if (Number.isFinite(createdAtMs) && createdAtMs > cutoffTime) {
      summary.skippedRecent += 1;
      continue;
    }

    // 3. Acquire claim to prevent concurrent reconciliation
    const claimKey = `reconcile:${record.callId || record.externalId || record.orderId}`;
    if (claimStore) {
      const claimed = await Promise.resolve(claimStore.claim(claimKey));
      if (!claimed) {
        summary.skippedSettled += 1;
        continue;
      }
    }

    let claimAcquired = Boolean(claimStore);
    try {
      // 4. Fetch result from TechLadder API
      let rawData: Record<string, unknown> | null = null;
      if (record.callId && client.getResult) {
        try {
          rawData = await client.getResult(record.callId);
        } catch {
          rawData = null;
        }
      }

      if (!rawData && (record.externalId || record.orderId) && client.listCallsByExternalId) {
        const extId = record.externalId || record.orderId;
        const res = await client.listCallsByExternalId(extId, { limit: 5 });
        if (res && Array.isArray(res.items) && res.items.length > 0) {
          const matched = res.items.find(
            (item) =>
              item["outcomes"] ||
              item["outcome"] ||
              item["call_status"] ||
              item["status"] === "completed" ||
              item["status"] === "failed",
          );
          if (matched) rawData = matched;
        }
      }

      if (!rawData) {
        summary.noResultFound += 1;
        if (claimAcquired && claimStore?.release) {
          await Promise.resolve(claimStore.release(claimKey)).catch(() => undefined);
          claimAcquired = false;
        }
        continue;
      }

      // Check if call is actually finished / settled
      const status = String(rawData["call_status"] ?? rawData["status"] ?? "").toLowerCase();
      const hasOutcome = Boolean(rawData["outcome"] || rawData["outcomes"]);
      const isSettled =
        ["completed", "failed", "cancelled", "no_answer"].includes(status) || hasOutcome;

      if (!isSettled) {
        summary.noResultFound += 1;
        if (claimAcquired && claimStore?.release) {
          await Promise.resolve(claimStore.release(claimKey)).catch(() => undefined);
          claimAcquired = false;
        }
        continue;
      }

      // 5. Transform via toCallResultAsync
      const envelope = rawData["event"] ? rawData : { event: "analysis.ready", data: rawData };
      const callResult = await toCallResultAsync(envelope, ledger as unknown as AsyncResultLedger);

      if (!callResult) {
        summary.noResultFound += 1;
        if (claimAcquired && claimStore?.release) {
          await Promise.resolve(claimStore.release(claimKey)).catch(() => undefined);
          claimAcquired = false;
        }
        continue;
      }

      // 6. Write back to Shopify
      await handleResult(callResult);
      const effectiveTag = resolveResultTag(callResult, tagNames);

      // 7. Update ledger
      const patch: Partial<CallRecord> = {
        status: "tagged",
        outcome: callResult.outcome,
        tagApplied: effectiveTag,
        ...(callResult.callStatus ? { callStatus: callResult.callStatus } : {}),
        ...(callResult.summary ? { summary: callResult.summary } : {}),
        ...(callResult.recordingUrl ? { recordingUrl: callResult.recordingUrl } : {}),
      };

      const updateKey = record.externalId || record.orderId || record.callId || "";
      if (updateKey) {
        await Promise.resolve(ledger.update(updateKey, patch));
      }

      summary.reconciled += 1;
    } catch (err) {
      summary.errors += 1;
      if (claimAcquired && claimStore?.release) {
        await Promise.resolve(claimStore.release(claimKey)).catch(() => undefined);
      }
    }
  }

  return summary;
}

