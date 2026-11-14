import { describe, expect, it, vi, afterEach } from "vitest";
import { TechLadderHttpClient } from "../src/http.js";
import { AccountResource } from "../src/resources/account.js";
import { AuthError } from "../src/errors.js";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

afterEach(() => vi.unstubAllGlobals());

describe("account", () => {
  it("validates a pasted sk_ via GET /me", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      json(200, { status_code: 200, message: "ok", error: null, data: { account_id: "a1", name: "Shop", environment: "staging", features: {}, limits: {} } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const http = new TechLadderHttpClient({ apiKey: "sk_test_x", baseUrl: "https://x.test" });
    const acct = new AccountResource(http);
    expect((await acct.validate("sk_pasted", "https://x.test")).account_id).toBe("a1");
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/me");
  });

  it("rejects a bad key without retry", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(401, { message: "bad" }));
    vi.stubGlobal("fetch", fetchMock);
    const http = new TechLadderHttpClient({ apiKey: "sk_test_x", baseUrl: "https://x.test" });
    await expect(new AccountResource(http).validate("sk_bad", "https://x.test")).rejects.toBeInstanceOf(AuthError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
