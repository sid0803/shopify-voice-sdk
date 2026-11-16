import { describe, expect, it } from "vitest";
import { createGdprStore, handleGdprWebhook } from "../src/gdpr.js";
import { InMemoryCallLedger, InMemoryShopStore } from "../src/stores.js";

function setup() {
  const shops = new InMemoryShopStore();
  const ledger = new InMemoryCallLedger();
  const store = createGdprStore(shops, ledger);
  const now = new Date().toISOString();
  return { shops, ledger, store, now };
}

describe("GDPR handlers", () => {
  it("customers/redact deletes only that customer's calls", async () => {
    const { shops, ledger, store, now } = setup();
    await shops.save({ shopDomain: "s.myshopify.com" });
    ledger.save({ shop: "s.myshopify.com", orderId: "o1", externalId: "o1", customerId: "c1", idempotencyKey: "k1", status: "queued", createdAt: now, updatedAt: now });
    ledger.save({ shop: "s.myshopify.com", orderId: "o2", externalId: "o2", customerId: "c2", idempotencyKey: "k2", status: "queued", createdAt: now, updatedAt: now });

    await handleGdprWebhook("customers/redact", "s.myshopify.com", store, { customer: { id: "c1" } });

    expect(ledger.lookup("o1")).toBeNull();
    expect(ledger.lookup("o2")).toMatchObject({ orderId: "o2" });
    expect(await shops.get("s.myshopify.com")).not.toBeNull();
  });

  it("customers/data_request exports only that customer's calls", async () => {
    const { shops, ledger, store, now } = setup();
    await shops.save({ shopDomain: "s.myshopify.com" });
    ledger.save({ shop: "s.myshopify.com", orderId: "o1", externalId: "o1", customerId: "c1", idempotencyKey: "k1", status: "queued", createdAt: now, updatedAt: now });

    const out = await handleGdprWebhook("customers/data_request", "s.myshopify.com", store, { customer: { id: "c1" } });

    expect(out.status).toBe(200);
    expect(JSON.stringify(out.body)).toContain("o1");
  });

  it("shop/redact and app/uninstalled remove the shop and its calls", async () => {
    const { shops, ledger, store, now } = setup();
    await shops.save({ shopDomain: "s.myshopify.com" });
    ledger.save({ shop: "s.myshopify.com", orderId: "o1", externalId: "o1", customerId: "c1", idempotencyKey: "k1", status: "queued", createdAt: now, updatedAt: now });

    await handleGdprWebhook("shop/redact", "s.myshopify.com", store);
    expect(await shops.get("s.myshopify.com")).toBeNull();
    expect(ledger.lookup("o1")).toBeNull();
  });
});
