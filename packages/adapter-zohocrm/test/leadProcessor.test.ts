import { afterEach, describe, expect, it, vi } from "vitest";
import { processZohoLeadJob } from "../src/shell/leadProcessor.js";
import { defaultZohoSettings } from "../src/settings.js";
import { InMemoryZohoLeadLedger } from "../src/stores.js";

const RECORD = { id: "111", First_Name: "Test", Last_Name: "Lead", Phone: "+91 90000 00001", Amount: 5000 };

function settings(over: Record<string, unknown> = {}) {
  return {
    ...defaultZohoSettings("org-1"),
    techladderKeyRef: "sk_test_x",
    agentId: "a",
    versionName: "v",
    voice: "voice-1",
    callingHours: { start: "00:00", end: "23:59", timezone: "UTC" },
    ...over,
  };
}

function deps(over: Record<string, unknown> = {}) {
  return {
    ledger: new InMemoryZohoLeadLedger(),
    fetchRecord: async () => ({ ...RECORD }),
    createCall: async (input: { idempotencyKey: string }) => ({
      batchId: "b1",
      status: "queued",
      idempotencyKey: input.idempotencyKey,
    }),
    ...over,
  };
}

const PAYLOAD = { orgId: "Org-1", module: "Leads", recordId: "111", record: RECORD };

describe("zoho lead processor", () => {
  it("skips cleanly on config, module, hours and data gates", async () => {
    expect(await processZohoLeadJob({ ...settings(), enabled: false }, PAYLOAD, deps())).toBe("skipped:disabled");
    expect(await processZohoLeadJob({ ...settings(), agentId: "" }, PAYLOAD, deps())).toBe("skipped:not-configured");
    expect(await processZohoLeadJob(settings(), { ...PAYLOAD, module: "Deals" }, deps())).toBe("ignored:module-disabled");
    vi.useFakeTimers().setSystemTime(new Date(Date.UTC(2026, 0, 1, 12, 0, 0)));
    try {
      const narrow = settings({ callingHours: { start: "09:00", end: "10:00", timezone: "UTC" } });
      expect(await processZohoLeadJob(narrow, PAYLOAD, deps())).toBe("skipped:outside-hours");
    } finally {
      vi.useRealTimers();
    }
    const noPhone = deps({ fetchRecord: async () => ({ id: "111" }) });
    expect(await processZohoLeadJob(settings(), PAYLOAD, noPhone)).toBe("skipped:no-phone");
  });

  it("fails closed on consent until an explicit grant exists", async () => {
    // No resolver (D5 unanswered) + strict default -> blocked.
    expect(await processZohoLeadJob(settings(), PAYLOAD, deps())).toBe("skipped:consent-unverified");
    // Explicit opt-out or revocation always blocks, even in lax mode.
    const lax = settings({ requireExplicitConsent: false });
    const optedOut = deps({ resolveConsent: () => ({ crmOptOut: true, status: "granted" as const }) });
    expect(await processZohoLeadJob(lax, PAYLOAD, optedOut)).toBe("skipped:crm-opt-out");
    const revoked = deps({ resolveConsent: () => ({ crmOptOut: false, status: "revoked" as const }) });
    expect(await processZohoLeadJob(lax, PAYLOAD, revoked)).toBe("skipped:consent-revoked");
    const dnc = deps({
      resolveConsent: () => ({ crmOptOut: false, status: "granted" as const }),
      fetchRecord: async () => ({ ...RECORD }),
    });
    const dncSettings = settings();
    dncSettings.blockedPhones = ["+91 90000 00001"];
    expect(await processZohoLeadJob(dncSettings, PAYLOAD, dnc)).toBe("skipped:dnc");
  });

  it("queues an eligible lead with a stable idempotency key and ledger row", async () => {
    const granted = deps({ resolveConsent: () => ({ crmOptOut: false, status: "granted" as const }) });
    const ledger = granted.ledger as InMemoryZohoLeadLedger;
    const out = await processZohoLeadJob(settings(), PAYLOAD, granted);
    expect(out).toBe("queued:b1");
    const found = ledger.lookup("b1");
    expect(found).toEqual({ orgId: "org-1", recordId: "111", module: "Leads" });
  });

  it("applies the deal value floor only to Deals", async () => {
    const dealPayload = { ...PAYLOAD, module: "Deals" };
    const dealSettings = settings({ triggerModule: "Deals", minDealValue: 10000 });
    const granted = deps({ resolveConsent: () => ({ crmOptOut: false, status: "granted" as const }) });
    expect(await processZohoLeadJob(dealSettings, dealPayload, granted)).toBe("skipped:below-minimum");
    const cheap = deps({
      resolveConsent: () => ({ crmOptOut: false, status: "granted" as const }),
      fetchRecord: async () => ({ ...RECORD, Amount: 500 }),
    });
    expect(await processZohoLeadJob(dealSettings, dealPayload, cheap)).toBe("skipped:below-minimum");
    const rich = deps({
      resolveConsent: () => ({ crmOptOut: false, status: "granted" as const }),
      fetchRecord: async () => ({ ...RECORD, Amount: 50000 }),
    });
    expect(await processZohoLeadJob(dealSettings, dealPayload, rich)).toBe("queued:b1");
  });

  it("retries transient fetch failures and settles the rest", async () => {
    const down = deps({ fetchRecord: async () => { throw Object.assign(new Error("x"), { status: 503 }); } });
    await expect(processZohoLeadJob(settings(), PAYLOAD, down)).rejects.toThrow();
    const gone = deps({ fetchRecord: async () => { throw Object.assign(new Error("x"), { status: 404 }); } });
    expect(await processZohoLeadJob(settings(), PAYLOAD, gone)).toBe("settled-error:fetch-404");
  });
});

afterEach(() => {
  vi.useRealTimers();
});
