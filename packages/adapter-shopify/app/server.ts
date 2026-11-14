// Auto-connector: Shopify orders -> TechLadder batches -> Shopify tags.
// Staging host replaces tunnels; laptop runs are test-only.
// Env (server only, never browser, never commit):
//   SHOPIFY_API_SECRET (REQUIRED — server refuses to start without it),
//   SHOPIFY_SHOP, TECHLADDER_API_KEY, TECHLADDER_BASE_URL (REQUIRED),
//   AGENT_ID, AGENT_VERSION, AGENT_VOICE, SCHEDULE_TIMEZONE, STORE_DISPLAY_NAME,
//   SHOPIFY_TOKEN (optional: absent = write-back logged, not PUT),
//   TECHLADDER_WEBHOOK_SECRET (optional: absent = TechLadder posts ignored),
//   WEBHOOK_TOLERANCE (default 300, senior-agreed test value), PORT.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createShopifyAdapter } from "../src/index.js";
import { InMemoryShopStore } from "../src/shopStore.js";
import { TechLadderHttpClient, BatchesResource, buildScopedIdempotencyKey } from "../../core/src/index.js";
import { verifyWebhook } from "../../core/src/webhooks/verify.js";
import { InMemoryWebhookStore, shouldProcessEvent } from "../../core/src/webhooks/dedupe.js";
import { CallCompletedEventSchema } from "../../core/src/events/types.js";
import { handleGdprWebhook } from "../src/gdpr.js";
import { extractName, extractPhone, friendlyStoreName, headerVal, isTestDelivery, scheduleSlot } from "./mapping.js";

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
// Agent pinned by senior for the COD use case; per-shop map comes after 3-4 use cases.
const AGENT_ID = process.env["AGENT_ID"] ?? "agt-d24d1800";
const AGENT_VERSION = process.env["AGENT_VERSION"] ?? "Version 2";
// Explicit voice: omitting it defaults to Kashufa, which drops after the greet on dev.
const AGENT_VOICE = process.env["AGENT_VOICE"] ?? "Deepika";
const SCHEDULE_TZ = process.env["SCHEDULE_TIMEZONE"] ?? "Asia/Kolkata";
const STORE_DISPLAY = process.env["STORE_DISPLAY_NAME"] ?? "";
const SHOPIFY_TOKEN = process.env["SHOPIFY_TOKEN"] ?? "";
const TOLERANCE = Number(process.env["WEBHOOK_TOLERANCE"] ?? "300");

const shops = new InMemoryShopStore();
const seen = new InMemoryWebhookStore();
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
      await shopify.verifyIncoming({ rawBody: raw, headers });
      const payload = JSON.parse(raw.toString("utf-8") ?? "{}") as Record<string, unknown>;
      const topic = headerVal(headers, "x-shopify-topic") || "orders/create";
      const shop = (headerVal(headers, "x-shopify-shop-domain") || SHOP).toLowerCase();
      const logCtx = `shop=${shop}`;
      const phone = extractPhone(payload);
      const { first: firstName, last: lastName } = extractName(payload);
      const orderName = (payload["name"] as string | undefined) || undefined;
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
      const std = shopify.toStandardEvent({
        topic,
        shopDomain: shop,
        payload: { id: (payload["id"] as number | string | undefined) ?? 0, phone, first_name: firstName },
      });
      if (!std) {
        console.log(`[shopify:ignored] ${logCtx} no phone or topic=${topic}`);
        return send(res, 200, "ignored");
      }
      const ctx = `shop=${std.externalAccountId} order=${std.externalId}`;
      const slot = scheduleSlot(Date.now(), SCHEDULE_TZ);
      const http = new TechLadderHttpClient({ apiKey: TL_KEY, baseUrl: TL_BASE });
      const batches = new BatchesResource(http);
      const customerName = [firstName, lastName].filter(Boolean).join(" ") || undefined;
      const out = await batches.createIdempotent({
        agent_id: AGENT_ID,
        version_name: AGENT_VERSION,
        voice: AGENT_VOICE,
        interruption: true,
        use_alternate_number: false,
        start_mode: "immediate",
        ...slot,
        contacts: [
          {
            external_id: std.externalId,
            phone_number: std.contact.phone,
            metadata: {
              Customer_Name: customerName,
              Order_Reference: orderName ?? std.externalId,
              Order_Items: itemsSummary,
              Payment_Method: payment,
              Store_Name: friendlyStoreName(shop, STORE_DISPLAY),
            },
          },
        ],
        idempotency_key: buildScopedIdempotencyKey(std.source, std.externalAccountId, std.eventType, std.externalId),
      });
      await shops.save({ shopDomain: shop, accessToken: SHOPIFY_TOKEN, installedAt: new Date().toISOString() });
      console.log(`[shopify:queued] ${ctx} batch=${out.batch_id}`);
      return send(res, 200, `queued ${out.batch_id}`);
    }

    if (req.method === "POST" && url.pathname === "/webhooks/techladder") {
      const raw = await readBody(req);
      const headers = req.headers as Record<string, string | string[] | undefined>;
      const secret = process.env["TECHLADDER_WEBHOOK_SECRET"] ?? "";
      if (!secret) return send(res, 200, "no-verify-secret: ignored");
      const v = verifyWebhook({ rawBody: raw, headers, secret, toleranceSeconds: TOLERANCE });
      if (!(await shouldProcessEvent(seen, v.eventId))) return send(res, 200, "duplicate");
      const envelope = JSON.parse(raw.toString("utf-8") ?? "{}") as { data?: unknown };
      const parsed = CallCompletedEventSchema.safeParse(envelope.data);
      if (!parsed.success) return send(res, 200, "ignored");
      const r = parsed.data;
      const ctx = `shop=${r.externalAccountId} order=${r.externalId} outcome=${r.outcome}`;
      const cfg = { apiSecret: SHOPIFY_SECRET, accessToken: SHOPIFY_TOKEN || undefined };
      if (!SHOPIFY_TOKEN) {
        console.log(`[write-back:log-only] ${ctx}`);
        return send(res, 200, "logged");
      }
      await shopify.handleResult(r, { externalAccountId: r.externalAccountId, config: cfg });
      console.log(`[write-back:tagged] ${ctx}`);
      return send(res, 200, "tagged");
    }

    if (req.method === "POST" && url.pathname.startsWith("/webhooks/gdpr/")) {
      const raw = await readBody(req);
      const topic = url.pathname.split("/").pop() ?? "";
      const body = JSON.parse(raw.toString("utf-8") ?? "{}") as string) as { shop_domain?: string };
      await handleGdprWebhook(topic, (body.shop_domain ?? SHOP).toLowerCase(), shops);
      return send(res, 200, "ok");
    }

    return send(res, 404, "not found");
  } catch (err) {
    const e = err as { message?: string; status?: number; code?: string; requestId?: string; details?: unknown };
    console.error("[app] Request failed", e.status ?? "-", e.code ?? "-", e.requestId ?? "-", e.message ?? err, JSON.stringify(e.details ?? []));
    return send(res, 200, "ignored");
  }
});

server.listen(PORT, () => console.log(`[adapter-shopify:app] listening :${PORT}`));
