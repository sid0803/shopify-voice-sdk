import { describe, expect, it, vi } from "vitest";
import {
  createZohoAdapter,
  executionStatusToLabel,
  moduleToEventType,
  outcomeToLabel,
} from "../src/index.js";

const SECRET = "zoho_test_token";

describe("zoho adapter", () => {
  it("maps Leads/Contacts with phone, ignores records without phone or module", () => {
    const a = createZohoAdapter({ webhookSecret: SECRET, dataCenter: "in" });
    const ok = a.toStandardEvent({
      module: "Leads",
      orgId: "org-1",
      record: { id: "111", First_Name: "Test", Last_Name: "Lead", Phone: "+91 90000 00001" },
    });
    expect(ok?.eventType).toBe("lead_callback");
    expect(ok?.source).toBe("zohocrm");
    expect(ok?.externalId).toBe("111");
    expect(ok?.externalAccountId).toBe("org-1");
    const deal = a.toStandardEvent({
      module: "Deals",
      orgId: "org-1",
      record: { id: "222", Mobile: "+91 90000 00002" },
    });
    expect(deal?.eventType).toBe("deal_callback");
    expect(
      a.toStandardEvent({ module: "Leads", orgId: "org-1", record: { id: "333" } }),
    ).toBeNull();
    expect(moduleToEventType("Invoices")).toBeNull();
  });

  it("verifies the shared webhook token, fails closed", async () => {
    const a = createZohoAdapter({ webhookSecret: SECRET, dataCenter: "in" });
    await a.verifyIncoming({ rawBody: "{}", headers: { "X-Zoho-Webhook-Token": SECRET } });
    await expect(
      a.verifyIncoming({ rawBody: "{}", headers: { "x-zoho-webhook-token": "bad" } }),
    ).rejects.toThrow();
    const noSecret = createZohoAdapter({ webhookSecret: "", dataCenter: "in" });
    await expect(noSecret.verifyIncoming({ rawBody: "{}", headers: {} })).rejects.toThrow();
  });

  it("writes outcome field then Note via Zoho CRM API", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ code: "SUCCESS" }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ code: "SUCCESS" }] }), { status: 200 }));
    const a = createZohoAdapter({ webhookSecret: SECRET, dataCenter: "in", accessToken: "tok", module: "Leads", fetchImpl: fetchMock as typeof fetch });
    await a.handleResult(
      { eventType: "call_completed", outcome: "confirmed", callId: "c1", source: "zohocrm", externalId: "111", externalAccountId: "org-1" },
      { externalAccountId: "org-1", config: { webhookSecret: SECRET, dataCenter: "in" } },
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [putUrl, putInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(putUrl).toContain("zohoapis.in/crm/v6/Leads/111");
    expect(String(putInit.body)).toContain("Confirmed");
    expect((putInit.headers as Record<string, string>)["Authorization"]).toBe("Zoho-oauthtoken tok");
    const [noteUrl, noteInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(noteUrl).toContain("/Notes");
    expect(String(noteInit.body)).toContain("TechLadder call");
    expect(outcomeToLabel("cancelled")).toBe("Cancelled");
    expect(outcomeToLabel("wrong_number")).toBe("Wrong Number");
    expect(executionStatusToLabel("no_answer")).toBe("No Answer");
    expect(executionStatusToLabel("failed")).toBe("Failed");
  });

  it("retries transient 5xx on write-back", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("err", { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ code: "SUCCESS" }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ code: "SUCCESS" }] }), { status: 200 }));
    const a = createZohoAdapter({ webhookSecret: SECRET, dataCenter: "com", accessToken: "tok", module: "Deals", fetchImpl: fetchMock as typeof fetch });
    await a.handleResult(
      { eventType: "call_completed", outcome: "cancelled", callId: "c2", source: "zohocrm", externalId: "222", externalAccountId: "org-1" },
      { externalAccountId: "org-1", config: { webhookSecret: SECRET, dataCenter: "com" } },
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0][0]).toContain("zohoapis.com/crm/v6/Deals/222");
  });

  it("throws on Zoho API error codes and missing token", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ code: "INVALID_DATA", message: "denied" }] }), { status: 200 }));
    const a = createZohoAdapter({ webhookSecret: SECRET, dataCenter: "eu", accessToken: "tok", module: "Leads", fetchImpl: fetchMock as typeof fetch });
    await expect(a.handleResult(
      { eventType: "call_completed", outcome: "confirmed", callId: "c3", source: "zohocrm", externalId: "111", externalAccountId: "org-1" },
      { externalAccountId: "org-1", config: { webhookSecret: SECRET, dataCenter: "eu" } },
    )).rejects.toThrow("denied");
    const noToken = createZohoAdapter({ webhookSecret: SECRET, dataCenter: "eu", module: "Leads" });
    await expect(noToken.handleResult(
      { eventType: "call_completed", outcome: "confirmed", callId: "c4", source: "zohocrm", externalId: "111", externalAccountId: "org-1" },
      { externalAccountId: "org-1", config: { webhookSecret: SECRET, dataCenter: "eu" } },
    )).rejects.toThrow("access token");
  });
});
