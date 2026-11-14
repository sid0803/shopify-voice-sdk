// Per-shop settings (senior item 4). Everything hardcoded in app/server.ts moves
// here: agent, version, caller number, order filters, hours, language, retries,
// tags. Embedded admin UI (App Bridge + Polaris, needs Shopify CLI scaffold)
// reads/writes these rows; the connector only reads.
import { z } from "zod";

export const ShopSettingsSchema = z.object({
  externalAccountId: z.string().min(1).max(120),
  /** Pasted TechLadder sk_ key, validated via GET /me at Connect time. Stored encrypted in prod. */
  techladderKeyRef: z.string().max(120).default(""),
  agentId: z.string().min(1).max(120),
  versionName: z.string().min(1).max(120),
  voice: z.string().min(1).max(120),
  didNumberId: z.string().max(120).optional(),
  /** v1 example: only COD orders get called. Default false so test/manual
   * orders flow; merchants opt in. */
  codOnly: z.boolean().default(false),
  minOrderValue: z.number().int().min(0).default(0),
  callingHours: z.object({
    start: z.string().regex(/^\d{2}:\d{2}$/),
    end: z.string().regex(/^\d{2}:\d{2}$/),
    timezone: z.string().min(1).max(64),
  }),
  language: z.string().max(16).optional(),
  maxRetries: z.number().int().min(0).max(5).default(0),
  tagsEnabled: z.boolean().default(true),
  tagNames: z.record(z.string().max(64)).default({}),
  /** Merchant DND list (E.164). Consent source TBD — see backend-gaps. */
  blockedPhones: z.array(z.string().max(32)).default([]),
  enabled: z.boolean().default(true),
});

export type ShopSettings = z.infer<typeof ShopSettingsSchema>;

export interface SettingsStore {
  get(externalAccountId: string): ShopSettings | Promise<ShopSettings | null> | null;
  save(settings: ShopSettings): void | Promise<void>;
}

export function defaultSettings(externalAccountId: string): ShopSettings {
  return ShopSettingsSchema.parse({
    externalAccountId,
    agentId: process.env["AGENT_ID"] ?? "agt-d24d1800",
    versionName: process.env["AGENT_VERSION"] ?? "Version 2",
    voice: process.env["AGENT_VOICE"] ?? "Deepika",
    callingHours: { start: "09:00", end: "21:00", timezone: process.env["SCHEDULE_TIMEZONE"] ?? "Asia/Kolkata" },
  });
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
}
