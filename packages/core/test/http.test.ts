import { describe, expect, it, vi, afterEach } from "vitest";
import { TechLadderHttpClient } from "../src/http.js";
import { AuthError, RateLimitError, ServerError, ValidationError } from "../src/errors.js";

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("http errors", () => {
  it("maps 401 to AuthError with status", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(401, { status_code: 401, message: "Unauthorized", error: { code: "unauthorized", details: [] }, data: null }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new TechLadderHttpClient({ apiKey: "sk_test_x", baseUrl: "https://x.test" });
    await expect(client.request({ path: "/call-batches" })).rejects.toBeInstanceOf(AuthError);
    await expect(client.request({ path: "/call-batches" })).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).toHaveBeenCalledTimes(2); // no retry assertion per-call below; 401 never retried (2 separate calls)
  });

  it("never retries 400 validation errors", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(400, { status_code: 400, message: "Bad", error: { code: "bad", details: ["phone_number"] }, data: null }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new TechLadderHttpClient({ apiKey: "sk_test_x", baseUrl: "https://x.test" });
    await expect(client.request({ path: "/call-batches" })).rejects.toBeInstanceOf(ValidationError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries 500 on idempotent GET then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(500, { message: "boom", error: { code: "s", details: [] } }))
      .mockResolvedValueOnce(jsonResponse(200, { status_code: 200, message: "ok", error: null, data: {} }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new TechLadderHttpClient({ apiKey: "sk_test_x", baseUrl: "https://x.test", maxRetries: 2 });
    await client.request({ path: "/call-batches" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry POST without idempotency key", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(500, { message: "boom" }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new TechLadderHttpClient({ apiKey: "sk_test_x", baseUrl: "https://x.test", maxRetries: 3 });
    await expect(
      client.request({ method: "POST", path: "/call-batches", body: {} }),
    ).rejects.toBeInstanceOf(ServerError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries POST with idempotency key on 503", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(503, { message: "down" }))
      .mockResolvedValueOnce(jsonResponse(201, { status_code: 201, message: "created", error: null, data: {} }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new TechLadderHttpClient({ apiKey: "sk_test_x", baseUrl: "https://x.test", maxRetries: 2 });
    await client.request({ method: "POST", path: "/call-batches", body: {}, idempotencyKey: "shopify:order:123" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("maps 429 to RateLimitError and respects retry then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, { message: "slow" }, { "retry-after": "0" }))
      .mockResolvedValueOnce(jsonResponse(200, { status_code: 200, message: "ok", error: null, data: {} }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new TechLadderHttpClient({ apiKey: "sk_test_x", baseUrl: "https://x.test", maxRetries: 1 });
    await client.request({ path: "/call-batches" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up after maxRetries on 429 and throws RateLimitError", { timeout: 15000 }, async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(429, { message: "slow" }, { "retry-after": "1" }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new TechLadderHttpClient({ apiKey: "sk_test_x", baseUrl: "https://x.test", maxRetries: 1 });
    const err = await client.request({ path: "/call-batches" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(fetchMock).toHaveBeenCalledTimes(2); // initial + 1 retry
  });

  it("times out every request (AbortError surfaces as ServerError, retried on GET)", async () => {
    const fetchMock = vi.fn().mockImplementation(() => {
      const e = new Error("The operation was aborted");
      e.name = "AbortError";
      return Promise.reject(e);
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new TechLadderHttpClient({
      apiKey: "sk_test_x", baseUrl: "https://x.test", timeoutMs: 20, maxRetries: 1,
    });
    await expect(client.request({ path: "/call-batches" })).rejects.toBeInstanceOf(ServerError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
