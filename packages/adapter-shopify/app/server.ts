// Auto-connector: Shopify orders -> TechLadder batches -> Shopify tags.
// Staging host replaces tunnels; laptop runs are test-only.
// Env (server only, never browser, never commit):
//   SHOPIFY_API_SECRET (REQUIRED — server refuses to start without it),
//   SHOPIFY_SHOP, TECHLADDER_API_KEY, TECHLADDER_BASE_URL (REQUIRED),
//   AGENT_ID, AGENT_VERSION, AGENT_VOICE, SCHEDULE_TIMEZONE, STORE_DISPLAY_NAME,
//   SHOPIFY_TOKEN (optional: absent = write-back logged, not PUT),
//   TECHLADDER_WEBHOOK_SECRET (optional: absent = TechLadder posts ignored),
//   WEBHOOK_TOLERANCE (default 300, senior-agreed test value), PORT.
// Per-shop overrides (agent, hours, filters, tags) live in ShopSettings
// (src/settings.ts) — the embedded admin UI writes them; env is fallback.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createShopifyAdapter } from "../src/index.js";
import { InMemoryCallLedger, InMemoryEventClaim, InMemoryShopStore } from "../src/stores.js";
import { defaultSettings, InMemorySettingsStore } from "../src/settings.js";
import { TechLadderHttpClient, BatchesResource, buildScopedIdempotencyKey } from "../../core/src/index.js";
import { verifyWebhook } from "../../core/src/webhooks/verify.js";
import { toCallResult } from "../src/result.js";
import { handleGdprWebhook } from "../src/gdpr.js";
import { extractName, extractPhone, friendlyStoreName, headerVal, isTestDelivery, normalizePhone, scheduleSlot } from "./mapping.js";

// Load techladder-sdk/.env so nothing is pasted in terminal.
for (const p of [
  join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".env"),
  join(process.cwd(), "..", "..", ".env"),
]) {
  if (!existsSync(p)) continue;
  for (const line of readFileSync(p, "utf-8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
  break;
}

function required(name: string): string {
  const v = (process.env[name] ?? "").trim();
  if (!v) {
    console.error(`[fatal] ${name} is required — refusing to start`);
    process.exit(1);
  }
  return v;
}

const PORT = Number(process.env["PORT"] ?? "4311");
const SHOPIFY_SECRET = required("SHOPIFY_API_SECRET");
const SHOP = (process.env["SHOPIFY_SHOP"] ?? "").toLowerCase();
const TL_KEY = required("TECHLADDER_API_KEY");
const TL_BASE = required("TECHLADDER_BASE_URL");
const SHOPIFY_TOKEN = process.env["SHOPIFY_TOKEN"] ?? "";
const TOLERANCE = Number(process.env["WEBHOOK_TOLERANCE"] ?? "300");

const shops = new InMemoryShopStore();
const claims = new InMemoryEventClaim();
const ledger = new InMemoryCallLedger();
const claims = new InMemoryEventClaim();
const settingsStore = new InMemorySettingsStore();
const shopify = createShopifyAdapter({ apiSecret: SHOPIFY_SECRET, accessToken: SHOPIFY_TOKEN || undefined });

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "Content-Type": "text/plain" });
  res.end(body);
}

