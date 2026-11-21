// Zoho platform adapter: verify → normalize → write back.
// Zoho specifics live ONLY here (and sibling pure modules) — core stays neutral.
// TODO: switch relative imports to "@techladder/core" after first publish.

import { timingSafeEqual } from "node:crypto";
import { InboundEventSchema } from "../../core/src/events/types.js";
import type { AdapterContext, PlatformAdapter, RawIncomingRequest } from "../../core/src/adapter.js";
import type { CallCompletedEvent, InboundEvent } from "../../core/src/events/types.js";
import { performWriteback } from "./writeback.js";

/** Minimal subset of a Zoho workflow webhook delivery we care about. */
export interface ZohoPlatformEvent {
  /** Zoho module API name: Leads, Contacts or Deals. */
  module: string;
  /** Zoho org id. Neutral tenant id for core. */
  orgId: string;
  record: Record<string, unknown>;
}

export interface ZohoAdapterConfig {
  /** Shared secret the Zoho workflow must send. From env, never logged. */
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

/** Map Zoho module -> neutral eventType. Unknown modules are ignored. */
export function moduleToEventType(module: string): "lead_callback" | "deal_callback" | null {
  if (module === "Leads" || module === "Contacts") return "lead_callback";
  if (module === "Deals") return "deal_callback";
  return null;
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
      await performWriteback(
        {
          dataCenter: ctx.config.dataCenter || config.dataCenter,
          getToken: () => token,
          ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {}),
          module,
          outcomeField: ctx.config.outcomeField ?? config.outcomeField ?? "Call_Outcome",
          fieldMapping: ctx.config.fieldMapping ?? config.fieldMapping ?? {},
        },
        result,
      );
    },
  };
}
