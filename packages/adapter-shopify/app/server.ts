// Minimal auto-connector for basic-flow test (no Remix/CLI required).
// Run with a tunnel (e.g. cloudflared/ngrok) and register the tunnel URL in
// Partners Dashboard -> AI Calls -> Webhooks:
//   orders/create -> POST https://<tunnel>/webhooks/shopify/orders
// TechLadder dashboard -> webhook-endpoints url: https://<tunnel>/webhooks/techladder
// Env (server only, never browser, never commit):
//   SHOPIFY_API_SECRET, SHOPIFY_SHOP, TECHLADDER_API_KEY, TECHLADDER_BASE_URL,
//   SHOPIFY_TOKEN (optional for live tag write-back; absent = log only),
//   WEBHOOK_TOLERANCE (default 300, senior-agreed test value).
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
const PORT = Number(process.env["PORT"] ?? "4311");
const SHOPIFY_SECRET = process.env["SHOPIFY_API_SECRET"] ?? "";
const SHOP = process.env["SHOPIFY_SHOP"] ?? "dev-store-1gm9xtph.myshopify.com";
const TL_KEY = process.env["TECHLADDER_API_KEY"] ?? "";
const TL_BASE = process.env["TECHLADDER_BASE_URL"] ?? "";
const SHOPIFY_TOKEN = process.env["SHOPIFY_TOKEN"] ?? "";
const TOLERANCE = Number(process.env["WEBHOOK_TOLERANCE"] ?? "300");
// Friendly store name for speech. Raw *.myshopify.com domains must never be
// spoken aloud — prefer STORE_DISPLAY_NAME, else prettify the subdomain.
const STORE_DISPLAY = process.env["STORE_DISPLAY_NAME"] || "";
function friendlyStoreName(shopDomain: string): string {
  if (STORE_DISPLAY.trim()) return STORE_DISPLAY.trim();
  const sub = shopDomain.split(".")[0] ?? shopDomain;
  return sub.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim() || shopDomain;
}

if (!TL_KEY || !TL_BASE) throw new Error("Set TECHLADDER_API_KEY and TECHLADDER_BASE_URL");
if (!SHOPIFY_SECRET) console.warn("[warn] SHOPIFY_API_SECRET missing: Shopify verify skipped (test only)");

const shops = new InMemoryShopStore();
const seen = new InMemoryWebhookStore();
const shopify = createShopifyAdapter({ apiSecret: SHOPIFY_SECRET || "test-only", accessToken: SHOPIFY_TOKEN || undefined });

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
      const headerVal = (n: string): string | undefined => {
        for (const [k, v] of Object.entries(headers)) {
          if (k.toLowerCase() === n) return Array.isArray(v) ? v[0] : v;
        }
        return undefined;
      };
      // Shopify marks "Send test" deliveries with X-Shopify-Test: true.
      // They carry dummy data — skip before touching TechLadder.
      if ((headerVal("x-shopify-test") ?? "").toLowerCase() === "true") {
        console.log("[shopify:test-skipped] Send-test notification ignored");
        return send(res, 200, "test-skipped");
      }
      if (SHOPIFY_SECRET) await shopify.verifyIncoming({ rawBody: raw, headers });
      const payload = JSON.parse(raw.toString("utf-8") ?? "{}") as Record<string, unknown>;
      const topic = (headers["x-shopify-topic"] as string) || "orders/create";
      const shop = ((headers["x-shopify-shop-domain"] as string) || SHOP).toLowerCase();
      const cust = (payload["customer"] as Record<string, unknown> | undefined) ?? {};
      const ship = (payload["shipping_address"] as Record<string, unknown> | undefined) ?? {};
      const bill = (payload["billing_address"] as Record<string, unknown> | undefined) ?? {};
      const phone =
        (payload["phone"] as string | undefined) ||
        (cust["phone"] as string | undefined) ||
        (ship["phone"] as string | undefined) ||
        (bill["phone"] as string | undefined) ||
        null;
      const firstName =
        (payload["first_name"] as string | undefined) ||
        (cust["first_name"] as string | undefined) ||
        undefined;
      const lastName = cust["last_name"] as string | undefined;
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
        payload: { id: (payload["id"] as number | string | undefined) ?? 0, phone, first_name: firstName, customer: cust as { phone?: string | null } },
      });
      if (!std) {
        console.log("[shopify:ignored] no phone or topic", topic, "id", String((payload["id"] as number | string | undefined) ?? "?"));
        return send(res, 200, "ignored");
      }
      const http = new TechLadderHttpClient({ apiKey: TL_KEY, baseUrl: TL_BASE });
      const batches = new BatchesResource(http);
      // Dedicated Shopify COD agent (senior-approved). TODO: per-shop agent map after 3-4 use cases.
      const customerName = [firstName, lastName].filter(Boolean).join(" ") || undefined;
      const out = await batches.createIdempotent({
        agent_id: "agt-d24d1800",
        version_name: "Version 2",
        // Pinned: agent's dashboard voice. Omitting it defaults to Kashufa
        // (service DEFAULT_VOICE_NAME), which drops after the greet on dev.
        voice: "Deepika",
        interruption: true,
        use_alternate_number: false,
        start_mode: "immediate",
        schedule_date: "2026-11-14",
        schedule_time: "10:00",
        timezone: "Asia/Kolkata",
        contacts: [
          {
            external_id: std.externalId,
            phone_number: std.contact.phone,
            metadata: {
              Customer_Name: customerName,
              Order_Reference: orderName ?? std.externalId,
              Order_Items: itemsSummary,
              Payment_Method: payment,
              Store_Name: friendlyStoreName(shop),
            },
          },
        ],
        idempotency_key: buildScopedIdempotencyKey(std.source, std.externalAccountId, std.eventType, std.externalId),
      });
      await shops.save({ shopDomain: shop, accessToken: SHOPIFY_TOKEN, installedAt: new Date().toISOString() });
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
      const cfg = { apiSecret: SHOPIFY_SECRET || "test-only", accessToken: SHOPIFY_TOKEN || undefined };
      if (!SHOPIFY_TOKEN) {
        console.log("[write-back:log-only]", JSON.stringify(parsed.data));
        return send(res, 200, "logged");
      }
      await shopify.handleResult(parsed.data, { externalAccountId: parsed.data.externalAccountId, config: cfg });
      return send(res, 200, "tagged");
    }

    if (req.method === "POST" && url.pathname.startsWith("/webhooks/gdpr/")) {
      const raw = await readBody(req);
      const topic = url.pathname.split("/").pop() ?? "";
      const body = JSON.parse(raw.toString("utf-8") ?? "{}") as { shop_domain?: string };
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
