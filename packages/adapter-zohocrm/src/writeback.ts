// Call-outcome write-back orchestration (P1).
// Label tables live here so both the Zoho adapter and any future host use the
// single source of truth. Transport goes through the Zoho client: outcome
// field update (filterable state) + Note (human-readable audit trail).
import type { CallDisposition, CallExecutionStatus, CallCompletedEvent } from "../../core/src/events/types.js";
import { createZohoClient } from "./client.js";

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

export interface WritebackDeps {
  dataCenter: string;
  /** Org-scoped token supplier (oauth.ensureFreshToken in the shell). */
  getToken: () => string | Promise<string>;
  /** Single refresh-and-retry hook for 401s (oauth refresh in the shell). */
  onUnauthorized?: () => string | Promise<string>;
  fetchImpl?: typeof fetch;
  module: string;
  outcomeField?: string;
  fieldMapping?: Record<string, string>;
}

export interface WritebackResult {
  label: string;
}

/**
 * Write one call result to Zoho: outcome field first (state), Note second
 * (trail). Both must succeed; a partial write throws so the caller retries
 * instead of recording a half-written outcome.
 */
export async function performWriteback(deps: WritebackDeps, result: CallCompletedEvent): Promise<WritebackResult> {
  const label = resolveResultLabel(result, deps.fieldMapping ?? {});
  const client = createZohoClient({
    dataCenter: deps.dataCenter,
    getToken: deps.getToken,
    ...(deps.onUnauthorized ? { onUnauthorized: deps.onUnauthorized } : {}),
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });
  await client.updateRecord(deps.module, result.externalId, {
    [deps.outcomeField ?? "Call_Outcome"]: label,
  });
  const lines = [`Outcome: ${label}`, `Call: ${result.callId}`];
  if (result.batchId) lines.push(`Batch: ${result.batchId}`);
  if (result.summary) lines.push(`Summary: ${result.summary}`);
  await client.createNote(deps.module, result.externalId, {
    title: `TechLadder call — ${label}`,
    content: lines.join("\n"),
  });
  return { label };
}
