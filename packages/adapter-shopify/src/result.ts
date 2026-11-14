// toCallResult: TechLadder result envelope -> neutral CallCompletedEvent.
// Senior item 1. Covers call.completed, analysis.ready (outcomes{}, summary,
// recording) and call.failed envelopes.
// TODO(prompt-owner): confirm the exact backend outcome keys/values mapped below.
// The matcher is deliberately tolerant (case/space/underscore-insensitive with
// synonyms); unknown values fall back to "uncertain", never invented decisions.
import type { CallCompletedEvent, CallDisposition, CallExecutionStatus } from "../../core/src/events/types.js";

export interface ResultLedger {
  /** Keyed at creation time by externalId (then callId): {shop, orderId}. */
  lookup(key: string): { shop: string; orderId: string } | null;
}

function norm(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
}

const DISPOSITION_TABLE: Array<{ match: string[]; to: CallDisposition }> = [
  { match: ["confirmed", "confirm", "proceed", "accept", "yes"], to: "confirmed" },
  { match: ["cancelled", "canceled", "cancel", "cancellation"], to: "cancelled" },
  { match: ["modificationrequested", "modify", "modification", "change", "edit", "addresscorrection"], to: "modification_requested" },
  { match: ["callbackrequested", "callback", "callbacktime", "later", "callmeback"], to: "callback_requested" },
  { match: ["humanassistance", "human", "agent", "support", "transfer"], to: "human_assistance" },
  { match: ["wrongnumber", "wrongperson", "notintended"], to: "wrong_number" },
  { match: ["uncertain", "unclear", "unsure", "nodecision", "unknown", "didnotorder"], to: "uncertain" },
];

function toDisposition(outcomes: Record<string, unknown>): CallDisposition {
  const haystack = Object.entries(outcomes)
    .map(([k, v]) => `${norm(k)}=${norm(typeof v === "string" ? v : JSON.stringify(v))}`)
    .join(" ");
  for (const row of DISPOSITION_TABLE) {
    if (row.match.some((m) => haystack.includes(m))) return row.to;
  }
  return "uncertain";
}

function pick<T>(...vals: Array<T | undefined | null>): T | undefined {
  return vals.find((v) => v !== undefined && v !== null && v !== "") as T | undefined;
}

/** Pure: never throws on unknown shapes, returns null when unusable. */
export function toCallResult(envelope: unknown, ledger: ResultLedger): CallCompletedEvent | null {
  if (typeof envelope !== "object" || envelope === null) return null;
  const env = envelope as Record<string, unknown>;
  const event = String(env["event"] ?? "");
  const data = (env["data"] as Record<string, unknown> | undefined) ?? env;

  const callId = String(pick(data["call_id"], data["callId"], (data["metadata"] as Record<string, unknown> | undefined)?.["call_id"]) ?? "");
  const externalId = String(pick(data["external_id"], data["externalId"]) ?? "");
  const batchId =
    (pick(data["batch_id"], data["batchId"], data["schedule_id"], data["scheduleId"]) as string | undefined) ?? undefined;

  // Shop + order come from OUR ledger (written at creation), never the payload.
  const stored = ledger.lookup(callId) ?? (externalId ? ledger.lookup(externalId) : null);
  if (!stored) return null;

  let callStatus: CallExecutionStatus = "completed";
  if (/failed|cancelled/.test(event)) callStatus = event.includes("failed") ? "failed" : "completed";

  const outcomes =
    (data["outcomes"] as Record<string, unknown> | undefined) ??
    ((data["metadata"] as Record<string, unknown> | undefined)?.["outcomes"] as Record<string, unknown> | undefined) ??
    {};
  const summary =
    (pick(data["summary"], (data["metadata"] as Record<string, unknown> | undefined)?.["summary"]) as string | undefined) ?? undefined;
  const recording =
    (pick(
      data["recording_url"],
      data["recordingUrl"],
      (data["recording"] as Record<string, unknown> | undefined)?.["file_key"],
    ) as string | undefined) ?? undefined;
  const transcript =
    (pick(data["transcript_url"], data["transcriptUrl"]) as string | undefined) ?? undefined;

  return {
    eventType: "call_completed",
    outcome: toDisposition(outcomes),
    ...(callStatus !== "completed" ? { callStatus } : {}),
    ...(summary ? { summary } : {}),
    ...(transcript ? { transcriptUrl: transcript } : {}),
    ...(recording ? { recordingUrl: recording } : {}),
    callId: callId || externalId,
    ...(batchId ? { batchId } : {}),
    source: "shopify",
    externalId: stored.orderId,
    externalAccountId: stored.shop,
  };
}
