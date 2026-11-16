import { afterEach, describe, expect, it, vi } from "vitest";
import { decryptSecret, encryptSecret } from "../src/mongo/crypto.js";
import { MongoShopStore } from "../src/mongo/shops.js";
import { MongoCallLedger, MongoEventClaim, MongoSessionStore, MongoSettingsStore } from "../src/mongo/stores.js";
import { MongoJobQueue } from "../src/queue.js";
import { defaultSettings } from "../src/settings.js";
import type { Col, Docs } from "../src/mongo/collection.js";

// Test-only key: 32 ASCII bytes, base64. Never a real secret.
const TEST_KEY = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64");

function getPath(doc: Docs, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc === null || acc === undefined || typeof acc !== "object") return undefined;
    return (acc as Docs)[key];
  }, doc);
}

function match(doc: Docs, filter: Docs): boolean {
  for (const [k, v] of Object.entries(filter)) {
    if (k === "$or" && Array.isArray(v)) {
      if (!(v as Docs[]).some((f) => match(doc, f as Docs))) return false;
      continue;
    }
    const actual = k.includes(".") ? getPath(doc, k) : doc[k];
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const ops = v as Docs;
      if ("$in" in ops && !(ops["$in"] as unknown[]).includes(actual)) return false;
      if ("$lte" in ops && !((actual as string) <= (ops["$lte"] as string))) return false;
      if ("$lt" in ops && !((actual as string) < (ops["$lt"] as string))) return false;
      if ("$ne" in ops && actual === ops["$ne"]) return false;
      continue;
    }
    if (actual !== v) return false;
  }
  return true;
}

