import { describe, expect, it, vi, afterEach } from "vitest";
import { TechLadderHttpClient } from "../src/http.js";
import { UsageResource } from "../src/resources/usage.js";
import { CallsResource } from "../src/resources/calls.js";
import { BatchesResource } from "../src/resources/batches.js";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

afterEach(() => vi.unstubAllGlobals());

describe("usage resource (B3)", () => {
  it("returns explicit tier shape and rejects empty account_id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      json(200, {
        status_code: 200,
        message: "ok",
        error: null,
        data: {
          account_id: "client_123",
          usage: { free_credit: { limit: 100, consumption: 30, remaining: 70, status: "active" } },
          computed_at: "2026-11-17T00:00:00Z",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const http = new TechLadderHttpClient({ apiKey: "sk_test_x", baseUrl: "https://x.test" });
    const out = await new UsageResource(http).get();
    expect(out.account_id).toBe("client_123");
    expect(out.usage.free_credit?.consumption).toBe(30);
  });

  it("throws on missing account_id (BUG-007 guard)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      json(200, { status_code: 200, message: "ok", error: null, data: { account_id: "", usage: {}, computed_at: "x" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const http = new TechLadderHttpClient({ apiKey: "sk_test_x", baseUrl: "https://x.test" });
    await expect(new UsageResource(http).get()).rejects.toThrow(/account_id/);
  });
});

describe("idempotency guards (BUG-013)", () => {
  it("rejects whitespace-only key on POST /calls", async () => {
    const http = new TechLadderHttpClient({ apiKey: "sk_test_x", baseUrl: "https://x.test" });
    await expect(new CallsResource(http).create({ idempotency_key: " " })).rejects.toThrow(/blank/);
  });

  it("rejects whitespace-only key on PUT /call-batches", async () => {
    const http = new TechLadderHttpClient({ apiKey: "sk_test_x", baseUrl: "https://x.test" });
    const batches = new BatchesResource(http);
    await expect(
      batches.createIdempotent({
        interruption: true,
        use_alternate_number: false,
        start_mode: "immediate",
        schedule_date: "2026-11-17",
        schedule_time: "10:00",
        timezone: "UTC",
        contacts: [],
        idempotency_key: "   ",
      }),
    ).rejects.toThrow(/blank/);
  });

  it("accepts null call_id (BUG-011: batch_id is the handle)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      json(202, {
        status_code: 202,
        message: "queued",
        error: null,
        data: { call_id: null, batch_id: "b_123", status: "queued", idempotent: false },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const http = new TechLadderHttpClient({ apiKey: "sk_test_x", baseUrl: "https://x.test" });
    const out = await new CallsResource(http).create({ agent_id: "a", phone_number: "+10000000000" });
    expect(out.call_id).toBeNull();
    expect(out.batch_id).toBe("b_123");
  });
});
