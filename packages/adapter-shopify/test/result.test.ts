import { describe, expect, it } from "vitest";
import { resolveResultTag } from "../src/index.js";
import { toCallResult, toCallResultAsync, type ResultLedger } from "../src/result.js";

const ledger: ResultLedger = {
  lookup: (key: string) => (key === "c1" || key === "ord-9" ? { shop: "demo.myshopify.com", orderId: "ord-9" } : null),
};

describe("toCallResult", () => {
  it("maps analysis.ready outcomes to a disposition, shop/order from ledger", () => {
    const out = toCallResult(
      { event: "analysis.ready", data: { call_id: "c1", batch_id: "b1", summary: "Confirmed COD", outcomes: { order_confirmation: "confirmed" }, recording: { file_key: "r.mp3" } } },
      ledger,
    );
    expect(out?.outcome).toBe("confirmed");
    expect(out?.externalId).toBe("ord-9");
    expect(out?.externalAccountId).toBe("demo.myshopify.com");
    expect(out?.summary).toBe("Confirmed COD");
  });

  it("maps call.failed to execution status", () => {
    const out = toCallResult({ event: "call.failed", data: { call_id: "c1", external_id: "ord-9" } }, ledger);
    expect(out?.callStatus).toBe("failed");
  });

  it("falls back to uncertain and returns null without ledger", () => {
    const out = toCallResult({ event: "analysis.ready", data: { call_id: "c1", outcomes: { blah: "???" } } }, ledger);
    expect(out?.outcome).toBe("uncertain");
    expect(toCallResult({ event: "analysis.ready", data: { call_id: "ghost" } }, ledger)).toBeNull();
    expect(toCallResult(null, ledger)).toBeNull();
  });

  it("reads snake_case and camelCase", () => {
    const out = toCallResult(
      { event: "call.completed", data: { callId: "c1", externalId: "ord-9", outcomes: { decision: "Cancel Requested" } } },
      ledger,
    );
    expect(out?.outcome).toBe("cancelled");
  });

  it("resolves results that only carry a batch id", () => {
    const batchLedger: ResultLedger = {
      lookup: (key) => (key === "batch-1" ? { shop: "demo.myshopify.com", orderId: "ord-1" } : null),
    };
    const out = toCallResult({ event: "analysis.ready", data: { batch_id: "batch-1", outcomes: { result: "confirmed" } } }, batchLedger);
    expect(out?.externalId).toBe("ord-1");
    expect(out?.callId).toBe("batch-1");
  });

  it("reads nested outcomes and never lets a key decide the value", () => {
    const nested = toCallResult(
      { event: "analysis.ready", data: { call_id: "c1", outcomes: { answers: { main_disposition: "wrong number" } } } },
      ledger,
    );
    expect(nested?.outcome).toBe("wrong_number");
    expect(nested?.callId).toBe("c1");
  });

  it("maps no-answer execution status without inventing a disposition", () => {
    const event = toCallResult({ event: "call.no_answer", data: { call_id: "c1" } }, ledger);
    expect(event?.callStatus).toBe("no_answer");
    const status = toCallResult({ event: "analysis.ready", data: { call_id: "c1", call_status: "not-answered", outcomes: {} } }, ledger);
    expect(status?.callStatus).toBe("no_answer");
  });

  it("negated confirmation is not mapped to confirmed", () => {
    const out = toCallResult(
      { event: "analysis.ready", data: { call_id: "c1", outcomes: { order_confirmation: "not confirmed" } } },
      ledger,
    );
    expect(out?.outcome).toBe("cancelled");
  });

  it("treats an unconfirmed outcome as uncertain, not declined", () => {
    const out = toCallResult(
      { event: "analysis.ready", data: { call_id: "c1", outcomes: { order_confirmation: "unconfirmed" } } },
      ledger,
    );
    expect(out?.outcome).toBe("uncertain");
  });

  it("supports async ledgers", async () => {
    const out = await toCallResultAsync(
      { event: "analysis.ready", data: { call_id: "c1", outcomes: { decision: "confirmed" } } },
      { lookup: async (key: string) => (key === "c1" ? { shop: "demo.myshopify.com", orderId: "ord-9" } : null) },
    );
    expect(out?.externalId).toBe("ord-9");
  });

  it("ignores lifecycle events (BUG-004: batch.started/cancelled, call.queued)", () => {
    expect(toCallResult({ event: "batch.started", data: { call_id: "c1" } }, ledger)).toBeNull();
    expect(toCallResult({ event: "batch.cancelled", data: { batch_id: "b1" } }, ledger)).toBeNull();
    expect(toCallResult({ event: "call.queued", data: { call_id: "c1" } }, ledger)).toBeNull();
  });
});

describe("resolveResultTag", () => {
  it("maps execution statuses that never reached a conversation", () => {
    expect(resolveResultTag({ outcome: "confirmed", callStatus: "no_answer" })).toBe("call-no-answer");
    expect(resolveResultTag({ outcome: "confirmed", callStatus: "failed" })).toBe("call-failed");
    expect(resolveResultTag({ outcome: "confirmed", callStatus: "completed" })).toBe("call-confirmed");
  });

  it("maps business dispositions", () => {
    expect(resolveResultTag({ outcome: "cancelled" })).toBe("call-cancel-requested");
    expect(resolveResultTag({ outcome: "wrong_number" })).toBe("call-wrong-number");
  });

  it("honours per-shop tag overrides by base tag or disposition", () => {
    expect(resolveResultTag({ outcome: "confirmed" }, { "call-confirmed": "Confirmed by phone" })).toBe(
      "Confirmed by phone",
    );
    expect(resolveResultTag({ outcome: "cancelled" }, { cancelled: "Not wanted" })).toBe("Not wanted");
    expect(resolveResultTag({ outcome: "confirmed", callStatus: "failed" }, { "call-failed": "Could not reach" })).toBe(
      "Could not reach",
    );
  });
});
