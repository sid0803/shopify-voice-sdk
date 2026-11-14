import { describe, expect, it } from "vitest";
import { extractName, extractPhone, friendlyStoreName, isTestDelivery, scheduleSlot } from "../app/mapping.js";

describe("server mapping helpers", () => {
  it("finds nested phones", () => {
    expect(extractPhone({ customer: { phone: "+91111" } })).toBe("+91111");
    expect(extractPhone({ shipping_address: { phone: "+91222" } })).toBe("+91222");
    expect(extractPhone({ billing_address: { phone: "+91333" } })).toBe("+91333");
    expect(extractPhone({ phone: "+91444", customer: { phone: "+91111" } })).toBe("+91444");
    expect(extractPhone({})).toBeNull();
  });

  it("extracts names with customer fallback", () => {
    expect(extractName({ first_name: "A", customer: { first_name: "B", last_name: "C" } })).toMatchObject({ first: "A", last: "C" });
    expect(extractName({})).toMatchObject({ first: undefined, last: undefined });
  });

  it("never returns a raw domain", () => {
    expect(friendlyStoreName("dev-store-1gm9xtph.myshopify.com")).toBe("dev store 1gm9xtph");
    expect(friendlyStoreName("x.myshopify.com", "Acme")).toBe("Acme");
  });

  it("detects Shopify test deliveries", () => {
    expect(isTestDelivery({ "X-Shopify-Test": "true" })).toBe(true);
    expect(isTestDelivery({ "x-shopify-test": "TRUE" })).toBe(true);
    expect(isTestDelivery({})).toBe(false);
  });

  it("emits a fresh slot, never hardcoded", () => {
    const slot = scheduleSlot(new Date("2026-11-14T09:00:00Z").getTime());
    expect(slot.schedule_date).toBe("2026-11-14");
    expect(slot.timezone).toBe("Asia/Kolkata");
    expect(slot.schedule_time).toMatch(/^\d{2}:\d{2}$/);
  });
});
