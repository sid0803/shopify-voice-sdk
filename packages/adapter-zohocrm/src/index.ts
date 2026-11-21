// Zoho CRM adapter.
// Zoho specifics live ONLY here — core stays neutral.
// TODO: switch relative imports to "@techladder/core" after first publish.

import { timingSafeEqual } from "node:crypto";
import { InboundEventSchema } from "../../core/src/events/types.js";
import type { CallDisposition, CallExecutionStatus } from "../../core/src/events/types.js";
import { zohoApiBase } from "./zohoConfig.js";
import type { AdapterContext, PlatformAdapter, RawIncomingRequest } from "../../core/src/adapter.js";
import type { CallCompletedEvent, InboundEvent } from "../../core/src/events/types.js";

/** Minimal subset of a Zoho workflow webhook delivery we care about. */
export interface ZohoPlatformEvent {
  /** Zoho module API name: Leads, Contacts or Deals. */
  module: string;
  /** Zoho org id. Neutral tenant id for core. */
  orgId: string;
  record: Record<string, unknown>;
}

export interface ZohoAdapterConfig {
  /** Shared secret the Zoho workflow webhook must send. From env, never logged. */
  webhookSecret: string;
  /** Org data center: in, com, eu or com.au. Stored at connect time. */
  dataCenter: string;
  /** Zoho OAuth access token for write-back (refreshed by oauth.ts, P1). */
  accessToken?: string;
  /** Trigger module for write-back URLs (mirrors settings.triggerModule). */
  module?: string;
  /** Record field receiving the outcome label. */
  outcomeField?: string;
  /** Optional merchant label overrides keyed by default outcome label. */
  fieldMapping?: Record<string, string>;
  fetchImpl?: typeof fetch;
}

function header(headers: RawIncomingRequest["headers"], name: string): string | undefined {
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === name) return Array.isArray(v) ? v[0] : v;
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Best-effort retry for the write-back path: network errors + 5xx, never 4xx. */
async function fetchWithRetry(fetchImpl: typeof fetch, url: string, init: RequestInit, attempts = 3): Promise<Response> {
  let last: unknown;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      const res = await fetchImpl(url, init);
      if (res.status < 500) return res;
      last = new Error(`Zoho responded ${res.status}`);
    } catch (err) {
      last = err;
    }
    if (i < attempts) await sleep(Math.min(1000 * 2 ** (i - 1), 4000) + Math.floor(Math.random() * 200));
  }
  throw last instanceof Error ? last : new Error("Zoho write-back failed");
}

// Outcome labels written to the record field and the Note title.
// Business dispositions only — the agent never claims Notes were applied.
export function outcomeToLabel(outcome: CallDisposition): string {
  switch (outcome) {
    case "confirmed": return "Confirmed";
    case "cancelled": return "Cancelled";
    case "modification_requested": return "Modification Requested";
    case "callback_requested": return "Callback Requested";
    case "human_assistance": return "Human Assistance";
    case "uncertain": return "Uncertain";
    case "wrong_number": return "Wrong Number";
  }
}

/** Execution statuses never reach Main Disposition. The platform maps them to
 * labels directly when no conversation occurred. */
export function executionStatusToLabel(status: CallExecutionStatus): string {
  switch (status) {
    case "completed": return "Completed";
    case "no_answer": return "No Answer";
    case "failed": return "Failed";
  }
}

/**
 * Single source of truth for the outcome label a result writes. The write-back
 * and any call log both use this, so the log can never claim a different label.
 */
export function resolveResultLabel(
  result: Pick<CallCompletedEvent, "outcome" | "callStatus">,
  fieldMapping: Record<string, string> = {},
): string {
  const base =
    result.callStatus !== undefined && result.callStatus !== "completed"
      ? executionStatusToLabel(result.callStatus)
      : outcomeToLabel(result.outcome);
  return fieldMapping[base] ?? fieldMapping[result.outcome] ?? base;
}

/** Map Zoho module -> neutral eventType. Unknown modules are ignored. */
export function moduleToEventType(module: string): "lead_callback" | "deal_callback" | null {
  if (module === "Leads" || module === "Contacts") return "lead_callback";
  if (module === "Deals") return "deal_callback";
  return null;
}

