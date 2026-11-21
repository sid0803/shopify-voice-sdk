import { afterEach, describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "../src/mongo/crypto.js";
import { MongoZohoConnectionStore, MongoZohoEventClaim, MongoZohoLeadLedger } from "../src/mongo/stores.js";
import {
  InMemoryZohoConnectionStore,
  InMemoryZohoEventClaim,
  InMemoryZohoLeadLedger,
} from "../src/stores.js";
import { InMemoryZohoJobQueue, MongoZohoJobQueue } from "../src/queue.js";
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
      const created: Docs = { ...(filter as Docs) };
      Object.assign(created, (update["$set"] as Docs) ?? {});
      const setOnInsert = (update["$setOnInsert"] as Docs) ?? {};
      Object.assign(created, setOnInsert);
      this.docs.push(created);
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
    const rows = this.docs.filter((d) => match(d, filter));
    return { toArray: async () => rows.map((d) => ({ ...d })) };
  }
  async createIndex() {
    return "fake-index";
  }
}

const OLD_KEY = process.env["TOKEN_ENCRYPTION_KEY"];
afterEach(() => {
  if (OLD_KEY === undefined) delete process.env["TOKEN_ENCRYPTION_KEY"];
  else process.env["TOKEN_ENCRYPTION_KEY"] = OLD_KEY;
});

describe("zoho mongo envelope", () => {
  it("round-trips secrets and fails closed without a key", () => {
    process.env["TOKEN_ENCRYPTION_KEY"] = TEST_KEY;
    const enc = encryptSecret("tok-test-value");
    expect(enc.startsWith("v1.")).toBe(true);
    expect(enc).not.toContain("tok-test-value");
    expect(decryptSecret(enc)).toBe("tok-test-value");
    delete process.env["TOKEN_ENCRYPTION_KEY"];
    expect(() => encryptSecret("x")).toThrow("TOKEN_ENCRYPTION_KEY is required");
  });
});

