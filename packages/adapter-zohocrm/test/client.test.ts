import { describe, expect, it, vi } from "vitest";
import { createZohoClient, ZohoApiError, ZohoAuthError } from "../src/client.js";

function ok(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data }), { status });
}

describe("zoho client", () => {
  it("sends the token and returns the record", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(ok([{ id: "111", Phone: "+91 90000 00001" }]));
    const c = createZohoClient({ dataCenter: "in", getToken: () => "tok-test", fetchImpl: fetchMock as typeof fetch });
    const rec = await c.getRecord("Leads", "111", ["Phone"]);
    expect(rec["Phone"]).toBe("+91 90000 00001");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://www.zohoapis.in/crm/v6/Leads/111?fields=Phone");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Zoho-oauthtoken tok-test");
  });

  it("updates a record and creates a note with SUCCESS checks", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(ok([{ code: "SUCCESS" }]))
      .mockResolvedValueOnce(ok([{ code: "SUCCESS" }]));
    const c = createZohoClient({ dataCenter: "com.au", getToken: async () => "tok-test", fetchImpl: fetchMock as typeof fetch });
    await c.updateRecord("Deals", "222", { Call_Outcome: "Confirmed" });
    await c.createNote("Deals", "222", { title: "t", content: "c" });
    const [putUrl, putInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(putUrl).toBe("https://www.zohoapis.com.au/crm/v6/Deals/222");
    expect(String(putInit.body)).toContain("Confirmed");
    const [noteUrl, noteInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(noteUrl).toContain("/Notes");
    expect(String(noteInit.body)).toContain("Note_Title");
  });

  it("throws typed errors on API failure codes", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(ok([{ code: "INVALID_DATA", message: "bad field" }]))
      .mockResolvedValueOnce(ok([{ code: "INVALID_DATA", message: "bad field" }]));
    const c = createZohoClient({ dataCenter: "eu", getToken: () => "tok-test", fetchImpl: fetchMock as typeof fetch });
    const err = await c.updateRecord("Leads", "111", { Nope: "x" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ZohoApiError);
    expect(String((err as Error).message)).toContain("bad field");
  });

  it("refreshes once on 401 then retries with the new token", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("{}", { status: 401 }))
      .mockResolvedValueOnce(ok([{ code: "SUCCESS" }]));
    let refreshed = 0;
    const c = createZohoClient({
      dataCenter: "in",
      getToken: () => "tok-old",
      onUnauthorized: () => { refreshed += 1; return Promise.resolve("tok-new"); },
      fetchImpl: fetchMock as typeof fetch,
    });
    await c.updateRecord("Leads", "111", { Call_Outcome: "Confirmed" });
    expect(refreshed).toBe(1);
    const [, secondInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect((secondInit.headers as Record<string, string>)["Authorization"]).toBe("Zoho-oauthtoken tok-new");
  });

  it("throws ZohoAuthError when 401 persists without a refresh hook", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response("{}", { status: 401 }));
    const c = createZohoClient({ dataCenter: "in", getToken: () => "tok-old", fetchImpl: fetchMock as typeof fetch });
    await expect(c.getRecord("Leads", "111")).rejects.toThrow(ZohoAuthError);
  });

  it("retries transient 5xx and surfaces record-not-found", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("err", { status: 500 }))
      .mockResolvedValueOnce(ok([{ id: "111" }]));
    const c = createZohoClient({ dataCenter: "in", getToken: () => "tok-test", fetchImpl: fetchMock as typeof fetch });
    const rec = await c.getRecord("Leads", "111");
    expect(rec["id"]).toBe("111");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const emptyMock = vi.fn().mockResolvedValueOnce(ok([]));
    const c2 = createZohoClient({ dataCenter: "in", getToken: () => "tok-test", fetchImpl: emptyMock as typeof fetch });
    await expect(c2.getRecord("Leads", "nope")).rejects.toThrow("not found");
  });
});
