import { describe, expect, it, vi } from "vitest";
import { createWebhookAdapter } from "../src/index.js";

describe("webhook adapter", () => {
  it("maps a generic event to InboundEvent", () => {
    const a = createWebhookAdapter({});
    const out = a.toStandardEvent({ phone: "9999999999", externalId: "ext-1", externalAccountId: "acct-1" });
    expect(out?.eventType).toBe("lead_callback");
    expect(out?.source).toBe("webhook");
  });

  it("ignores events missing phone/external keys", () => {
    const a = createWebhookAdapter({});
    expect(a.toStandardEvent({ phone: "", externalId: "x", externalAccountId: "y" })).toBeNull();
  });

  it("rejects wrong shared secret", async () => {
    const a = createWebhookAdapter({ sharedSecret: "s3cr3t" });
    await expect(a.verifyIncoming({ rawBody: "{}", headers: { "x-webhook-secret": "nope" } })).rejects.toThrow();
    await a.verifyIncoming({ rawBody: "{}", headers: { "x-webhook-secret": "s3cr3t" } });
  });

  it("POSTs result to callbackUrl", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const a = createWebhookAdapter({ callbackUrl: "https://example.test/hook", fetchImpl: fetchMock as typeof fetch });
    await a.handleResult(
      { eventType: "call_completed", outcome: "confirmed", callId: "c1", source: "webhook", externalId: "ext-1", externalAccountId: "acct-1" },
      { externalAccountId: "acct-1", config: {} },
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
