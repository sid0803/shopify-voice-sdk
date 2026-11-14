import { describe, expect, it } from "vitest";
import { CallCompletedEventSchema, InboundEventSchema } from "../src/events/types.js";
import type { PlatformAdapter } from "../src/adapter.js";
import { buildIdempotencyKey } from "../src/idempotency.js";

// Shopify-shaped platform event (adapter #1 shape — stays OUT of core).
interface ShopifyShapedOrder {
  topic: "orders/create";
  shop_domain: string;
  id: number;
  phone: string;
  first_name?: string;
}

// Fake second platform: CRM lead (proves core is not Shopify-bound).
interface CrmLead {
  lead_id: string;
  account: string;
  phone: string;
  name?: string;
}

const shopifyLikeAdapter: PlatformAdapter<ShopifyShapedOrder, { apiKey: string }> = {
  name: "shopify-like",
  async verifyIncoming() {},
  toStandardEvent(e) {
    if (e.topic !== "orders/create" || !e.phone) return null;
    return {
      eventType: "order_confirmation",
      contact: { name: e.first_name, phone: e.phone },
      context: { orderId: e.id },
      source: "shopify",
      externalId: String(e.id),
      externalAccountId: e.shop_domain,
    };
  },
  async handleResult() {},
};

const crmAdapter: PlatformAdapter<CrmLead, { apiKey: string }> = {
  name: "crm-fake",
  async verifyIncoming() {},
  toStandardEvent(e) {
    if (!e.phone) return null;
    return {
      eventType: "lead_callback",
      contact: { name: e.name, phone: e.phone },
      context: { leadId: e.lead_id },
      source: "crm",
      externalId: e.lead_id,
      externalAccountId: e.account,
    };
  },
  async handleResult() {},
};

describe("second-platform test", () => {
  it("same core path works for shopify-shaped and CRM events", () => {
    const shop = shopifyLikeAdapter.toStandardEvent({ topic: "orders/create", shop_domain: "demo.myshopify.com", id: 123, phone: "9999999999" });
    const lead = crmAdapter.toStandardEvent({ lead_id: "abc", account: "acct-1", phone: "8888888888" });
    expect(InboundEventSchema.safeParse(shop).success).toBe(true);
    expect(InboundEventSchema.safeParse(lead).success).toBe(true);
    // No platform words leak into core keys:
    expect(buildIdempotencyKey(shop!.source, shop!.eventType, shop!.externalId)).toBe("shopify:order_confirmation:123");
    expect(buildIdempotencyKey(lead!.source, lead!.eventType, lead!.externalId)).toBe("crm:lead_callback:abc");
  });

  it("ignores uninteresting events with null", () => {
    expect(shopifyLikeAdapter.toStandardEvent({ topic: "orders/create", shop_domain: "x", id: 1, phone: "" })).toBeNull();
  });

  it("validates outbound call_completed", () => {
    const out = {
      eventType: "call_completed", outcome: "confirmed", callId: "c1",
      source: "shopify", externalId: "123", externalAccountId: "demo.myshopify.com",
    };
    expect(CallCompletedEventSchema.safeParse(out).success).toBe(true);
    expect(CallCompletedEventSchema.safeParse({ ...out, outcome: "maybe" }).success).toBe(false);
  });
});
