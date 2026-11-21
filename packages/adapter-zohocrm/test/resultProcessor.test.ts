import { describe, expect, it, vi } from "vitest";
import { processZohoResultJob } from "../src/shell/resultProcessor.js";
import { defaultZohoSettings } from "../src/settings.js";
import { InMemoryZohoConnectionStore, InMemoryZohoLeadLedger } from "../src/stores.js";
import { InMemoryZohoTokenStore } from "../src/oauth.js";

const RESULT = {
  eventType: "call_completed" as const,
  outcome: "confirmed" as const,
  callId: "c1",
  batchId: "b1",
  source: "zohocrm",
  externalId: "111",
  externalAccountId: "org-1",
};

function success(): Response {
  return new Response(JSON.stringify({ data: [{ code: "SUCCESS" }] }), { status: 200 });
}

function settings(over: Record<string, unknown> = {}) {
  return {
    ...defaultZohoSettings("org-1"),
    techladderKeyRef: "sk_test_x",
    agentId: "a",
    versionName: "v",
    voice: "voice-1",
    ...over,
  };
}

async function wired(fetchImpl?: typeof fetch) {
  const ledger = new InMemoryZohoLeadLedger();
  await ledger.save({
    orgId: "org-1", module: "Leads", recordId: "111", externalId: "111",
    callId: "c1", batchId: "b1", idempotencyKey: "k", status: "queued",
    createdAt: "t", updatedAt: "t",
  });
  const connections = new InMemoryZohoConnectionStore();
  await connections.save({
    orgId: "org-1", dataCenter: "in", accessTokenEnc: "", refreshTokenEnc: "",
    fieldMap: {}, status: "connected", createdAt: "t", updatedAt: "t",
  });
  const tokenStore = new InMemoryZohoTokenStore();
  await tokenStore.save({
    orgId: "org-1", accessToken: "at-test", refreshToken: "rt-test",
    expiresAtMs: Date.now() + 3_600_000, dataCenter: "in",
  });
  return {
    ledger,
    connections,
    tokenStore,
    getSettings: async () => settings(),
    clientId: "cid-test",
    clientSecret: "csec-test",
    ...(fetchImpl ? { fetchImpl } : {}),
  };
}

describe("zoho result processor", () => {
  it("ignores results with no ledger identity", async () => {
    const d = await wired();
    const out = await processZohoResultJob(
      { orgId: "org-1", result: { ...RESULT, callId: "ghost", externalId: "ghost", batchId: undefined } },
      d,
    );
    expect(out).toBe("ignored:no-ledger-match");
  });

  it("records the outcome without write-back when notes are disabled", async () => {
    const d = await wired();
    d.getSettings = async () => settings({ notesEnabled: false });
    const out = await processZohoResultJob({ orgId: "org-1", result: RESULT }, d);
    expect(out).toBe("result:confirmed:notes-disabled");
    expect((await d.ledger.list("org-1"))[0]?.status).toBe("result");
  });

  it("writes the Note and field, then marks the ledger row noted", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(success()).mockResolvedValueOnce(success());
    const d = await wired(fetchMock as typeof fetch);
    const out = await processZohoResultJob({ orgId: "org-1", result: RESULT }, d);
    expect(out).toBe("noted:confirmed");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [putUrl, putInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(putUrl).toContain("zohoapis.in/crm/v6/Leads/111");
    expect(String(putInit.body)).toContain('"Call_Outcome":"Confirmed"');
    const row = (await d.ledger.list("org-1"))[0];
    expect(row?.status).toBe("noted");
    expect(row?.labelApplied).toBe("Confirmed");
  });

  it("settles write-back 4xx instead of retrying forever", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ code: "INVALID_DATA", message: "bad field" }] }), { status: 400 }),
    );
    const d = await wired(fetchMock as typeof fetch);
    const out = await processZohoResultJob({ orgId: "org-1", result: RESULT }, d);
    expect(out).toContain("settled-error");
    expect((await d.ledger.list("org-1"))[0]?.status).toBe("result");
  });

  it("throws on transient 5xx so the queue retries", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValue(new Response("err", { status: 500 }));
    const d = await wired(fetchMock as typeof fetch);
    await expect(processZohoResultJob({ orgId: "org-1", result: RESULT }, d)).rejects.toThrow();
  });

  it("settles when the org is not connected", async () => {
    const d = await wired();
    await d.connections.remove?.("org-1");
    const out = await processZohoResultJob({ orgId: "org-1", result: RESULT }, d);
    expect(out).toBe("settled-error:not-connected");
  });
});