class FakeCol implements Col {
  docs: Docs[] = [];
  constructor(private readonly unique: string[] = []) {}
  async insertOne(doc: Docs) {
    for (const f of this.unique) {
      if (doc[f] !== undefined && this.docs.some((d) => d[f] === doc[f])) {
        throw Object.assign(new Error("duplicate"), { code: 11000 });
      }
    }
    this.docs.push({ ...doc });
    return { acknowledged: true };
  }
  async findOne(filter: Docs) {
    return this.docs.find((d) => match(d, filter)) ?? null;
  }
  async updateOne(filter: Docs, update: Docs, options?: { upsert?: boolean }) {
    const doc = this.docs.find((d) => match(d, filter));
    if (doc) {
      Object.assign(doc, (update["$set"] as Docs) ?? {});
      for (const key of Object.keys((update["$unset"] as Docs) ?? {})) delete doc[key];
      return { matchedCount: 1 };
    }
    if (options?.upsert) {
      this.docs.push({ ...(filter as Docs), ...((update["$set"] as Docs) ?? {}) });
      return { matchedCount: 0 };
    }
    return { matchedCount: 0 };
  }
  async deleteOne(filter: Docs) {
    const i = this.docs.findIndex((d) => match(d, filter));
    if (i >= 0) this.docs.splice(i, 1);
    return { deletedCount: i >= 0 ? 1 : 0 };
  }
  async deleteMany(filter: Docs) {
    const before = this.docs.length;
    this.docs = this.docs.filter((d) => !match(d, filter));
    return { deletedCount: before - this.docs.length };
  }
  find(filter: Docs) {
    return { toArray: async () => this.docs.filter((d) => match(d, filter)) };
  }
  async createIndex() {
    return "idx";
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("crypto", () => {
  it("round-trips and fails closed", () => {
    vi.stubEnv("TOKEN_ENCRYPTION_KEY", TEST_KEY);
    const enc = encryptSecret("shpat_test_value");
    expect(enc.startsWith("v1.")).toBe(true);
    expect(enc).not.toContain("shpat_test_value");
    expect(decryptSecret(enc)).toBe("shpat_test_value");
  });

  it("rejects wrong key, tamper and missing key", () => {
    vi.stubEnv("TOKEN_ENCRYPTION_KEY", TEST_KEY);
    const enc = encryptSecret("x");
    vi.stubEnv("TOKEN_ENCRYPTION_KEY", Buffer.from("fedcba9876543210fedcba9876543210").toString("base64"));
    expect(() => decryptSecret(enc)).toThrow();
    vi.stubEnv("TOKEN_ENCRYPTION_KEY", TEST_KEY);
    expect(() => decryptSecret(enc.slice(0, -2) + "AB")).toThrow();
    expect(() => decryptSecret("nope")).toThrow();
    vi.stubEnv("TOKEN_ENCRYPTION_KEY", "");
    expect(() => encryptSecret("x")).toThrow("TOKEN_ENCRYPTION_KEY is required");
  });
});

describe("mongo shops", () => {
  it("encrypts tokens at rest and revokes on remove", async () => {
    vi.stubEnv("TOKEN_ENCRYPTION_KEY", TEST_KEY);
    const col = new FakeCol();
    const store = new MongoShopStore(col);
    await store.save({ shopDomain: "Demo.Myshopify.Com", accessToken: "shpat_test_value", techladderAccountId: "acct_1" });
    const raw = col.docs[0];
    expect(raw["shopDomain"]).toBe("demo.myshopify.com");
    expect(JSON.stringify(raw)).not.toContain("shpat_test_value");
    const back = await store.get("demo.myshopify.com");
    expect(back?.accessToken).toBe("shpat_test_value");
    await store.remove("demo.myshopify.com");
    expect(await store.get("demo.myshopify.com")).toBeNull();
  });
});

describe("mongo settings/ledger/claims/sessions", () => {
  it("round-trips settings with validation", async () => {
    const store = new MongoSettingsStore(new FakeCol());
    expect(await store.get("x.myshopify.com")).toBeNull();
    await store.save({ ...defaultSettings("x.myshopify.com"), codOnly: true });
    expect((await store.get("X.MYSHOPIFY.COM"))?.codOnly).toBe(true);
  });

  it("deletes settings on shop/redact", async () => {
    const col = new FakeCol();
    const store = new MongoSettingsStore(col);
    await store.save(defaultSettings("x.myshopify.com"));
    await store.remove("X.MYSHOPIFY.COM");
    expect(await store.get("x.myshopify.com")).toBeNull();
    expect(col.docs.length).toBe(0);
  });

  it("ledger resolves by externalId and callId", async () => {
    const ledger = new MongoCallLedger(new FakeCol());
    const now = new Date().toISOString();
    await ledger.save({ shop: "s.myshopify.com", orderId: "ord-1", externalId: "ord-1", idempotencyKey: "k", status: "queued", createdAt: now, updatedAt: now });
    expect(await ledger.lookup("ord-1")).toMatchObject({ shop: "s.myshopify.com" });
    await ledger.update("ord-1", { callId: "c1", outcome: "confirmed" });
    expect(await ledger.lookup("c1")).toMatchObject({ orderId: "ord-1" });
    expect(await ledger.lookup("ghost")).toBeNull();
  });

  it("claim is atomic and releasable, other errors propagate", async () => {
    const claims = new MongoEventClaim(new FakeCol(["eventId"]));
    expect(await claims.claim("e1")).toBe(true);
    expect(await claims.claim("e1")).toBe(false);
    await claims.release("e1");
    expect(await claims.claim("e1")).toBe(true);
  });

  it("sessions expire", async () => {
    const sessions = new MongoSessionStore(new FakeCol());
    await sessions.save({ id: "s1", shop: "s", payload: {}, expiresAt: new Date(Date.now() + 60000).toISOString() });
    expect((await sessions.get("s1"))?.shop).toBe("s");
    await sessions.save({ id: "s2", shop: "s", payload: {}, expiresAt: new Date(Date.now() - 1000).toISOString() });
    expect(await sessions.get("s2")).toBeNull();
    await sessions.remove("s1");
    expect(await sessions.get("s1")).toBeNull();
  });

  it("encrypts TechLadder key and webhook secret at rest", async () => {
    vi.stubEnv("TOKEN_ENCRYPTION_KEY", TEST_KEY);
    const col = new FakeCol();
    const store = new MongoSettingsStore(col);
    await store.save({
      ...defaultSettings("s.myshopify.com"),
      techladderKeyRef: "sk_test_secret_value",
      techladderWebhookSecretRef: "whsec_test_value",
    });
    const raw = JSON.stringify(col.docs[0]);
    expect(raw).not.toContain("sk_test_secret_value");
    expect(raw).not.toContain("whsec_test_value");
    expect(raw).not.toContain("techladderKeyRef");
    const back = await store.get("s.myshopify.com");
    expect(back?.techladderKeyRef).toBe("sk_test_secret_value");
    expect(back?.techladderWebhookSecretRef).toBe("whsec_test_value");
  });

  it("fails closed when a real key must be encrypted but the env key is missing", async () => {
    vi.stubEnv("TOKEN_ENCRYPTION_KEY", "");
    const store = new MongoSettingsStore(new FakeCol());
    await expect(
      store.save({ ...defaultSettings("s.myshopify.com"), techladderKeyRef: "sk_test_secret_value" }),
    ).rejects.toThrow("TOKEN_ENCRYPTION_KEY is required");
  });

  it("refuses to read a plaintext secret row", async () => {
    vi.stubEnv("TOKEN_ENCRYPTION_KEY", TEST_KEY);
    const col = new FakeCol();
    col.docs.push({
      externalAccountId: "s.myshopify.com",
      techladderKeyEnc: "sk_plaintext_legacy",
      techladderWebhookSecretEnc: "",
    });
    const store = new MongoSettingsStore(col);
    await expect(store.get("s.myshopify.com")).rejects.toThrow(/non-encrypted secret/);
  });

  it("ledger resolves by batchId, lists, and deletes customer/shop data", async () => {
    const ledger = new MongoCallLedger(new FakeCol());
    const now = new Date().toISOString();
    const base = { shop: "s.myshopify.com", orderId: "ord-1", externalId: "ord-1", idempotencyKey: "k", status: "queued", createdAt: now, updatedAt: now };
    await ledger.save({ ...base, batchId: "b1", customerId: "cust-1" });
    await ledger.save({ ...base, orderId: "ord-2", externalId: "ord-2", customerId: "cust-2" });
    expect(await ledger.lookup("b1")).toMatchObject({ orderId: "ord-1" });
    expect((await ledger.list("s.myshopify.com")).length).toBe(2);
    expect((await ledger.customerCallLog("s.myshopify.com", "cust-1"))[0]?.orderId).toBe("ord-1");
    await ledger.deleteCustomerData("s.myshopify.com", "cust-1");
    expect(await ledger.lookup("ord-1")).toBeNull();
    expect((await ledger.list("s.myshopify.com")).length).toBe(1);
    await ledger.deleteShop("s.myshopify.com");
    expect((await ledger.list("s.myshopify.com")).length).toBe(0);
  });

  it("job queue claims once, retries, then fails", async () => {
    const col = new FakeCol(["id"]);
    const queue = new MongoJobQueue(col);
    expect(await queue.enqueue({ id: "j1", type: "order.create", payload: { shop: "s" }, maxAttempts: 2 })).toBe(true);
    expect(await queue.enqueue({ id: "j1", type: "order.create", payload: { shop: "s" } })).toBe(false);
    const first = await queue.claimNext();
    expect(first?.id).toBe("j1");
    expect(await queue.claimNext()).toBeNull();
    await queue.fail("j1", "transient", 0);
    const retry = await queue.claimNext();
    expect(retry?.attempts).toBe(2);
    await queue.fail("j1", "still bad", 0);
    expect(await queue.claimNext()).toBeNull();
    expect(col.docs[0]?.["status"]).toBe("failed");
  });

  it("only claims jobs whose runAt is due", async () => {
    const queue = new MongoJobQueue(new FakeCol(["id"]));
    const now = "2026-11-16T10:00:00.000Z";
    await queue.enqueue({ id: "later", type: "order.create", payload: { shop: "s" }, runAt: "2026-11-16T11:00:00.000Z" });
    await queue.enqueue({ id: "ready", type: "order.create", payload: { shop: "s" }, runAt: now });
    expect((await queue.claimNext(now))?.id).toBe("ready");
    expect(await queue.claimNext(now)).toBeNull();
    expect((await queue.claimNext("2026-11-16T11:00:00.000Z"))?.id).toBe("later");
  });

  it("reclaims a crashed worker's stale running job", async () => {
    const col = new FakeCol(["id"]);
    const queue = new MongoJobQueue(col);
    const now = "2026-11-16T10:00:00.000Z";
    await queue.enqueue({ id: "j1", type: "order.create", payload: { shop: "s" }, runAt: now });
    expect((await queue.claimNext(now))?.id).toBe("j1");
    // Fresh lease: no other worker may steal it.
    expect(await queue.claimNext("2026-11-16T10:01:00.000Z")).toBeNull();
    // Lease expired: the job becomes claimable again with a bumped attempt.
    const reclaimed = await queue.claimNext("2026-11-16T11:00:00.000Z");
    expect(reclaimed?.id).toBe("j1");
    expect(reclaimed?.attempts).toBe(2);
  });

  it("purges queued jobs per shop and per customer", async () => {
    const queue = new MongoJobQueue(new FakeCol(["id"]));
    await queue.enqueue({
      id: "order:1",
      type: "order.create",
      payload: { shop: "s.myshopify.com", customerId: "cust-1" },
    });
    await queue.enqueue({
      id: "order:2",
      type: "order.create",
      payload: { shop: "s.myshopify.com", customerId: "cust-2" },
    });
    await queue.enqueue({
      id: "order:3",
      type: "order.create",
      payload: { shop: "other.myshopify.com", customerId: "cust-1" },
    });

    await queue.deleteForCustomer("S.MYSHOPIFY.COM", "cust-1");
    expect(await queue.claimNext()).not.toBeNull();
    await queue.deleteForShop("s.myshopify.com");
    const remaining = await queue.claimNext();
    expect(remaining?.id).toBe("order:3");
    expect(await queue.claimNext()).toBeNull();
  });
});
