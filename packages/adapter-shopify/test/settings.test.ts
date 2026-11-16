import { describe, expect, it } from "vitest";
import {
  defaultSettings,
  InMemorySettingsStore,
  isValidTimeZone,
  ShopSettingsSchema,
} from "../src/settings.js";

describe("settings", () => {
  it("validates shop settings", () => {
    expect(() => ShopSettingsSchema.parse({ externalAccountId: "", agentId: "a" })).toThrow();
    const s = defaultSettings("Demo.myshopify.com");
    expect(s.codOnly).toBe(false);
    expect(s.tagsEnabled).toBe(true);
  });

  it("stores per shop", () => {
    const store = new InMemorySettingsStore();
    expect(store.get("x.myshopify.com")).toBeNull();
    store.save({ ...defaultSettings("x.myshopify.com"), codOnly: true });
    expect(store.get("X.MYSHOPIFY.COM")?.codOnly).toBe(true);
  });

  it("removes a shop's settings on shop/redact", () => {
    const store = new InMemorySettingsStore();
    store.save(defaultSettings("x.myshopify.com"));
    store.remove("X.MYSHOPIFY.COM");
    expect(store.get("x.myshopify.com")).toBeNull();
  });

  it("rejects an invalid IANA timezone before the worker sees it", () => {
    expect(isValidTimeZone("Asia/Kolkata")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus_Mons")).toBe(false);
    expect(() =>
      ShopSettingsSchema.parse({
        externalAccountId: "x.myshopify.com",
        callingHours: { start: "09:00", end: "21:00", timezone: "Mars/Olympus_Mons" },
      }),
    ).toThrow(/Invalid IANA timezone/);
  });
});
