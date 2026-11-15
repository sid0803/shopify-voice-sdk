import { describe, expect, it } from "vitest";
import { InMemoryShopStore } from "../src/shopStore.js";
import { InMemoryEventClaim } from "../src/stores.js";
import { handleGdprWebhook } from "../src/gdpr.js";

describe("shop store + gdpr", () => {
  it("saves and removes per-shop tokens (lowercased domain)", async () => {
    const store = new InMemoryShopStore();
    await store.save({ shopDomain: "Demo.myshopify.com", accessToken: "tok", installedAt: new Date().toISOString() });
    expect((await store.get("demo.myshopify.com"))?.accessToken).toBe("tok");
    expect(await handleGdprWebhook("shop/redact", "demo.myshopify.com", store)).toMatchObject({ status: 200 });
    expect(await store.get("demo.myshopify.com")).toBeNull();
  });

  it("data_request does not delete", async () => {
    const store = new InMemoryShopStore();
    await store.save({ shopDomain: "x.myshopify.com", accessToken: "t", installedAt: "2026-01-01T00:00:00Z" });
    await handleGdprWebhook("customers/data_request", "x.myshopify.com", store);
    expect(await store.get("x.myshopify.com")).not.toBeNull();
  });

  it("releases claims so redeliveries reprocess", async () => {
    const claims = new InMemoryEventClaim();
    expect(await claims.claim("evt_1")).toBe(true);
    expect(await claims.claim("evt_1")).toBe(false);
    await claims.release("evt_1");
    expect(await claims.claim("evt_1")).toBe(true);
  });
});
