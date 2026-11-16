import { describe, expect, it, vi } from "vitest";
import { reconcileCalls, type ReconcileResultClient, type ReconcileClaimStore } from "../src/reconcile.js";
import { InMemoryCallLedger, type CallRecord } from "../src/stores.js";
import type { CallCompletedEvent } from "../../core/src/events/types.js";

const SHOP = "pilot-store.myshopify.com";

function createRecord(overrides: Partial<CallRecord> = {}): CallRecord {
  return {
    shop: SHOP,
    orderId: "order-101",
    externalId: "order-101",
    callId: "call_abc123",
    batchId: "batch_xyz789",
    idempotencyKey: "shopify:pilot-store.myshopify.com:order_confirmation:order-101",
    status: "queued",
    createdAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(), // 30m ago
    updatedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

describe("reconcileCalls (Task 7)", () => {
  it("reconciles a missed webhook: fetches result, tags order, and updates ledger", async () => {
    const ledger = new InMemoryCallLedger();
    ledger.save(createRecord());

    const client: ReconcileResultClient = {
      getResult: vi.fn().mockResolvedValue({
        call_id: "call_abc123",
        status: "completed",
        outcomes: { confirmation: "confirmed" },
        summary: "Customer confirmed delivery",
        recording_url: "https://rec.example.com/call_abc123.mp3",
      }),
    };

    const handleResult = vi.fn().mockResolvedValue(undefined);

    const summary = await reconcileCalls({
      shop: SHOP,
      ledger,
      client,
      handleResult,
      olderThanMinutes: 15,
    });

    expect(summary.inspected).toBe(1);
    expect(summary.reconciled).toBe(1);
    expect(summary.skippedRecent).toBe(0);
    expect(summary.skippedSettled).toBe(0);

    expect(handleResult).toHaveBeenCalledTimes(1);
    const calledResult = handleResult.mock.calls[0][0] as CallCompletedEvent;
    expect(calledResult.outcome).toBe("confirmed");
    expect(calledResult.externalId).toBe("order-101");

    // Check ledger state
    const updated = (ledger as unknown as { records: Map<string, CallRecord> }).records.get("order-101");
    expect(updated?.status).toBe("tagged");
    expect(updated?.outcome).toBe("confirmed");
    expect(updated?.tagApplied).toBe("call-confirmed");
    expect(updated?.summary).toBe("Customer confirmed delivery");
  });

  it("second run no-ops when call is already settled (idempotency)", async () => {
    const ledger = new InMemoryCallLedger();
    ledger.save(
      createRecord({
        status: "tagged",
        outcome: "confirmed",
        tagApplied: "call-confirmed",
      }),
    );

    const client: ReconcileResultClient = {
      getResult: vi.fn(),
    };
    const handleResult = vi.fn();

    const summary = await reconcileCalls({
      shop: SHOP,
      ledger,
      client,
      handleResult,
      olderThanMinutes: 15,
    });

    expect(summary.inspected).toBe(1);
    expect(summary.skippedSettled).toBe(1);
    expect(summary.reconciled).toBe(0);
    expect(client.getResult).not.toHaveBeenCalled();
    expect(handleResult).not.toHaveBeenCalled();
  });

  it("skips calls younger than olderThanMinutes (grace window)", async () => {
    const ledger = new InMemoryCallLedger();
    ledger.save(
      createRecord({
        createdAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(), // 5 min ago
      }),
    );

    const client: ReconcileResultClient = {
      getResult: vi.fn(),
    };
    const handleResult = vi.fn();

    const summary = await reconcileCalls({
      shop: SHOP,
      ledger,
      client,
      handleResult,
      olderThanMinutes: 15,
    });

    expect(summary.inspected).toBe(1);
    expect(summary.skippedRecent).toBe(1);
    expect(summary.reconciled).toBe(0);
    expect(client.getResult).not.toHaveBeenCalled();
    expect(handleResult).not.toHaveBeenCalled();
  });

  it("falls back to listCallsByExternalId when getResult returns null or throws", async () => {
    const ledger = new InMemoryCallLedger();
    ledger.save(createRecord());

    const client: ReconcileResultClient = {
      getResult: vi.fn().mockRejectedValue(new Error("Call not found")),
      listCallsByExternalId: vi.fn().mockResolvedValue({
        items: [
          {
            call_id: "call_abc123",
            call_status: "failed",
            status: "failed",
          },
        ],
      }),
    };

    const handleResult = vi.fn().mockResolvedValue(undefined);

    const summary = await reconcileCalls({
      shop: SHOP,
      ledger,
      client,
      handleResult,
      olderThanMinutes: 15,
    });

    expect(summary.reconciled).toBe(1);
    expect(handleResult).toHaveBeenCalledTimes(1);
    const calledResult = handleResult.mock.calls[0][0] as CallCompletedEvent;
    expect(calledResult.callStatus).toBe("failed");

    const updated = (ledger as unknown as { records: Map<string, CallRecord> }).records.get("order-101");
    expect(updated?.tagApplied).toBe("call-failed");
  });

  it("respects claimStore and skips already claimed calls", async () => {
    const ledger = new InMemoryCallLedger();
    ledger.save(createRecord());

    const claimStore: ReconcileClaimStore = {
      claim: vi.fn().mockResolvedValue(false), // another worker holds claim
      release: vi.fn(),
    };

    const client: ReconcileResultClient = {
      getResult: vi.fn(),
    };
    const handleResult = vi.fn();

    const summary = await reconcileCalls({
      shop: SHOP,
      ledger,
      client,
      handleResult,
      claimStore,
    });

    expect(summary.inspected).toBe(1);
    expect(summary.skippedSettled).toBe(1);
    expect(summary.reconciled).toBe(0);
    expect(client.getResult).not.toHaveBeenCalled();
  });

  it("handles unsettled calls by releasing claim and not tagging", async () => {
    const ledger = new InMemoryCallLedger();
    ledger.save(createRecord());

    const client: ReconcileResultClient = {
      getResult: vi.fn().mockResolvedValue({
        call_id: "call_abc123",
        status: "in_progress", // not settled yet
      }),
    };
    const claimStore: ReconcileClaimStore = {
      claim: vi.fn().mockResolvedValue(true),
      release: vi.fn().mockResolvedValue(undefined),
    };
    const handleResult = vi.fn();

    const summary = await reconcileCalls({
      shop: SHOP,
      ledger,
      client,
      handleResult,
      claimStore,
    });

    expect(summary.reconciled).toBe(0);
    expect(summary.noResultFound).toBe(1);
    expect(claimStore.release).toHaveBeenCalled();
    expect(handleResult).not.toHaveBeenCalled();
  });
});