describe("zoho connection store", () => {
  it("encrypts tokens at rest and decrypts on read", async () => {
    process.env["TOKEN_ENCRYPTION_KEY"] = TEST_KEY;
    const col = new FakeCol(["orgId"]);
    const store = new MongoZohoConnectionStore(col);
    await store.save({
      orgId: "Org-1",
      dataCenter: "in",
      accessTokenEnc: "at-test",
      refreshTokenEnc: "rt-test",
      fieldMap: { outcome: "Call_Outcome" },
      status: "connected",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const raw = col.docs[0] as Docs;
    expect(raw["orgId"]).toBe("org-1");
    expect(String(raw["accessTokenEnc"])).not.toContain("at-test");
    const back = await store.get("ORG-1");
    expect(back?.accessTokenEnc).toBe("at-test");
    expect(back?.refreshTokenEnc).toBe("rt-test");
    expect(back?.dataCenter).toBe("in");
  });

  it("never overwrites stored tokens with blanks and refuses empty connects", async () => {
    process.env["TOKEN_ENCRYPTION_KEY"] = TEST_KEY;
    const col = new FakeCol(["orgId"]);
    const store = new MongoZohoConnectionStore(col);
    await expect(
      store.save({
        orgId: "o", dataCenter: "in", accessTokenEnc: "", refreshTokenEnc: "",
        fieldMap: {}, status: "connected", createdAt: "t", updatedAt: "t",
      }),
    ).rejects.toThrow("without tokens");
    await store.save({
      orgId: "o", dataCenter: "in", accessTokenEnc: "at-1", refreshTokenEnc: "rt-1",
      fieldMap: {}, status: "connected", createdAt: "t", updatedAt: "t",
    });
    await store.save({
      orgId: "o", dataCenter: "in", accessTokenEnc: "", refreshTokenEnc: "",
      fieldMap: { outcome: "X" }, status: "connected", createdAt: "t", updatedAt: "t",
    });
    expect((await store.get("o"))?.accessTokenEnc).toBe("at-1");
    await store.remove("o");
    expect(await store.get("o")).toBeNull();
  });

  it("in-memory store namespaces by org", () => {
    const s = new InMemoryZohoConnectionStore();
    s.save({ orgId: "A", dataCenter: "in", accessTokenEnc: "a", refreshTokenEnc: "a", fieldMap: {}, status: "connected", createdAt: "t", updatedAt: "t" });
    expect(s.get("a")?.dataCenter).toBe("in");
    expect(s.get("b")).toBeNull();
  });
});

describe("zoho lead ledger", () => {
  const rec = {
    orgId: "org-1", module: "Leads", recordId: "111", externalId: "111",
    callId: "c1", batchId: "b1", idempotencyKey: "k1", status: "queued",
    createdAt: "t", updatedAt: "t",
  };

  it("looks up by external id, call id and batch id", async () => {
    const ledger = new MongoZohoLeadLedger(new FakeCol(["externalId"]));
    await ledger.save({ ...rec });
    expect(await ledger.lookup("111")).toEqual({ orgId: "org-1", recordId: "111", module: "Leads" });
    expect(await ledger.lookup("c1")).toEqual({ orgId: "org-1", recordId: "111", module: "Leads" });
    expect(await ledger.lookup("b1")).toEqual({ orgId: "org-1", recordId: "111", module: "Leads" });
    expect(await ledger.lookup("nope")).toBeNull();
    await ledger.update("c1", { status: "tagged", outcome: "confirmed" });
    const rows = await ledger.list("ORG-1");
    expect(rows[0]?.status).toBe("tagged");
    await ledger.deleteOrg("org-1");
    expect(await ledger.list("org-1")).toEqual([]);
  });

  it("in-memory ledger isolates orgs", () => {
    const ledger = new InMemoryZohoLeadLedger();
    ledger.save({ ...rec });
    ledger.save({ ...rec, orgId: "org-2", externalId: "222", recordId: "222" });
    expect(ledger.list("org-1")).toHaveLength(1);
    ledger.deleteOrg("org-1");
    expect(ledger.list("org-1")).toEqual([]);
    expect(ledger.list("org-2")).toHaveLength(1);
  });
});

describe("zoho claims and queue", () => {
  it("claims once, releases for redelivery", async () => {
    const mongo = new MongoZohoEventClaim(new FakeCol(["eventId"]));
    expect(await mongo.claim("e1")).toBe(true);
    expect(await mongo.claim("e1")).toBe(false);
    await mongo.release("e1");
    expect(await mongo.claim("e1")).toBe(true);
    const mem = new InMemoryZohoEventClaim();
    expect(mem.claim("e1")).toBe(true);
    expect(mem.claim("e1")).toBe(false);
  });

  it("queues with dedupe, claim, retry and org purge", async () => {
    const q = new MongoZohoJobQueue(new FakeCol(["id"]));
    expect(await q.enqueue({ id: "j1", type: "zoho.lead", payload: { orgId: "Org-1", recordId: "111" } })).toBe(true);
    expect(await q.enqueue({ id: "j1", type: "zoho.lead", payload: { orgId: "Org-1", recordId: "111" } })).toBe(false);
    const claimed = await q.claimNext(new Date(Date.now() + 60_000).toISOString());
    expect(claimed?.id).toBe("j1");
    expect(claimed?.attempts).toBe(1);
    await q.fail("j1", "boom", 0);
    await q.complete("j1");
    await q.enqueue({ id: "j2", type: "zoho.result", payload: { orgId: "org-1", recordId: "111" } });
    await q.deleteForOrg("ORG-1");
    expect(await q.claimNext(new Date(Date.now() + 3_600_000).toISOString())).toBeNull();

    const mem = new InMemoryZohoJobQueue();
    expect(mem.enqueue({ id: "m1", type: "zoho.lead", payload: { orgId: "o", recordId: "1" } })).toBe(true);
    expect(mem.enqueue({ id: "m1", type: "zoho.lead", payload: { orgId: "o", recordId: "1" } })).toBe(false);
    mem.fail("m1", "x", 0);
    mem.deleteForRecord("o", "1");
    expect(mem.claimNext(new Date(Date.now() + 3_600_000).toISOString())).toBeNull();
  });
});
