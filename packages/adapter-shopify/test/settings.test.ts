import { describe, expect, it } from "vitest";
import { defaultSettings, InMemorySettingsStore, ShopSettingsSchema } from "../src/settings.js";

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
});
