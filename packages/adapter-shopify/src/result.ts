// toCallResult: TechLadder result envelope -> neutral CallCompletedEvent.
// Covers call.completed, analysis.ready (outcomes{}, summary, recording) and
// call.failed / call.no_answer envelopes.
//
// TODO(prompt-owner): confirm the exact backend outcome keys/values mapped below.
// The matcher is deliberately tolerant but matches VALUES before keys: a key
// such as "order_confirmation" must not turn every value into "confirmed".
// Unknown values fall back to "uncertain", never invented decisions.
import type {
  CallCompletedEvent,
  CallDisposition,
  CallExecutionStatus,
} from "../../core/src/events/types.js";

export interface ResultLookup {
  shop: string;
  orderId: string;
}

export interface ResultLedger {
  /** Keyed at creation time by externalId, callId and batchId: {shop, orderId}. */
  lookup(key: string): ResultLookup | null;
}

export interface AsyncResultLedger {
  lookup(key: string): Promise<ResultLookup | null>;
}

type UnknownRecord = Record<string, unknown>;

function norm(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
}

function pick<T>(...vals: Array<T | undefined | null>): T | undefined {
  return vals.find((v) => v !== undefined && v !== null && v !== "") as T | undefined;
}

const DISPOSITION_TABLE: Array<{ match: string[]; to: CallDisposition }> = [
  { match: ["confirmed", "confirm", "proceed", "accept"], to: "confirmed" },
  { match: ["cancelled", "canceled", "cancel", "cancellation"], to: "cancelled" },
  { match: ["modificationrequested", "modify", "modification", "addresscorrection"], to: "modification_requested" },
  { match: ["callbackrequested", "callback", "callbacktime", "callmeback"], to: "callback_requested" },
  { match: ["humanassistance", "agenttransfer", "speaktohuman", "transfer"], to: "human_assistance" },
  { match: ["wrongnumber", "wrongperson", "notintended"], to: "wrong_number" },
  { match: ["uncertain", "unclear", "unsure", "nodecision", "unknown", "didnotorder"], to: "uncertain" },
];

/** Flatten nested outcome objects into leaf key/value pairs. */
function flatten(value: unknown, prefix: string, out: Record<string, unknown>): void {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    value.forEach((item, i) => flatten(item, `${prefix}[${i}]`, out));
    return;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value as UnknownRecord)) {
      flatten(v, prefix ? `${prefix}.${k}` : k, out);
    }
    return;
  }
  out[prefix] = value;
}

function toDisposition(outcomes: Record<string, unknown>): CallDisposition {
  const leaves: Record<string, unknown> = {};
  flatten(outcomes, "", leaves);
  const entries = Object.entries(leaves);

  // 1. Explicit disposition/decision fields win over everything else.
  for (const [k, v] of entries) {
    if (/disposition|decision|calloutcome|^outcome$|mainoutcome/i.test(k)) {
      const n = norm(v);
      for (const row of DISPOSITION_TABLE) {
        if (row.match.some((m) => n === m || n.includes(m))) return row.to;
      }
    }
  }

  // 2. Match string/number VALUES only. Never let a key like
  // "order_confirmation" decide the disposition on its own.
  for (const [, v] of entries) {
    if (typeof v !== "string" && typeof v !== "number") continue;
    const n = norm(v);
    if (!n) continue;
    // Negated confirmation means the customer declined; an "unconfirmed"
    // outcome means the agent could not establish a decision.
    if (n.includes("unconfirmed")) return "uncertain";
    if (n === "no" || n.includes("notconfirmed") || n.includes("noconfirmed") || n === "declined") {
      return "cancelled";
    }
    for (const row of DISPOSITION_TABLE) {
      if (row.match.some((m) => n === m || n.includes(m))) return row.to;
    }
  }

  // 3. Boolean leaf values: only `true` under a disposition-shaped key counts.
  for (const [k, v] of entries) {
    if (v !== true) continue;
    const n = norm(k);
    for (const row of DISPOSITION_TABLE) {
      if (row.match.some((m) => n.includes(m))) return row.to;
    }
  }
  return "uncertain";
}

function outcomeSource(data: UnknownRecord): Record<string, unknown> {
  const candidates = [
    data["outcomes"],
    (data["metadata"] as UnknownRecord | undefined)?.["outcomes"],
    (data["result"] as UnknownRecord | undefined)?.["outcomes"],
    (data["analysis"] as UnknownRecord | undefined)?.["outcomes"],
  ];
  for (const c of candidates) {
    if (c && typeof c === "object" && !Array.isArray(c)) return c as Record<string, unknown>;
  }
  // Some payloads put a single decision at the top/result level.
  const fallback: Record<string, unknown> = {};
  for (const src of [data, data["result"], data["analysis"], data["metadata"]]) {
    if (!src || typeof src !== "object") continue;
    for (const k of ["disposition", "decision", "outcome", "main_outcome", "call_outcome"]) {
      const v = (src as UnknownRecord)[k];
      if (v !== undefined) fallback[k] = v;
    }
  }
  return fallback;
}

