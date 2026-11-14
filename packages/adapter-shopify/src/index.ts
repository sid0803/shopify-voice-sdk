// Shopify adapter scaffold (Phase 4, Bolna-parity target).
// Shopify specifics live ONLY here — core stays neutral.
// TODO: switch relative imports to "@techladder/core" after first publish.

import { createHmac, timingSafeEqual } from "node:crypto";
import { InboundEventSchema } from "../../core/src/events/types.js";
import type { CallDisposition, CallExecutionStatus } from "../../core/src/events/types.js";
import { SHOPIFY_API_VERSION } from "./shopifyConfig.js";
import type { AdapterContext, PlatformAdapter, RawIncomingRequest } from "../../core/src/adapter.js";
import type { CallCompletedEvent, InboundEvent } from "../../core/src/events/types.js";

/** Minimal subset of a Shopify webhook delivery we care about. */
export interface ShopifyPlatformEvent {
  topic: string;
  shopDomain: string;
  payload: {
    id: number | string;
    phone?: string | null;
    first_name?: string | null;
    last_name?: string | null;
    // Abandoned checkout shapes carry phone deeper; adapter extracts best-effort.
    customer?: { first_name?: string | null; last_name?: string | null; phone?: string | null } | null;
  };
}

export interface ShopifyAdapterConfig {
  /** App secret for X-Shopify-Hmac-Sha256 verification. From env, never logged. */
  apiSecret: string;
  /** Store Admin API token for write-back. From OAuth, per-shop. */
  accessToken?: string;
  /** e.g. "2026-01". UNVERIFIED — confirm latest stable with senior. */
  apiVersion?: string;
  fetchImpl?: typeof fetch;
}

function header(headers: RawIncomingRequest["headers"], name: string): string | undefined {
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === name) return Array.isArray(v) ? v[0] : v;
  }
  return undefined;
}

function toBytes(body: Uint8Array | string): Uint8Array {
  return typeof body === "string" ? new TextEncoder().encode(body) : body;
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
      last = new Error(`Shopify responded ${res.status}`);
    } catch (err) {
      last = err;
    }
    if (i < attempts) await sleep(Math.min(1000 * 2 ** (i - 1), 4000) + Math.floor(Math.random() * 200));
  }
  throw last instanceof Error ? last : new Error("Shopify write-back failed");
}

// Tag mapping from prompt v2.0 section 11 (recommended Shopify tag mapping).
// Business dispositions only — the agent never claims tags were applied.
export function outcomeToTag(outcome: CallDisposition): string {
  switch (outcome) {
    case "confirmed": return "call-confirmed";
    case "cancelled": return "call-cancel-requested";
    case "modification_requested": return "call-modification-requested";
    case "callback_requested": return "call-callback-requested";
    case "human_assistance": return "call-human-assistance";
    case "uncertain": return "call-uncertain";
    case "wrong_number": return "call-wrong-number";
  }
}

/** Execution statuses never reach Main Disposition (prompt v2.0 section 2 + 10E).
 * The platform maps them to tags directly when no conversation occurred. */
export function executionStatusToTag(status: CallExecutionStatus): string {
  switch (status) {
    case "completed": return "call-confirmed";
    case "no_answer": return "call-no-answer";
    case "failed": return "call-failed";
  }
}

/** Map Shopify topic -> neutral eventType. null = ignore. */
export function topicToEventType(topic: string): "order_confirmation" | "cart_recovery" | null {
  if (topic === "orders/create" || topic === "orders/updated") return "order_confirmation";
  if (topic.startsWith("checkouts/") || topic === "carts/update") return "cart_recovery";
  return null;
}

export function createShopifyAdapter(config: ShopifyAdapterConfig): PlatformAdapter<ShopifyPlatformEvent, ShopifyAdapterConfig> {
  return {
    name: "shopify",
    async verifyIncoming(request: RawIncomingRequest): Promise<void> {
      const got = header(request.headers, "x-shopify-hmac-sha256") ?? "";
      const raw = toBytes(request.rawBody);
      const digest = createHmac("sha256", config.apiSecret).update(raw).digest("base64");
      const a = Buffer.from(got);
      const b = Buffer.from(digest);
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        throw new Error("Invalid Shopify HMAC");
      }
    },
    toStandardEvent(e: ShopifyPlatformEvent): InboundEvent | null {
      const eventType = topicToEventType(e.topic);
      if (!eventType) return null;
      const phone = e.payload.phone ?? e.payload.customer?.phone ?? null;
      if (!phone) return null;
      const first = e.payload.first_name ?? e.payload.customer?.first_name ?? "";
      const last = e.payload.last_name ?? e.payload.customer?.last_name ?? "";
      const name = `${first} ${last}`.trim() || undefined;
      const parsed = InboundEventSchema.safeParse({
        eventType,
        contact: { name, phone },
        context: { shopifyTopic: e.topic, shopifyId: e.payload.id },
        source: "shopify",
        externalId: String(e.payload.id),
        externalAccountId: e.shopDomain,
      });
      return parsed.success ? parsed.data : null;
    },
    async handleResult(result: CallCompletedEvent, ctx: AdapterContext<ShopifyAdapterConfig>): Promise<void> {
      const token = ctx.config.accessToken ?? config.accessToken;
      if (!token) throw new Error("Missing Shopify access token for write-back");
      const version = ctx.config.apiVersion ?? config.apiVersion ?? SHOPIFY_API_VERSION;
      const shop = ctx.externalAccountId;
      // Business disposition decides the tag; a non-completed execution status
      // (no conversation occurred) maps via execution status instead (prompt v2.0 section 10E).
      // Absent callStatus means completed — the call.completed path.
      const tag =
        result.callStatus !== undefined && result.callStatus !== "completed"
          ? executionStatusToTag(result.callStatus)
          : outcomeToTag(result.outcome);
      // Merge-safe write-back: GET existing tags first, then PUT merged set.
      // Shopify REST replaces tags on PUT — blind PUT would clobber merchant tags.
      const fetchImpl = config.fetchImpl ?? fetch;
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
      };
      const base = `https://${shop}/admin/api/${version}/orders/${encodeURIComponent(result.externalId)}`;
      const current = await fetchWithRetry(fetchImpl, `${base}.json`, {
        headers,
        signal: AbortSignal.timeout(15_000),
      });
      let merged = tag;
      if (current.ok) {
        const body = (await current.json()) as { order?: { tags?: string } };
        const existing = (body.order?.tags ?? "").split(",").map((t) => t.trim()).filter(Boolean);
        if (!existing.includes(tag)) existing.push(tag);
        merged = existing.join(", ");
      }
      await fetchWithRetry(fetchImpl, `${base}.json`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ order: { id: Number(result.externalId) || result.externalId, tags: merged } }),
        signal: AbortSignal.timeout(15_000),
      });
    },
  };
}
