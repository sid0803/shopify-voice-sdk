import { describe, expect, it, vi } from "vitest";
import { performWriteback, resolveResultLabel } from "../src/writeback.js";

function ok(): Response {
  return new Response(JSON.stringify({ data: [{ code: "SUCCESS" }] }), { status: 200 });
}

describe("zoho writeback", () => {
  it("resolves labels with merchant overrides", () => {
    const base = { eventType: "call_completed" as const, outcome: "confirmed" as const, callId: "c", source: "z", externalId: "1", externalAccountId: "o" };
    expect(resolveResultLabel(base)).toBe("Confirmed");
    expect(resolveResultLabel(base, { Confirmed: "Done" })).toBe("Done");
    expect(resolveResultLabel({ ...base, outcome: "cancelled", callStatus: "no_answer" })).toBe("No Answer");
  });

  it("writes field then note with summary and batch context", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(ok()).mockResolvedValueOnce(ok());
    const out = await performWriteback(
      { dataCenter: "in", getToken: () => "tok-test", fetchImpl: fetchMock as typeof fetch, module: "Leads" },
      {
        eventType: "call_completed",
        outcome: "confirmed",
        callId: "c9",
        batchId: "b9",
        summary: "Customer confirmed the order",
        source: "zohocrm",
        externalId: "111",
        externalAccountId: "org-1",
      },
    );
    expect(out).toEqual({ label: "Confirmed" });
    const [, putInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(putInit.body)).toContain('"Call_Outcome":"Confirmed"');
    const [, noteInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    const body = String(noteInit.body);
    expect(body).toContain("TechLadder call — Confirmed");
    expect(body).toContain("Call: c9");
    expect(body).toContain("Batch: b9");
    expect(body).toContain("Customer confirmed the order");
  });

  it("a partial write throws instead of recording half an outcome", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ code: "INTERNAL_ERROR", message: "down" }] }), { status: 200 }));
    await expect(
      performWriteback(
        { dataCenter: "in", getToken: () => "tok-test", fetchImpl: fetchMock as typeof fetch, module: "Leads" },
        { eventType: "call_completed", outcome: "confirmed", callId: "c", source: "zohocrm", externalId: "111", externalAccountId: "org-1" },
      ),
    ).rejects.toThrow("down");
  });
});