function executionStatus(event: string, data: UnknownRecord): CallExecutionStatus {
  const meta = data["metadata"] as UnknownRecord | undefined;
  const result = data["result"] as UnknownRecord | undefined;
  const rawStatus = norm(
    pick(
      data["call_status"],
      data["callStatus"],
      data["execution_status"],
      data["executionStatus"],
      data["status"],
      meta?.["call_status"],
      result?.["call_status"],
    ),
  );
  const nEvent = norm(event);

  if (nEvent.includes("failed") || rawStatus === "failed" || rawStatus === "failure" || rawStatus === "error") {
    return "failed";
  }
  if (
    nEvent.includes("noanswer") ||
    ["noanswer", "notanswered", "unanswered", "missed", "busy", "noresponse"].includes(rawStatus)
  ) {
    return "no_answer";
  }
  return "completed";
}

function baseParse(envelope: unknown): {
  event: string;
  data: UnknownRecord;
  callId: string;
  externalId: string;
  batchId?: string;
} | null {
  if (typeof envelope !== "object" || envelope === null) return null;
  const env = envelope as UnknownRecord;
  const event = String(env["event"] ?? "");
  const data = (env["data"] as UnknownRecord | undefined) ?? env;
  const meta = data["metadata"] as UnknownRecord | undefined;
  const result = data["result"] as UnknownRecord | undefined;

  const callId = String(
    pick(
      data["call_id"],
      data["callId"],
      data["contact_id"],
      data["contactId"],
      meta?.["call_id"],
      result?.["call_id"],
    ) ?? "",
  );
  const externalId = String(
    pick(
      data["external_id"],
      data["externalId"],
      meta?.["external_id"],
      result?.["external_id"],
    ) ?? "",
  );
  const batchId =
    (pick(
      data["batch_id"],
      data["batchId"],
      data["schedule_id"],
      data["scheduleId"],
      result?.["batch_id"],
    ) as string | undefined) ?? undefined;

  return { event, data, callId, externalId, ...(batchId ? { batchId } : {}) };
}

function build(
  parsed: NonNullable<ReturnType<typeof baseParse>>,
  stored: ResultLookup,
): CallCompletedEvent {
  const { event, data, callId, externalId, batchId } = parsed;
  const meta = data["metadata"] as UnknownRecord | undefined;
  const callStatus = executionStatus(event, data);
  const outcomes = outcomeSource(data);
  const summary =
    (pick(
      data["summary"],
      meta?.["summary"],
      (data["result"] as UnknownRecord | undefined)?.["summary"],
    ) as string | undefined) ?? undefined;
  const recording =
    (pick(
      data["recording_url"],
      data["recordingUrl"],
      (data["recording"] as UnknownRecord | undefined)?.["file_key"],
      (data["recording"] as UnknownRecord | undefined)?.["url"],
    ) as string | undefined) ?? undefined;
  const transcript =
    (pick(
      data["transcript_url"],
      data["transcriptUrl"],
      (data["transcript"] as UnknownRecord | undefined)?.["url"],
    ) as string | undefined) ?? undefined;

  return {
    eventType: "call_completed",
    outcome: toDisposition(outcomes),
    ...(callStatus !== "completed" ? { callStatus } : {}),
    ...(summary ? { summary } : {}),
    ...(transcript ? { transcriptUrl: transcript } : {}),
    ...(recording ? { recordingUrl: recording } : {}),
    callId: callId || externalId || batchId || "unknown",
    ...(batchId ? { batchId } : {}),
    source: "shopify",
    externalId: stored.orderId,
    externalAccountId: stored.shop,
  };
}

function candidateKeys(parsed: NonNullable<ReturnType<typeof baseParse>>): string[] {
  return [parsed.callId, parsed.externalId, parsed.batchId ?? ""].filter(Boolean);
}

/** Synchronous variant for in-memory ledgers and pure tests. */
export function toCallResult(envelope: unknown, ledger: ResultLedger): CallCompletedEvent | null {
  const parsed = baseParse(envelope);
  if (!parsed) return null;
  let stored: ResultLookup | null = null;
  for (const key of candidateKeys(parsed)) {
    stored = ledger.lookup(key);
    if (stored) break;
  }
  if (!stored) return null;
  return build(parsed, stored);
}

/** Async variant for Mongo/network ledgers. */
export async function toCallResultAsync(
  envelope: unknown,
  ledger: AsyncResultLedger,
): Promise<CallCompletedEvent | null> {
  const parsed = baseParse(envelope);
  if (!parsed) return null;
  let stored: ResultLookup | null = null;
  for (const key of candidateKeys(parsed)) {
    stored = await ledger.lookup(key);
    if (stored) break;
  }
  if (!stored) return null;
  return build(parsed, stored);
}
