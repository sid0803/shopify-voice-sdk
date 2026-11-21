import { describe, expect, it, vi } from "vitest";
import {
  buildAuthorizeUrl,
  ensureFreshToken,
  exchangeCodeForTokens,
  expiresAtMs,
  expiresSoon,
  InMemoryZohoTokenStore,
  refreshAccessToken,
  ZohoOAuthError,
} from "../src/oauth.js";

const FETCH = (impl: (url: string, init: RequestInit) => unknown) => impl as unknown as typeof fetch;

describe("zoho oauth", () => {
  it("builds a connect URL with offline access and state", () => {
    const url = buildAuthorizeUrl({
      clientId: "cid-test",
      redirectUri: "https://app.test/zoho/callback",
      dataCenter: "in",
      state: "state-test",
    });
    expect(url).toContain("https://accounts.zoho.in/oauth/v2/auth?");
    expect(url).toContain("response_type=code");
    expect(url).toContain("access_type=offline");
    expect(url).toContain("prompt=consent");
    expect(url).toContain("state=state-test");
  });

  it("rejects unknown data centers instead of guessing", () => {
    expect(() =>
      buildAuthorizeUrl({ clientId: "c", redirectUri: "https://app.test/cb", dataCenter: "xx", state: "s" }),
    ).toThrow("Unknown Zoho data center");
  });

  it("exchanges a code for a token pair with computed expiry", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({ access_token: "at-test", refresh_token: "rt-test", expires_in: 3600, api_domain: "https://www.zohoapis.in" }),
        { status: 200 },
      ),
    );
    const tokens = await exchangeCodeForTokens({
      fetchImpl: FETCH((u, i) => fetchMock(u, i)),
      dataCenter: "in",
      clientId: "cid-test",
      clientSecret: "csec-test",
      redirectUri: "https://app.test/zoho/callback",
      code: "code-test",
      nowMs: 1_000_000,
    });
    expect(tokens.accessToken).toBe("at-test");
    expect(tokens.refreshToken).toBe("rt-test");
    expect(tokens.expiresAtMs).toBe(1_000_000 + 3_600_000);
    expect(tokens.apiDomain).toBe("https://www.zohoapis.in");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://accounts.zoho.in/oauth/v2/token");
    expect(String(init.body)).toContain("grant_type=authorization_code");
    expect(String(init.body)).toContain("code=code-test");
  });

  it("throws a typed error on grant failure without leaking the secret", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "invalid_code" }), { status: 400 }),
    );
    await expect(
      exchangeCodeForTokens({
        fetchImpl: FETCH((u, i) => fetchMock(u, i)),
        dataCenter: "com",
        clientId: "cid-test",
        clientSecret: "csec-test",
        redirectUri: "https://app.test/zoho/callback",
        code: "bad-test",
      }),
    ).rejects.toThrow(ZohoOAuthError);
  });

  it("refresh keeps the old refresh token when Zoho omits a new one", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: "at-test-2", expires_in: 3600 }), { status: 200 }),
    );
    const out = await refreshAccessToken({
      fetchImpl: FETCH((u, i) => fetchMock(u, i)),
      dataCenter: "eu",
      clientId: "cid-test",
      clientSecret: "csec-test",
      refreshToken: "rt-test-old",
    });
    expect(out.accessToken).toBe("at-test-2");
    expect(out.refreshToken).toBe("rt-test-old");
  });

  it("expiresAtMs treats seconds as seconds and tolerates ms", () => {
    expect(expiresAtMs(3600, 0)).toBe(3_600_000);
    expect(expiresAtMs(3_600_000, 0)).toBe(3_600_000);
    expect(expiresSoon({ expiresAtMs: 61_000 }, 0)).toBe(false);
    expect(expiresSoon({ expiresAtMs: 59_000 }, 0)).toBe(true);
  });

  it("ensureFreshToken returns cached tokens and refreshes only when stale", async () => {
    const store = new InMemoryZohoTokenStore();
    await store.save({ orgId: "Org-1", accessToken: "at-fresh", refreshToken: "rt-1", expiresAtMs: Date.now() + 3_600_000, dataCenter: "in" });
    const same = await ensureFreshToken({ store, orgId: "org-1", dataCenter: "in", clientId: "c", clientSecret: "s" });
    expect(same).toBe("at-fresh");

    await store.save({ orgId: "org-1", accessToken: "at-old", refreshToken: "rt-1", expiresAtMs: 1000, dataCenter: "in" });
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: "at-new", expires_in: 3600 }), { status: 200 }),
    );
    const fresh = await ensureFreshToken({
      store,
      orgId: "ORG-1",
      dataCenter: "in",
      clientId: "c",
      clientSecret: "s",
      fetchImpl: FETCH((u, i) => fetchMock(u, i)),
      nowMs: 2_000,
    });
    expect(fresh).toBe("at-new");
    expect((await store.get("org-1"))?.refreshToken).toBe("rt-1");
  });

  it("tokens are isolated per org and missing orgs fail as not-connected", async () => {
    const store = new InMemoryZohoTokenStore();
    await store.save({ orgId: "a", accessToken: "at-a", refreshToken: "rt-a", expiresAtMs: Date.now() + 3_600_000, dataCenter: "com" });
    await store.save({ orgId: "b", accessToken: "at-b", refreshToken: "rt-b", expiresAtMs: Date.now() + 3_600_000, dataCenter: "com" });
    expect(await store.get("a")).toMatchObject({ accessToken: "at-a" });
    await expect(
      ensureFreshToken({ store, orgId: "ghost", dataCenter: "com", clientId: "c", clientSecret: "s" }),
    ).rejects.toThrow("not_connected");
  });
});
