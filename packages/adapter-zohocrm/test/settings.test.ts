import { describe, expect, it } from "vitest";
import {
  ZohoSettingsSchema,
  defaultZohoSettings,
  isZohoSettingsConfigured,
  withZohoEnvFallbacks,
} from "../src/settings.js";

describe("zoho settings", () => {
  it("defaults to blank, Leads/created, notes on", () => {
    const s = defaultZohoSettings("org-1");
    expect(s.agentId).toBe("");
    expect(s.triggerModule).toBe("Leads");
    expect(s.triggerEvent).toBe("created");
    expect(s.notesEnabled).toBe(true);
    expect(s.outcomeField).toBe("Call_Outcome");
    expect(s.enabled).toBe(true);
    expect(isZohoSettingsConfigured(s)).toBe(false);
  });

  it("rejects typo'd timezones and unknown modules at save time", () => {
    expect(() =>
      ZohoSettingsSchema.parse({ externalAccountId: "o", callingHours: { start: "09:00", end: "21:00", timezone: "Mars/Olympus" } }),
    ).toThrow("Invalid IANA timezone");
    expect(() =>
      ZohoSettingsSchema.parse({ externalAccountId: "o", triggerModule: "Invoices" }),
    ).toThrow();
  });

  it("configured only when key + agent + version + voice are present", () => {
    const base = defaultZohoSettings("org-1");
    const full = withZohoEnvFallbacks({
      ...base,
      techladderKeyRef: "sk_test_x",
      agentId: "a",
      versionName: "v",
      voice: "voice-1",
    });
    expect(isZohoSettingsConfigured(full)).toBe(true);
    expect(isZohoSettingsConfigured({ ...full, enabled: false })).toBe(false);
  });
});
