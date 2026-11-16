// Order webhook processor. Runs in the background worker, never in the
// Shopify request (the route only dedupes + enqueues + acks).
import {
  defaultSettings,
  extractCustomerId,
  extractName,
  extractPhone,
  friendlyStoreName,
  isSettingsConfigured,
  normalizePhone,
  scheduleSlot,
  withEnvFallbacks,
  withinCallingHours,
} from "@techladder/adapter-shopify";
import { buildScopedIdempotencyKey } from "@techladder/core";
import { getStores } from "./stores.server.js";
import { createOrderCall } from "./techladder.server.js";

type UnknownRecord = Record<string, unknown>;

export interface OrderJobPayload {
  shop: string;
  /** Top-level copy so a GDPR redact can purge queued jobs by customer. */
  customerId?: string;
  payload: UnknownRecord;
}

function isTransient(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  if (typeof status === "number") return status === 429 || status >= 500;
  return /fetch failed|aborted|timeout|network|5\d\d/i.test(
    String((err as Error)?.message ?? err),
  );
}

function orderTotal(payload: UnknownRecord): number {
  const raw = (payload["total_price"] ?? payload["total"]) as string | number | undefined;
  const n = Number(raw ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function paymentMethod(payload: UnknownRecord): string | undefined {
  const direct = payload["financial_status"] as string | undefined;
  const gateways = payload["payment_gateway_names"];
  if (direct) return direct;
  if (Array.isArray(gateways)) return gateways.map(String).join(", ") || undefined;
  return undefined;
}

function itemsSummary(payload: UnknownRecord): string | undefined {
  const items = payload["line_items"];
  if (!Array.isArray(items)) return undefined;
  return (items as UnknownRecord[])
    .map((li) => `${String(li["title"] ?? "item")} x${String(li["quantity"] ?? 1)}`)
    .join(", ")
    .slice(0, 500);
}

/**
 * Returns a short outcome string for logs. Throws only on transient failures so
 * the queue retries; settled merchant/data errors are acknowledged (no retry).
 */
export async function processOrderJob(payload: OrderJobPayload): Promise<string> {
  const shop = payload.shop.toLowerCase();
  const order = payload.payload;
  const stores = await getStores();
  const settings = withEnvFallbacks(
    (await stores.settings.get(shop)) ?? defaultSettings(shop),
  );

  const orderId = String(order["id"] ?? "");
  if (!orderId) return "ignored:no-order-id";
  if (!settings.enabled) return "skipped:disabled";
  if (!isSettingsConfigured(settings)) return "skipped:not-configured";
  if (
    !withinCallingHours(
      settings.callingHours.start,
      settings.callingHours.end,
      settings.callingHours.timezone,
    )
  ) {
    return "skipped:outside-hours";
  }

  const phone = normalizePhone(extractPhone(order), settings.shopCountry);
  if (!phone) return "skipped:no-phone";
  const blocked = settings.blockedPhones.map((p) => p.replace(/\D/g, ""));
  if (blocked.includes(phone.replace(/\D/g, ""))) return "skipped:dnc";

  if (settings.codOnly && !/cod|cash|collect|pending/i.test(paymentMethod(order) ?? "")) {
    return "skipped:not-cod";
  }
  if (settings.minOrderValue > 0 && orderTotal(order) < settings.minOrderValue) {
    return "skipped:below-minimum";
  }

  const { first, last } = extractName(order);
  const customerName = [first, last].filter(Boolean).join(" ") || undefined;
  const customerId = payload.customerId ?? extractCustomerId(order);
  const key = buildScopedIdempotencyKey("shopify", shop, "order_confirmation", orderId);
  const slot = scheduleSlot(Date.now(), settings.callingHours.timezone);
  const now = new Date().toISOString();

  try {
    const created = await createOrderCall(settings, {
      orderId,
      phone,
      customerName,
      orderReference: String(order["name"] ?? orderId),
      orderItems: itemsSummary(order),
      paymentMethod: paymentMethod(order),
      orderAmount: String(order["total_price"] ?? order["total"] ?? ""),
      storeName: friendlyStoreName(shop, process.env.STORE_DISPLAY_NAME ?? ""),
      language: settings.language,
      idempotencyKey: key,
      scheduleDate: slot.schedule_date,
      scheduleTime: slot.schedule_time,
      timezone: slot.timezone,
    });

    await stores.ledger.save({
      shop,
      orderId,
      externalId: orderId,
      ...(created.callId ? { callId: created.callId } : {}),
      ...(created.batchId ? { batchId: created.batchId } : {}),
      ...(customerId ? { customerId } : {}),
      idempotencyKey: key,
      status: created.status,
      createdAt: now,
      updatedAt: now,
    });
    return `queued:${created.batchId ?? created.callId ?? "unknown"}`;
  } catch (err) {
    if (isTransient(err)) throw err;
    const e = err as { status?: number; requestId?: string };
    console.error(
      `[order:settled] shop=${shop} order=${orderId} status=${e.status ?? "-"} requestId=${e.requestId ?? "-"}`,
    );
    return `settled-error:${e.status ?? "unknown"}`;
  }
}