/** Transient (retryable by Shopify) vs settled failures. */
function transientOf(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  if (typeof status === "number") return status === 429 || status >= 500;
  return /fetch failed|aborted|timeout|network|5\d\d/i.test(String((err as Error)?.message ?? err));
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/health") return send(res, 200, "ok");

    if (req.method === "POST" && url.pathname === "/webhooks/shopify/orders") {
      const raw = await readBody(req);
      const headers = req.headers as Record<string, string | string[] | undefined>;
      if (isTestDelivery(headers)) {
        console.log("[shopify:test-skipped] Send-test notification ignored");
        return send(res, 200, "test-skipped");
      }
      try {
        await shopify.verifyIncoming({ rawBody: raw, headers });
      } catch {
        return send(res, 401, "bad signature");
      }
      const topic = headerVal(headers, "x-shopify-topic") || "orders/create";
      const shop = (headerVal(headers, "x-shopify-shop-domain") || SHOP).toLowerCase();
      if (topic === "app/uninstalled") {
        await shops.remove(shop);
        console.log(`[shopify:uninstalled] shop=${shop} token revoked, calling stopped`);
        return send(res, 200, "uninstalled");
      }
      const settings = (await settingsStore.get(shop)) ?? defaultSettings(shop);
      if (!settings.enabled) return send(res, 200, "disabled");
      const payload = JSON.parse(raw.toString("utf-8") ?? "{}") as Record<string, unknown>;
      const phone = normalizePhone(extractPhone(payload));
      if (!phone) {
        console.log(`[shopify:ignored] shop=${shop} topic=${topic} undialable phone`);
        return send(res, 200, "ignored");
      }
      if (settings.blockedPhones.map((p) => p.replace(/\D/g, "")).includes(phone.replace(/\D/g, ""))) {
        console.log(`[shopify:suppressed] shop=${shop} phone on DND list`);
        return send(res, 200, "suppressed");
      }
      const { first: firstName, last: lastName } = extractName(payload);
      const orderName = (payload["name"] as string | undefined) || undefined;
      const orderId = String((payload["id"] as number | string | undefined) ?? "");
      if (!orderId) return send(res, 200, "ignored");
      const items = payload["line_items"];
      const itemsSummary = Array.isArray(items)
        ? (items as Array<Record<string, unknown>>)
            .map((li) => `${String(li["title"] ?? "item")} x${String(li["quantity"] ?? 1)}`)
            .join(", ")
            .slice(0, 500)
        : undefined;
      const payment =
        (payload["financial_status"] as string | undefined) ||
        (Array.isArray(payload["payment_gateway_names"])
          ? ((payload["payment_gateway_names"] as unknown[]).map(String).join(", ") || undefined)
          : undefined);
      const total =
        (payload["total_price"] as string | undefined) ??
        (payload["total"] as string | undefined);
      if (settings.codOnly && !/cod|cash|collect|pending/i.test(payment ?? "")) {
        console.log(`[shopify:filtered] shop=${shop} order=${orderId} non-COD skipped`);
        return send(res, 200, "filtered");
      }
      const std = shopify.toStandardEvent({
        topic,
        shopDomain: shop,
        payload: { id: orderId, phone, first_name: firstName },
      });
      if (!std) return send(res, 200, "ignored");
      const ctx = `shop=${std.externalAccountId} order=${std.externalId}`;
      const slot = scheduleSlot(Date.now(), settings.callingHours.timezone);
      // No retries here: fast ack, Shopify redelivers on 5xx, idempotency dedupes.
      const http = new TechLadderHttpClient({ apiKey: TL_KEY, baseUrl: TL_BASE, maxRetries: 0 });
      const batches = new BatchesResource(http);
      const customerName = [firstName, lastName].filter(Boolean).join(" ") || undefined;
      const key = buildScopedIdempotencyKey(std.source, std.externalAccountId, std.eventType, std.externalId);
      try {
        const out = await batches.createIdempotent({
          agent_id: settings.agentId,
          version_name: settings.versionName,
          voice: settings.voice,
          interruption: true,
          use_alternate_number: false,
          start_mode: "immediate",
          ...slot,
          ...(settings.didNumberId ? { did_number_id: settings.didNumberId } : {}),
          contacts: [
            {
              external_id: std.externalId,
              phone_number: phone,
              metadata: {
                Customer_Name: customerName,
                Order_Reference: orderName ?? std.externalId,
                Order_Items: itemsSummary,
                Payment_Method: payment,
                Order_Amount: total,
                Store_Name: friendlyStoreName(shop, process.env["STORE_DISPLAY_NAME"] ?? ""),
              },
            },
          ],
          idempotency_key: key,
        });
        const now = new Date().toISOString();
        ledger.save({ shop, orderId: std.externalId, externalId: std.externalId, batchId: out.batch_id, idempotencyKey: key, status: out.status, createdAt: now, updatedAt: now });
        await shops.save({ shopDomain: shop, accessToken: SHOPIFY_TOKEN, installedAt: now });
        console.log(`[shopify:queued] ${ctx} batch=${out.batch_id}`);
        return send(res, 200, `queued ${out.batch_id}`);
      } catch (err) {
        if (transientOf(err)) return send(res, 502, "transient");
        const e = err as { status?: number; requestId?: string };
        console.error(`[shopify:settled] ${ctx}`, e.status ?? "-", e.requestId ?? "-");
        return send(res, 200, "ignored");
      }
    }

    if (req.method === "POST" && url.pathname === "/webhooks/techladder") {
      const raw = await readBody(req);
      const headers = req.headers as Record<string, string | string[] | undefined>;
      const secret = process.env["TECHLADDER_WEBHOOK_SECRET"] ?? "";
      if (!secret) return send(res, 200, "no-verify-secret: ignored");
      let eventId: string;
      try {
        eventId = verifyWebhook({ rawBody: raw, headers, secret, toleranceSeconds: TOLERANCE }).eventId;
      } catch {
        return send(res, 401, "bad signature");
      }
      if (!(await claims.claim(eventId))) return send(res, 200, "duplicate");
      const envelope = JSON.parse(raw.toString("utf-8") ?? "{}") as { data?: unknown; event?: string };
      const result = toCallResult({ ...(typeof envelope === "object" ? envelope : {}), event: envelope.event }, ledgerAdapter());
      if (!result) return send(res, 200, "ignored");
      const ctx = `shop=${result.externalAccountId} order=${result.externalId} outcome=${result.outcome}`;
      const settings = (await settingsStore.get(result.externalAccountId)) ?? defaultSettings(result.externalAccountId);
      if (!settings.tagsEnabled) {
        console.log(`[write-back:disabled] ${ctx}`);
        return send(res, 200, "disabled");
      }
      const cfg = { apiSecret: SHOPIFY_SECRET, accessToken: SHOPIFY_TOKEN || undefined };
      if (!SHOPIFY_TOKEN) {
        console.log(`[write-back:log-only] ${ctx}`);
        return send(res, 200, "logged");
      }
      try {
        await shopify.handleResult(result, { externalAccountId: result.externalAccountId, config: cfg });
      } catch (err) {
        if (transientOf(err)) return send(res, 502, "transient");
        console.error(`[write-back:settled] ${ctx}`, String((err as Error)?.message ?? err));
        return send(res, 200, "ignored");
      }
      ledger.update(result.externalId, { outcome: result.outcome, status: "tagged", tagApplied: result.outcome });
      ledger.update(result.callId, { outcome: result.outcome, status: "tagged", tagApplied: result.outcome });
      console.log(`[write-back:tagged] ${ctx}`);
      return send(res, 200, "tagged");
    }

    if (req.method === "POST" && url.pathname.startsWith("/webhooks/gdpr/")) {
      const raw = await readBody(req);
      const topic = url.pathname.split("/").pop() ?? "";
      const body = JSON.parse(raw.toString("utf-8") ?? "{}") as { shop_domain?: string };
      const out = await handleGdprWebhook(topic, (body.shop_domain ?? SHOP).toLowerCase(), shops, body);
      return send(res, 200, JSON.stringify(out.body));
    }

    return send(res, 404, "not found");
  } catch (err) {
    const e = err as { message?: string; status?: number; code?: string; requestId?: string; details?: unknown };
    console.error("[app] Request failed", e.status ?? "-", e.code ?? "-", e.requestId ?? "-", e.message ?? err, JSON.stringify(e.details ?? []));
    return send(res, 200, "ignored");
  }
});

function ledgerAdapter() {
  return {
    lookup: (key: string) => {
      const r = ledger.lookup(key);
      return r instanceof Promise ? null : r;
    },
  };
}

server.listen(PORT, () => console.log(`[adapter-shopify:app] listening :${PORT}`));
