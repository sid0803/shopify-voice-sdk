// Per-org settings. Everything hardcoded in a future shell moves here:
// agent, voice, trigger module/event, value filters, hours, language, retries,
// write-back fields, DND. A settings UI reads/writes these rows; the connector
// only reads.
//
// No real agent/voice/timezone/token literals live in this file. Blank values
// mean "not connected/configured yet" and calls are skipped until the Connect
// flow writes real values. Env values are a staging-only fallback.
import { z } from "zod";

/** Reject typo'd IANA zones at save time instead of crashing the worker later. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

const TimeZoneSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(isValidTimeZone, { message: "Invalid IANA timezone" });

export const ZohoSettingsSchema = z.object({
  /** Zoho org id. Neutral tenant id; never a platform-specific name in core. */
  externalAccountId: z.string().min(1).max(120),
  /**
   * Pasted TechLadder sk_ key, validated via GET /me at Connect time.
   * At rest the stores persist an encrypted copy; this field is the in-memory
   * plaintext value and must never be logged.
   */
  techladderKeyRef: z.string().max(512).default(""),
  /** TechLadder account id from GET /me (support correlation, non-secret). */
  techladderAccountId: z.string().max(120).optional(),
  /** TechLadder account display name from GET /me (non-secret). */
  techladderAccountName: z.string().max(200).optional(),
  /** Per-org TechLadder webhook signing secret (whsec_). Encrypted at rest. */
  techladderWebhookSecretRef: z.string().max(512).default(""),
  /** TechLadder webhook endpoint id, so Connect can update instead of recreate. */
  techladderWebhookEndpointId: z.string().max(120).optional(),
  agentId: z.string().max(120).default(""),
  versionName: z.string().max(120).default(""),
  voice: z.string().max(120).default(""),
  didNumberId: z.string().max(120).optional(),
  /** Which Zoho module fires calls. v1 default Leads; Deals needs senior sign-off. */
  triggerModule: z.enum(["Leads", "Contacts", "Deals"]).default("Leads"),
  /** created = workflow on record create; stuck = no-activity for stuckDays. */
  triggerEvent: z.enum(["created", "stuck"]).default("created"),
  /** Days of no activity before a record counts as stuck (triggerEvent stuck). */
  stuckDays: z.number().int().min(1).max(90).optional(),
  /** Minimum deal value to call (Deals module; ignored otherwise). */
  minDealValue: z.number().int().min(0).default(0),
  callingHours: z
    .object({
      start: z.string().regex(/^\d{2}:\d{2}$/),
      end: z.string().regex(/^\d{2}:\d{2}$/),
      timezone: TimeZoneSchema,
    })
    .default({ start: "09:00", end: "21:00", timezone: "UTC" }),
  /** ISO 3166-1 alpha-2, used as the default region for phone normalization. */
  orgCountry: z.string().length(2).optional(),
  language: z.string().max(16).optional(),
  maxRetries: z.number().int().min(0).max(5).default(0),
  /** Write the outcome back as a Note + record field. Still log when disabled. */
  notesEnabled: z.boolean().default(true),
  /**
   * D5 consent policy, still awaiting senior confirmation. true (default) =
   * calls require an explicitly granted consent status; false = proceed unless
   * an opt-out or revocation is seen. Either way opt-out/revoked always block.
   */
  requireExplicitConsent: z.boolean().default(true),
  /** Zoho API name of the record field receiving the outcome label. */
  outcomeField: z.string().max(64).default("Call_Outcome"),
  /** Optional merchant overrides, keyed by default outcome label. */
  fieldMapping: z.record(z.string().max(64)).default({}),
  /** Merchant DND list (E.164). Consent source TBD — see backend-gaps. */
  blockedPhones: z.array(z.string().max(32)).default([]),
  enabled: z.boolean().default(true),
});

export type ZohoSettings = z.infer<typeof ZohoSettingsSchema>;

export interface ZohoSettingsStore {
  get(externalAccountId: string): ZohoSettings | Promise<ZohoSettings | null> | null;
  save(settings: ZohoSettings): void | Promise<void>;
  /** Org disconnect: delete the encrypted key + webhook secret row. */
  remove?(externalAccountId: string): void | Promise<void>;
}

/**
 * Blank defaults only. The Connect screen fills these per org.
 * Env fallbacks exist for local/staging runs; production never relies on them.
 */
export function defaultZohoSettings(externalAccountId: string): ZohoSettings {
  return ZohoSettingsSchema.parse({
    externalAccountId,
    agentId: process.env["AGENT_ID"] ?? "",
    versionName: process.env["AGENT_VERSION"] ?? "",
    voice: process.env["AGENT_VOICE"] ?? "",
    callingHours: {
      start: "09:00",
      end: "21:00",
      timezone: process.env["SCHEDULE_TIMEZONE"] || "UTC",
    },
  });
}

/** Apply staging-only env fallbacks without persisting them. */
export function withZohoEnvFallbacks(settings: ZohoSettings): ZohoSettings {
  return ZohoSettingsSchema.parse({
    ...settings,
    techladderKeyRef: settings.techladderKeyRef || process.env["TECHLADDER_API_KEY"] || "",
    agentId: settings.agentId || process.env["AGENT_ID"] || "",
    versionName: settings.versionName || process.env["AGENT_VERSION"] || "",
    voice: settings.voice || process.env["AGENT_VOICE"] || "",
    callingHours: {
      ...settings.callingHours,
      timezone: settings.callingHours.timezone || process.env["SCHEDULE_TIMEZONE"] || "UTC",
    },
  });
}

/** True when a call can be attempted. Missing config is a safe skip, not a crash. */
export function isZohoSettingsConfigured(settings: ZohoSettings): boolean {
  return Boolean(
    settings.enabled &&
      settings.techladderKeyRef &&
      settings.agentId &&
      settings.versionName &&
      settings.voice,
  );
}

export class InMemoryZohoSettingsStore implements ZohoSettingsStore {
  private readonly map = new Map<string, ZohoSettings>();
  get(externalAccountId: string): ZohoSettings | null {
    return this.map.get(externalAccountId.toLowerCase()) ?? null;
  }
  save(settings: ZohoSettings): void {
    ZohoSettingsSchema.parse(settings);
    this.map.set(settings.externalAccountId.toLowerCase(), settings);
  }
  remove(externalAccountId: string): void {
    this.map.delete(externalAccountId.toLowerCase());
  }
}
