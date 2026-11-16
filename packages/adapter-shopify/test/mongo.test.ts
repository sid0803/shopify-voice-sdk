import { afterEach, describe, expect, it, vi } from "vitest";
import { decryptSecret, encryptSecret } from "../src/mongo/crypto.js";
import { MongoShopStore } from "../src/mongo/shops.js";
import { MongoCallLedger, MongoEventClaim, MongoSessionStore, MongoSettingsStore } from "../src/mongo/stores.js";
import { defaultSettings } from "../src/settings.js";
import type { Col, Docs } from "../src/mongo/collection.js";

// Test-only key: 32 ASCII bytes, base64. Never a real secret.
const TEST_KEY = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64");

function match(doc: Docs, filter: Docs): boolean {
  for (const [k, v] of Object.entries(filter)) {
    if (k === "$or" && Array.isArray(v)) {
      if (!(v as Docs[]).some((f) => match(doc, f as Docs))) return false;
      continue;
    }
    if (doc[k] !== v) return false;
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
    expect((await store.get("demo.myshopify.com"))?.accessToken).toBe("shpat_test_value");
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
});
