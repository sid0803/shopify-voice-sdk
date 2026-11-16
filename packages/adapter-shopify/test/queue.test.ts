import { describe, expect, it } from "vitest";
import { InMemoryJobQueue, JOB_LEASE_MS } from "../src/queue.js";

describe("in-memory job queue", () => {
  it("dedupes by id and only claims due work", () => {
    const queue = new InMemoryJobQueue();
    const now = "2026-11-16T10:00:00.000Z";
    expect(queue.enqueue({ id: "later", type: "order.create", payload: { shop: "s" }, runAt: "2026-11-16T11:00:00.000Z" })).toBe(true);
    expect(queue.enqueue({ id: "later", type: "order.create", payload: { shop: "s" } })).toBe(false);
    queue.enqueue({ id: "ready", type: "order.create", payload: { shop: "s" }, runAt: now });
    expect(queue.claimNext(now)?.id).toBe("ready");
    expect(queue.claimNext(now)).toBeNull();
    expect(queue.claimNext("2026-11-16T11:00:00.000Z")?.id).toBe("later");
  });

  it("retries then fails without leaving a lease behind", () => {
    const queue = new InMemoryJobQueue();
    queue.enqueue({ id: "j1", type: "order.create", payload: { shop: "s" }, maxAttempts: 1 });
    const claimed = queue.claimNext();
    expect(claimed?.lockedAt).toBeTruthy();
    queue.fail("j1", "boom", 0);
    expect(queue.claimNext()).toBeNull();
  });

  it("reclaims a stale running job after the lease expires", () => {
    const queue = new InMemoryJobQueue();
    const start = Date.parse("2026-11-16T10:00:00.000Z");
    queue.enqueue({ id: "j1", type: "order.create", payload: { shop: "s" }, runAt: new Date(start).toISOString() });
    expect(queue.claimNext(new Date(start).toISOString())?.attempts).toBe(1);
    expect(queue.claimNext(new Date(start + 60_000).toISOString())).toBeNull();
    const reclaimed = queue.claimNext(new Date(start + JOB_LEASE_MS + 1).toISOString());
    expect(reclaimed?.id).toBe("j1");
    expect(reclaimed?.attempts).toBe(2);
  });

  it("purges per shop and per customer", () => {
    const queue = new InMemoryJobQueue();
    queue.enqueue({ id: "a", type: "order.create", payload: { shop: "s.myshopify.com", customerId: "cust-1" } });
    queue.enqueue({ id: "b", type: "order.create", payload: { shop: "s.myshopify.com", customerId: "cust-2" } });
    queue.enqueue({ id: "c", type: "order.create", payload: { shop: "other.myshopify.com", customerId: "cust-1" } });
    queue.deleteForCustomer("S.MYSHOPIFY.COM", "cust-1");
    expect(queue.claimNext()?.id).toBe("b");
    queue.deleteForShop("s.myshopify.com");
    expect(queue.claimNext()?.id).toBe("c");
    expect(queue.claimNext()).toBeNull();
  });
});
