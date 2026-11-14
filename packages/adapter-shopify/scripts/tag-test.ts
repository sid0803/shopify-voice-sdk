// Manual tag write-back check (test store only). Env only, never commit.
// SHOPIFY_SHOP=dev-store-1gm9xtph.myshopify.com SHOPIFY_TOKEN=shpat_... ORDER_ID=19056286826724 npx tsx scripts/tag-test.ts
import { createShopifyAdapter } from "../src/index.js";

const shop = process.env["SHOPIFY_SHOP"] ?? "";
const token = process.env["SHOPIFY_TOKEN"] ?? "";
const orderId = process.env["ORDER_ID"] ?? "";
if (!shop || !token || !orderId) throw new Error("Set SHOPIFY_SHOP, SHOPIFY_TOKEN, ORDER_ID");

const a = createShopifyAdapter({ apiSecret: "test-only", accessToken: token });
await a.handleResult(
  { eventType: "call_completed", outcome: "confirmed", callId: "test-c1", source: "shopify", externalId: orderId, externalAccountId: shop },
  { externalAccountId: shop, config: { apiSecret: "test-only", accessToken: token } },
);
console.log("write-back sent for", orderId, "refresh the order page Tags");
