import { describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { createShopifyAdapter, outcomeToTag, topicToEventType } from "../src/index.js";

const SECRET = "shpss_test";

function hmac(body: string): string {
  return createHmac("sha256", SECRET).update(body).digest("base64");
}

describe("shopify adapter scaffold", () => {
  it("maps orders/create with phone, ignores topics without phone", () => {
    const a = createShopifyAdapter({ apiSecret: SECRET });
    const ok = a.toStandardEvent({ topic: "orders/create", shopDomain: "demo.myshopify.com", payload: { id: 123, phone: "9999999999", first_name: "Asha" } });
    expect(ok?.eventType).toBe("order_confirmation");
    expect(ok?.externalAccountId).toBe("demo.myshopify.com");
    expect(a.toStandardEvent({ topic: "orders/create", shopDomain: "demo.myshopify.com", payload: { id: 124 } })).toBeNull();
    expect(topicToEventType("app/uninstalled")).toBeNull();
  });

  it("verifies Shopify HMAC (base64)", async () => {
    const a = createShopifyAdapter({ apiSecret: SECRET });
    const raw = JSON.stringify({ id: 123 });
    await a.verifyIncoming({ rawBody: raw, headers: { "X-Shopify-Hmac-Sha256": hmac(raw) } });
    await expect(a.verifyIncoming({ rawBody: raw, headers: { "x-shopify-hmac-sha256": "bad" } })).rejects.toThrow();
  });

  it("writes outcome tag back to the order (merge-safe: GET then PUT)", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ order: { id: 123, tags: "vip" } }), { status: 200 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const a = createShopifyAdapter({ apiSecret: SECRET, accessToken: "tok", fetchImpl: fetchMock as typeof fetch });
    await a.handleResult(
      { eventType: "call_completed", outcome: "confirmed", callId: "c1", source: "shopify", externalId: "123", externalAccountId: "demo.myshopify.com" },
      { externalAccountId: "demo.myshopify.com", config: { apiSecret: SECRET } },
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, putInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(String(putInit.body)).toContain("call-confirmed");
    expect(String(putInit.body)).toContain("vip");
    expect(outcomeToTag("no_answer")).toBe("call-no-answer");
  });
});
