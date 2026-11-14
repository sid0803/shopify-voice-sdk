// Generic webhook adapter (Phase 3).
// Depends on core types only. No platform names in core.
// TODO: switch relative imports to "@techladder/core" after first publish.
import { timingSafeEqual } from "node:crypto";
import { InboundEventSchema } from "../../core/src/events/types.js";
import type { AdapterContext, PlatformAdapter, RawIncomingRequest } from "../../core/src/adapter.js";
import type { CallCompletedEvent, InboundEvent } from "../../core/src/events/types.js";

export interface GenericPlatformEvent {
  eventType?: string;
  phone?: string;
  name?: string;
  language?: string;
  externalId?: string;
  externalAccountId?: string;
  source?: string;
  context?: Record<string, unknown>;
}

export interface WebhookAdapterConfig {
  /** Optional shared secret checked against `x-webhook-secret`. Absent = accept (generic URL). */
  sharedSecret?: string;
  /** Where handleResult POSTs the call outcome. Absent = no-op. */
  callbackUrl?: string;
  sourceName?: string;
  fetchImpl?: typeof fetch;
}

function header(headers: RawIncomingRequest["headers"], name: string): string | undefined {
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === name) return Array.isArray(v) ? v[0] : v;
  }
  return undefined;
}

export function createWebhookAdapter(config: WebhookAdapterConfig = {}): PlatformAdapter<GenericPlatformEvent, WebhookAdapterConfig> {
  return {
    name: "webhook",
    async verifyIncoming(request: RawIncomingRequest): Promise<void> {
      if (!config.sharedSecret) return;
      const got = header(request.headers, "x-webhook-secret") ?? "";
      const a = Buffer.from(got);
      const b = Buffer.from(config.sharedSecret);
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        throw new Error("Invalid webhook secret");
      }
    },
    toStandardEvent(e: GenericPlatformEvent): InboundEvent | null {
      if (!e.phone || !e.externalId || !e.externalAccountId) return null;
      const parsed = InboundEventSchema.safeParse({
        eventType: e.eventType ?? "lead_callback",
        contact: { name: e.name, phone: e.phone, language: e.language },
        context: e.context ?? {},
        source: e.source ?? config.sourceName ?? "webhook",
        externalId: e.externalId,
        externalAccountId: e.externalAccountId,
      });
      return parsed.success ? parsed.data : null;
    },
    async handleResult(result: CallCompletedEvent, ctx: AdapterContext<WebhookAdapterConfig>): Promise<void> {
      const url = ctx.config.callbackUrl ?? config.callbackUrl;
      if (!url) return;
      const fetchImpl = config.fetchImpl ?? fetch;
      await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(result),
        signal: AbortSignal.timeout(15_000),
      });
    },
  };
}
