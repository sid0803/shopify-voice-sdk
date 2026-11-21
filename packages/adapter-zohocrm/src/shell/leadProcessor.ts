// Lead → call processor (P2 shell logic, framework-free).
// Runs in the worker, never in the webhook request. Mirrors Shopify's
// processOrderJob gate-for-gate: settings → module → hours → phone → consent
// → value → idempotent TechLadder call → ledger. Throws only on transient
// failures so the queue retries; settled merchant/data errors are acknowledged.
import { buildScopedIdempotencyKey } from "../../../core/src/idempotency.js";
import { checkCallEligibility, type ConsentStatus } from "../consent.js";
import { extractName, extractPhone, normalizePhone, scheduleSlot, withinCallingHours } from "../mapping.js";
import { isZohoSettingsConfigured, withZohoEnvFallbacks, type ZohoSettings } from "../settings.js";
import type { ZohoLeadLedger } from "../stores.js";

export interface ZohoLeadJobPayload {
  orgId: string;
  module: string;
  recordId: string;
  record: Record<string, unknown>;
}

export interface ZohoCallInput {
  recordId: string;
  module: string;
  orgId: string;
  phone: string;
  customerName?: string;
  idempotencyKey: string;
  scheduleDate: string;
  scheduleTime: string;
  timezone: string;
  agentId: string;
  versionName: string;
  voice: string;
  didNumberId?: string;
  language?: string;
  metadata: Record<string, unknown>;
}

export interface ZohoCreatedCall {
  callId?: string;
  batchId?: string;
  status: string;
  idempotencyKey: string;
}

export interface ZohoLeadProcessorDeps {
  ledger: ZohoLeadLedger;
  /** Fresh record fetch (shell wires client.getRecord; tests mock). */
  fetchRecord: (orgId: string, module: string, recordId: string) => Promise<Record<string, unknown>>;
  /** TechLadder call creation (shell wires core resources; tests mock). */
  createCall: (input: ZohoCallInput) => Promise<ZohoCreatedCall>;
  /** Consent resolved from mapped DND fields; unknown until D5 lands. */
  resolveConsent?: (record: Record<string, unknown>, fieldMap: Record<string, string | null>) => { crmOptOut: boolean; status: ConsentStatus };
}

function isTransient(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  if (typeof status === "number") return status === 429 || status >= 500;
  return /fetch failed|aborted|timeout|network|5\d\d/i.test(
    String((err as Error)?.message ?? err),
  );
}

function recordAmount(record: Record<string, unknown>): number {
  const n = Number(record["Amount"] ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function defaultConsent(): { crmOptOut: boolean; status: ConsentStatus } {
  // Fail closed: with no mapped source the status is unknown, and strict mode
  // (default) blocks the call. D5 answer + field mapping enable real flow.
  return { crmOptOut: false, status: "unknown" };
}

/**
 * Returns a short outcome string for logs. Throws only on transient failures.
 */
export async function processZohoLeadJob(
  settings: ZohoSettings,
  payload: ZohoLeadJobPayload,
  deps: ZohoLeadProcessorDeps,
): Promise<string> {
  const orgId = payload.orgId.toLowerCase();
  const cfg = withZohoEnvFallbacks(settings);
  if (!cfg.enabled) return "skipped:disabled";
  if (!isZohoSettingsConfigured(cfg)) return "skipped:not-configured";
  if (payload.module !== cfg.triggerModule && !(cfg.triggerModule === "Leads" && payload.module === "Contacts")) {
    return "ignored:module-disabled";
  }
  if (!withinCallingHours(cfg.callingHours.start, cfg.callingHours.end, cfg.callingHours.timezone)) {
    return "skipped:outside-hours";
  }

  let record: Record<string, unknown>;
  try {
    record = await deps.fetchRecord(orgId, payload.module, payload.recordId);
  } catch (err) {
    if (isTransient(err)) throw err;
    return `settled-error:fetch-${(err as { status?: unknown })?.status ?? "unknown"}`;
  }

  const phone = normalizePhone(extractPhone(record), cfg.orgCountry);
  if (!phone) return "skipped:no-phone";

  const consent = deps.resolveConsent
    ? deps.resolveConsent(record, {})
    : defaultConsent();
  const eligibility = checkCallEligibility({
    phone,
    blockedPhones: cfg.blockedPhones,
    crmOptOut: consent.crmOptOut,
    consentStatus: consent.status,
    requireExplicitConsent: cfg.requireExplicitConsent,
  });
  if (!eligibility.eligible) return `skipped:${eligibility.reason}`;

  if (payload.module === "Deals" && cfg.minDealValue > 0 && recordAmount(record) < cfg.minDealValue) {
    return "skipped:below-minimum";
  }

  const { first, last } = extractName(record);
  const customerName = [first, last].filter(Boolean).join(" ") || undefined;
  const eventType = payload.module === "Deals" ? "deal_callback" : "lead_callback";
  const key = buildScopedIdempotencyKey("zoho", orgId, eventType, payload.recordId);
  const slot = scheduleSlot(Date.now(), cfg.callingHours.timezone);
  const now = new Date().toISOString();

  try {
    const created = await deps.createCall({
      recordId: payload.recordId,
      module: payload.module,
      orgId,
      phone,
      ...(customerName ? { customerName } : {}),
      idempotencyKey: key,
      scheduleDate: slot.schedule_date,
      scheduleTime: slot.schedule_time,
      timezone: slot.timezone,
      agentId: cfg.agentId,
      versionName: cfg.versionName,
      voice: cfg.voice,
      ...(cfg.didNumberId ? { didNumberId: cfg.didNumberId } : {}),
      ...(cfg.language ? { language: cfg.language } : {}),
      metadata: {
        Zoho_Module: payload.module,
        Zoho_Record_Id: payload.recordId,
      },
    });
    await deps.ledger.save({
      orgId,
      module: payload.module,
      recordId: payload.recordId,
      externalId: payload.recordId,
      ...(created.callId ? { callId: created.callId } : {}),
      ...(created.batchId ? { batchId: created.batchId } : {}),
      idempotencyKey: key,
      status: created.status,
      createdAt: now,
      updatedAt: now,
    });
    return `queued:${created.batchId ?? created.callId ?? "unknown"}`;
  } catch (err) {
    if (isTransient(err)) throw err;
    const e = err as { status?: number; requestId?: string };
    return `settled-error:${e.status ?? "unknown"}`;
  }
}
