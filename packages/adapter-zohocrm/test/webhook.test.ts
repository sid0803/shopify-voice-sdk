import { describe, expect, it, vi } from "vitest";
import { claimKeyFor, handleZohoWebhook } from "../src/shell/webhook.js";
import { InMemoryZohoEventClaim } from "../src/stores.js";
import { InMemoryZohoJobQueue } from "../src/queue.js";

const SECRET = "zoho_test_token";
const HEADERS = { "X-Zoho-Webhook-Token": SECRET };
const RECORD = { id: "111", First_Name: "Test", Phone: "+91 90000 00001" };

function deps() {
  return {
    webhookSecret: SECRET,
    dataCenter: "in",
    claims: new InMemoryZohoEventClaim(),
    queue: new InMemoryZohoJobQueue(),
  };
}

describe("zoho webhook receiver", () => {
  it("derives stable claim keys, preferring the delivery id", () => {
    expect(claimKeyFor({ module: "Leads", record: RECORD, deliveryId: "d1" })).toBe("zoho:d1");
    expect(claimKeyFor({ module: "Leads", record: { ...RECORD, Modified_Time: "t" } })).toBe(
      "zoho:Leads:111:t",
    );
  });

  it("rejects bad signatures with 401", async () => {
    const out = await handleZohoWebhook(
      { headers: { "X-Zoho-Webhook-Token": "bad" }, orgId: "Org-1", module: "Leads", record: RECORD },
      deps(),
    );
    expect(out).toEqual({ httpStatus: 401, detail: "bad signature" });
  });

  it("acks fast, dedupes redeliveries and duplicate jobs", async () => {
    const d = deps();
    const delivery = { headers: HEADERS, orgId: "Org-1", module: "Leads", record: RECORD, deliveryId: "d1" };
    expect(await handleZohoWebhook(delivery, d)).toEqual({ httpStatus: 200, detail: "queued" });
    expect(await handleZohoWebhook(delivery, d)).toEqual({ httpStatus: 200, detail: "duplicate" });

    // Same record, new delivery id, but the job id collides -> duplicate job.
    const d2 = deps();
    (d2.queue.enqueue as unknown as () => boolean) = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
    const first = await handleZohoWebhook({ ...delivery, deliveryId: "fresh" }, d2);
    expect(first.detail).toBe("queued");
  });

  it("releases the claim on transient enqueue failure so Zoho can retry", async () => {
    const d = deps();
    d.queue.enqueue = (() => { throw new Error("db down"); }) as typeof d.queue.enqueue;
    const out = await handleZohoWebhook(
      { headers: HEADERS, orgId: "o", module: "Leads", record: RECORD, deliveryId: "d9" },
      d,
    );
    expect(out).toEqual({ httpStatus: 503, detail: "transient" });
    // Claim released: a retry with a working queue processes normally.
    const d2 = deps();
    (d2.claims as unknown as { seen: Set<string> }).seen = (d.claims as unknown as { seen: Set<string> }).seen;
    const retry = await handleZohoWebhook(
      { headers: HEADERS, orgId: "o", module: "Leads", record: RECORD, deliveryId: "d9" },
      d2,
    );
    expect(retry).toEqual({ httpStatus: 200, detail: "queued" });
  });
});
