// Call-result → Zoho write-back processor (P2 shell logic, framework-free).
// The thin result route verifies the TechLadder signature, claims the event
// and enqueues; this module resolves the ledger identity and performs the
// write-back with a fresh org token. 4xx (except 429) is settled — retrying a
// revoked-token or field error in a loop helps nobody; 429/5xx throws.
import type { CallCompletedEvent } from "../../../core/src/events/types.js";
import { ensureFreshToken, type ZohoTokenStore } from "../oauth.js";
import { withZohoEnvFallbacks, type ZohoSettings } from "../settings.js";
import type { ZohoConnectionStore, ZohoLeadLedger } from "../stores.js";
import { performWriteback } from "../writeback.js";

export interface ZohoResultJobPayload {
  orgId: string;
  result: CallCompletedEvent;
}

export interface ZohoResultProcessorDeps {
  ledger: ZohoLeadLedger;
  connections: ZohoConnectionStore;
  tokenStore: ZohoTokenStore;
  getSettings: (orgId: string) => ZohoSettings | Promise<ZohoSettings>;
  clientId: string;
  clientSecret: string;
  fetchImpl?: typeof fetch;
  nowMs?: number;
}

function isTransient(err: unknown): boolean {
  const status = (err as { status?: number; code?: string })?.status;
  if (typeof status === "number") return status === 429 || status >= 500;
  return /fetch failed|aborted|timeout|network|5\d\d/i.test(
    String((err as Error)?.message ?? err),
  );
}

export async function processZohoResultJob(
  payload: ZohoResultJobPayload,
  deps: ZohoResultProcessorDeps,
): Promise<string> {
  const orgId = payload.orgId.toLowerCase();
  const result = payload.result;
  const found =
    (await deps.ledger.lookup(result.callId)) ??
    (await deps.ledger.lookup(result.externalId)) ??
    (result.batchId ? await deps.ledger.lookup(result.batchId) : null);
  if (!found) return "ignored:no-ledger-match";

  const settings = withZohoEnvFallbacks(await deps.getSettings(orgId));
  const basePatch = {
    outcome: result.outcome,
    ...(result.callStatus ? { callStatus: result.callStatus } : {}),
    ...(result.summary ? { summary: result.summary } : {}),
  };
  const writeLedger = async (status: string, labelApplied?: string) => {
    const patch = { ...basePatch, status, ...(labelApplied ? { labelApplied } : {}) };
    for (const key of [result.callId, result.externalId, result.batchId ?? ""]) {
      if (key) await deps.ledger.update(key, patch);
    }
  };

  if (!settings.notesEnabled) {
    await writeLedger("result");
    return `result:${result.outcome}:notes-disabled`;
  }

  const connection = await deps.connections.get(orgId);
  if (!connection || connection.status !== "connected") {
    await writeLedger("result");
    return "settled-error:not-connected";
  }

  try {
    const token = await ensureFreshToken({
      store: deps.tokenStore,
      orgId,
      dataCenter: connection.dataCenter,
      clientId: deps.clientId,
      clientSecret: deps.clientSecret,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      ...(deps.nowMs !== undefined ? { nowMs: deps.nowMs } : {}),
    });
    const { label } = await performWriteback(
      {
        dataCenter: connection.dataCenter,
        getToken: () => token,
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
        module: found.module,
        outcomeField: settings.outcomeField,
        fieldMapping: settings.fieldMapping,
      },
      result,
    );
    await writeLedger("noted", label);
    return `noted:${result.outcome}`;
  } catch (err) {
    if (isTransient(err)) throw err;
    await writeLedger("result");
    const e = err as { status?: number; code?: string };
    return `settled-error:${e.code ?? e.status ?? "unknown"}`;
  }
}
