import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createShopifyAdapter } from "../src/index.js";
import { toCallResult, type ResultLedger } from "../src/result.js";

// Senior item 1 done-criterion: replay a (currently code-derived) analysis.ready
// sample end to end: envelope -> disposition -> ledger resolution -> order tag.
// Swap the fixture for a real signed payload when backend provides one.
function loadSample(): unknown {
  const p = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "analysis-ready.sample.json");
  return JSON.parse(readFileSync(p, "utf-8")) as unknown;
}

const ledger: ResultLedger = {
  lookup: (key: string) =>
    key === "call_replay_001" || key === "19059874693348"
      ? { shop: "dev-store-1gm9xtph.myshopify.com", orderId: "19059874693348" }
      : null,
};

describe("analysis.ready replay", () => {
  it("maps sample to confirmed and tags the ledger order", async () => {
    const result = toCallResult(loadSample(), ledger);
    expect(result?.outcome).toBe("confirmed");
    expect(result?.externalId).toBe("19059874693348");
    expect(result?.externalAccountId).toBe("dev-store-1gm9xtph.myshopify.com");
    expect(result?.summary).toContain("COD");

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { tagsAdd: { userErrors: [] } } }), { status: 200 }),
    );
    const a = createShopifyAdapter({ apiSecret: "shpss_test", accessToken: "tok", fetchImpl: fetchMock as typeof fetch });
    await a.handleResult(result!, {
      externalAccountId: "dev-store-1gm9xtph.myshopify.com",
      config: { apiSecret: "shpss_test" },
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(init.body)).toContain("gid://shopify/Order/19059874693348");
    expect(String(init.body)).toContain("call-confirmed");
  });
});
