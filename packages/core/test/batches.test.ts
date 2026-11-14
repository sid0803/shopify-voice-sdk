import { describe, expect, it, vi, afterEach } from "vitest";
import { TechLadderHttpClient } from "../src/http.js";
import { BatchesResource } from "../src/resources/batches.js";
import { buildIdempotencyKey } from "../src/idempotency.js";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

afterEach(() => vi.unstubAllGlobals());

const baseBatch = {
  agent_name: "A",
  version_name: "V1",
  interruption: true,
  use_alternate_number: false,
  start_mode: "immediate" as const,
  schedule_date: "2026-11-14",
  schedule_time: "10:00",
  timezone: "Asia/Kolkata",
  contacts: [{ external_id: "ext-1", phone_number: "9999999999" }],
};

describe("batches + idempotency", () => {
  it("builds neutral keys", () => {
    expect(buildIdempotencyKey("shopify", "order_confirmation", "123")).toBe("shopify:order_confirmation:123");
    expect(buildIdempotencyKey("crm", "lead_callback", "abc")).toBe("crm:lead_callback:abc");
    expect(() => buildIdempotencyKey("", "x", "y")).toThrow();
  });

  it("PUT idempotent create sends body key and allows retry", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(500, { message: "boom" }))
      .mockResolvedValueOnce(
        json(201, { status_code: 201, message: "created", error: null, data: { batch_id: "b1", idempotent: false } }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const http = new TechLadderHttpClient({ apiKey: "sk_test_x", baseUrl: "https://x.test", maxRetries: 1 });
    const batches = new BatchesResource(http);
    const out = await batches.createIdempotent({ ...baseBatch, idempotency_key: "shopify:order_confirmation:123" });
    expect(out.batch_id).toBe("b1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(init.method).toBe("PUT");
  });

  it("POST create without key is attempted once on 500", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(500, { message: "boom" }));
    vi.stubGlobal("fetch", fetchMock);
    const http = new TechLadderHttpClient({ apiKey: "sk_test_x", baseUrl: "https://x.test", maxRetries: 3 });
    const batches = new BatchesResource(http);
    await expect(batches.create({ ...baseBatch })).rejects.toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
