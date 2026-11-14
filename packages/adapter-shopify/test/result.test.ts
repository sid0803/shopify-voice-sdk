import { describe, expect, it } from "vitest";
import { toCallResult, type ResultLedger } from "../src/result.js";

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
});
