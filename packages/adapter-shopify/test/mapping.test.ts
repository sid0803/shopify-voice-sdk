import { describe, expect, it } from "vitest";
import { extractName, extractPhone, friendlyStoreName, isTestDelivery, normalizePhone, scheduleSlot, withinCallingHours } from "../app/mapping.js";

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

  it("gates calling hours including overnight windows", () => {
    const noon = new Date("2026-11-16T06:30:00Z").getTime(); // 12:00 IST
    expect(withinCallingHours("09:00", "21:00", "Asia/Kolkata", noon)).toBe(true);
    expect(withinCallingHours("13:00", "21:00", "Asia/Kolkata", noon)).toBe(false);
    expect(withinCallingHours("21:00", "09:00", "Asia/Kolkata", noon)).toBe(false);
    const night = new Date("2026-11-16T18:30:00Z").getTime(); // 00:00 IST
    expect(withinCallingHours("21:00", "09:00", "Asia/Kolkata", night)).toBe(true);
  });

  it("normalizes phones to E.164-ish form", () => {
    expect(normalizePhone("+91 62975 46142")).toBe("+916297546142");
    expect(normalizePhone("(555) 555-5555")).toBe("+5555555555");
    expect(normalizePhone("123")).toBeNull();
    expect(normalizePhone(null)).toBeNull();
  });

  it("emits a fresh slot, never hardcoded", () => {
    const slot = scheduleSlot(new Date("2026-11-14T09:00:00Z").getTime());
    expect(slot.schedule_date).toBe("2026-11-14");
    expect(slot.timezone).toBe("Asia/Kolkata");
    expect(slot.schedule_time).toMatch(/^\d{2}:\d{2}$/);
  });
});
