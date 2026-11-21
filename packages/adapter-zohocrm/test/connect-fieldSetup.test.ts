import { describe, expect, it, vi } from "vitest";
import {
  beginZohoConnect,
  completeZohoConnect,
  disconnectZohoOrg,
  zohoConnectionStatus,
} from "../src/shell/connect.js";
import { syncZohoFieldMap } from "../src/shell/fieldSetup.js";
import { InMemoryZohoConnectionStore } from "../src/stores.js";

const FETCH = (impl: (url: string, init: RequestInit) => unknown) => impl as unknown as typeof fetch;

function tokenResponse() {
  return new Response(
    JSON.stringify({ access_token: "at-test", refresh_token: "rt-test", expires_in: 3600 }),
    { status: 200 },
  );
}

describe("zoho connect flow", () => {
  it("builds a connect challenge with a state to remember", () => {
    const out = beginZohoConnect({
      clientId: "cid-test",
      redirectUri: "https://app.test/zoho/callback",
      dataCenter: "in",
    });
    expect(out.url).toContain("accounts.zoho.in/oauth/v2/auth?");
    expect(out.state).toMatch(/^[0-9a-f]{32}$/);
    expect(beginZohoConnect({
      clientId: "c", redirectUri: "https://app.test/cb", dataCenter: "com", state: "fixed",
    }).state).toBe("fixed");
  });

  it("completes the callback by exchanging and persisting the pair", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(tokenResponse());
    const store = new InMemoryZohoConnectionStore();
    const out = await completeZohoConnect({
      store,
      orgId: "Org-1",
      code: "code-test",
      clientId: "cid-test",
      clientSecret: "csec-test",
      redirectUri: "https://app.test/zoho/callback",
      dataCenter: "in",
      fetchImpl: FETCH((u, i) => fetchMock(u, i)),
      nowMs: 1_000_000,
    });
    expect(out).toEqual({ orgId: "org-1", dataCenter: "in" });
    expect(await zohoConnectionStatus(store, "org-1")).toBe("connected");
    const rec = await store.get("org-1");
    expect(rec?.accessTokenEnc).toBe("at-test");
    expect(rec?.fieldMap).toEqual({});
  });

  it("disconnect removes the row and unknown orgs read not-connected", async () => {
    const store = new InMemoryZohoConnectionStore();
    await store.save({
      orgId: "o", dataCenter: "in", accessTokenEnc: "a", refreshTokenEnc: "r",
      fieldMap: {}, status: "connected", createdAt: "t", updatedAt: "t",
    });
    await disconnectZohoOrg(store, "o");
    expect(await zohoConnectionStatus(store, "o")).toBe("not-connected");
  });
});

describe("zoho field setup", () => {
  it("resolves the configured outcome field first, reports gaps", () => {
    const got = syncZohoFieldMap({
      module: "Leads",
      descriptors: [{ apiName: "Phone" }, { apiName: "My_Outcome" }],
      outcomeField: "My_Outcome",
    });
    expect(got.fieldMap["outcome"]).toBe("My_Outcome");
    expect(got.missing).toEqual([]);
    const gap = syncZohoFieldMap({ module: "Leads", descriptors: [{ apiName: "Phone" }] });
    expect(gap.fieldMap["outcome"]).toBeNull();
    expect(gap.missing).toEqual(["outcome"]);
  });
});
