// Per-shop settings (senior item 4). Everything hardcoded in app/server.ts moves
// here: agent, version, caller number, order filters, hours, language, retries,
// tags. Embedded admin UI reads/writes these rows; the connector only reads.
//
// No real agent/version/voice/timezone literals live in this file. Blank values
// mean "merchant has not connected/configured yet" and calls are skipped until
// the Connect screen writes a real value. Env values are a staging-only fallback.
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

export const ShopSettingsSchema = z.object({
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
  /** Per-shop TechLadder webhook signing secret (whsec_). Encrypted at rest. */
  techladderWebhookSecretRef: z.string().max(512).default(""),
  /** TechLadder webhook endpoint id, so Connect can update instead of recreate. */
  techladderWebhookEndpointId: z.string().max(120).optional(),
  agentId: z.string().max(120).default(""),
  versionName: z.string().max(120).default(""),
  voice: z.string().max(120).default(""),
  didNumberId: z.string().max(120).optional(),
  /** v1 example: only COD orders get called. Default false so test/manual
   * orders flow; merchants opt in. */
  codOnly: z.boolean().default(false),
  minOrderValue: z.number().int().min(0).default(0),
  callingHours: z
    .object({
      start: z.string().regex(/^\d{2}:\d{2}$/),
      end: z.string().regex(/^\d{2}:\d{2}$/),
      timezone: TimeZoneSchema,
    })
    .default({ start: "09:00", end: "21:00", timezone: "UTC" }),
  /** ISO 3166-1 alpha-2, used as the default region for phone normalization. */
  shopCountry: z.string().length(2).optional(),
  language: z.string().max(16).optional(),
  maxRetries: z.number().int().min(0).max(5).default(0),
  tagsEnabled: z.boolean().default(true),
  /** Optional merchant overrides, keyed by default tag name. */
  tagNames: z.record(z.string().max(64)).default({}),
  /** Merchant DND list (E.164). Consent source TBD — see backend-gaps. */
  blockedPhones: z.array(z.string().max(32)).default([]),
  enabled: z.boolean().default(true),
});

export type ShopSettings = z.infer<typeof ShopSettingsSchema>;

export interface SettingsStore {
  get(externalAccountId: string): ShopSettings | Promise<ShopSettings | null> | null;
  save(settings: ShopSettings): void | Promise<void>;
  /** GDPR shop/redact: delete the encrypted key + webhook secret row. */
  remove?(externalAccountId: string): void | Promise<void>;
}

/**
 * Blank defaults only. The Connect/Settings screens fill these per shop.
 * Env fallbacks exist for local/staging runs; production never relies on them.
 */
export function defaultSettings(externalAccountId: string): ShopSettings {
  return ShopSettingsSchema.parse({
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
export function withEnvFallbacks(settings: ShopSettings): ShopSettings {
  return ShopSettingsSchema.parse({
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
export function isSettingsConfigured(settings: ShopSettings): boolean {
  return Boolean(
    settings.enabled &&
      settings.techladderKeyRef &&
      settings.agentId &&
      settings.versionName &&
      settings.voice,
  );
}

export class InMemorySettingsStore implements SettingsStore {
  private readonly map = new Map<string, ShopSettings>();
  get(externalAccountId: string): ShopSettings | null {
    return this.map.get(externalAccountId.toLowerCase()) ?? null;
  }
  save(settings: ShopSettings): void {
    ShopSettingsSchema.parse(settings);
    this.map.set(settings.externalAccountId.toLowerCase(), settings);
  }
  remove(externalAccountId: string): void {
    this.map.delete(externalAccountId.toLowerCase());
  }
}