interface ZohoApiResponse {
  data?: Array<{ code?: string; message?: string; status?: string }>;
}

async function assertZohoSuccess(res: Response, what: string): Promise<void> {
  let detail = `${res.status}`;
  try {
    const body = (await res.json()) as ZohoApiResponse;
    const first = body.data?.[0];
    if (res.ok && first?.code === "SUCCESS") return;
    detail = first?.message ?? first?.code ?? detail;
  } catch {
    // Non-JSON body: fall through with the status.
  }
  throw new Error(`Zoho ${what} failed: ${detail}`);
}

export function createZohoAdapter(config: ZohoAdapterConfig): PlatformAdapter<ZohoPlatformEvent, ZohoAdapterConfig> {
  return {
    name: "zohocrm",
    async verifyIncoming(request: RawIncomingRequest): Promise<void> {
      // The Zoho workflow rule must send this header (see docs). Fail closed.
      const got = header(request.headers, "x-zoho-webhook-token") ?? "";
      const want = config.webhookSecret;
      if (!want) throw new Error("Missing Zoho webhook secret");
      const a = Buffer.from(got);
      const b = Buffer.from(want);
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        throw new Error("Invalid Zoho webhook token");
      }
    },
    toStandardEvent(e: ZohoPlatformEvent): InboundEvent | null {
      const eventType = moduleToEventType(e.module);
      if (!eventType) return null;
      const record = e.record;
      const phone =
        (record["Phone"] as string | null | undefined) ??
        (record["Mobile"] as string | null | undefined) ??
        null;
      if (!phone) return null;
      const id = record["id"];
      if (id === undefined || id === null || id === "") return null;
      const name =
        ([record["First_Name"], record["Last_Name"]].filter(Boolean).join(" ").trim() ||
        (record["Full_Name"] as string | undefined) ||
        undefined);
      const parsed = InboundEventSchema.safeParse({
        eventType,
        contact: { ...(name ? { name } : {}), phone },
        context: { zohoModule: e.module, zohoId: String(id) },
        source: "zohocrm",
        externalId: String(id),
        externalAccountId: e.orgId,
      });
      return parsed.success ? parsed.data : null;
    },
    async handleResult(result: CallCompletedEvent, ctx: AdapterContext<ZohoAdapterConfig>): Promise<void> {
      const token = ctx.config.accessToken ?? config.accessToken;
      if (!token) throw new Error("Missing Zoho access token for write-back");
      const module = ctx.config.module ?? config.module;
      if (!module) throw new Error("Missing Zoho module for write-back");
      const base = zohoApiBase(ctx.config.dataCenter || config.dataCenter);
      const label = resolveResultLabel(result, ctx.config.fieldMapping ?? config.fieldMapping ?? {});
      const outcomeField = ctx.config.outcomeField ?? config.outcomeField ?? "Call_Outcome";
      const fetchImpl = config.fetchImpl ?? fetch;
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Authorization: `Zoho-oauthtoken ${token}`,
      };
      const recordUrl = `${base}/${module}/${encodeURIComponent(result.externalId)}`;
      // 1. Outcome field on the record (filterable state).
      const patch = await fetchWithRetry(fetchImpl, recordUrl, {
        method: "PUT",
        headers,
        body: JSON.stringify({ data: [{ [outcomeField]: label }] }),
        signal: AbortSignal.timeout(15_000),
      });
      await assertZohoSuccess(patch, "record update");
      // 2. Note on the record (audit trail with summary).
      const lines = [`Outcome: ${label}`, `Call: ${result.callId}`];
      if (result.batchId) lines.push(`Batch: ${result.batchId}`);
      if (result.summary) lines.push(`Summary: ${result.summary}`);
      const note = await fetchWithRetry(fetchImpl, `${recordUrl}/Notes`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          data: [{ Note_Title: `TechLadder call — ${label}`, Note_Content: lines.join("\n") }],
        }),
        signal: AbortSignal.timeout(15_000),
      });
      await assertZohoSuccess(note, "note create");
    },
  };
}

// Re-exports for any host (shell, worker) so it never needs to deep-import
// package internals.
export * from "./settings.js";
export * from "./mapping.js";
export * from "./zohoConfig.js";
