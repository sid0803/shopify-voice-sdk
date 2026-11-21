// Mongo connections + lead ledger + event claims.
// Secrets at rest are envelope-encrypted (v1. AES-256-GCM); blank means
// "not connected yet" and never requires a key just to save defaults.
import type { ZohoConnectionRecord, ZohoConnectionStore, ZohoEventClaim, ZohoLeadLedger, ZohoLeadRecord } from "../stores.js";
import { decryptSecret, encryptSecret } from "./crypto.js";
import type { Col, Docs } from "./collection.js";

function encryptField(value: string): string {
  return value ? encryptSecret(value) : "";
}

function decryptField(value: unknown): string {
  const s = typeof value === "string" ? value : "";
  if (!s) return "";
  // Fail closed: a non-empty secret must be an encrypted envelope. Legacy
  // plaintext rows are not silently accepted on a deployment with a key.
  if (!s.startsWith("v1.")) throw new Error("Refusing to read a non-encrypted secret at rest");
  return decryptSecret(s);
}

export async function ensureZohoConnectionIndexes(col: Col): Promise<void> {
  await col.createIndex({ orgId: 1 }, { unique: true });
}

interface ConnectionDoc {
  orgId: string;
  dataCenter: string;
  accessTokenEnc: string;
  refreshTokenEnc: string;
  fieldMap: Record<string, string | null>;
  status: "connected" | "disconnected";
  createdAt: string;
  updatedAt: string;
}

export class MongoZohoConnectionStore implements ZohoConnectionStore {
  constructor(private readonly col: Col) {}

  async get(orgId: string): Promise<ZohoConnectionRecord | null> {
    const doc = await this.col.findOne({ orgId: orgId.toLowerCase() });
    if (!doc) return null;
    return {
      orgId: String(doc["orgId"]),
      dataCenter: String(doc["dataCenter"] ?? ""),
      accessTokenEnc: decryptField(doc["accessTokenEnc"]),
      refreshTokenEnc: decryptField(doc["refreshTokenEnc"]),
      fieldMap: (doc["fieldMap"] as Record<string, string | null>) ?? {},
      status: doc["status"] === "disconnected" ? "disconnected" : "connected",
      createdAt: String(doc["createdAt"] ?? ""),
      updatedAt: String(doc["updatedAt"] ?? ""),
    };
  }

  async save(record: ZohoConnectionRecord): Promise<void> {
    const existing = await this.col.findOne({ orgId: record.orgId.toLowerCase() });
    if (!existing && !record.accessTokenEnc && !record.refreshTokenEnc && record.status === "connected") {
      throw new Error("Refusing to save a connected org without tokens");
    }
    const now = new Date().toISOString();
    const set: Docs = {
      orgId: record.orgId.toLowerCase(),
      dataCenter: record.dataCenter,
      fieldMap: record.fieldMap,
      status: record.status,
      updatedAt: now,
    };
    // Do not overwrite existing tokens with blanks on a non-secret re-save.
    // Connect/disconnect explicitly supplies or clears tokens.
    if (record.accessTokenEnc) set["accessTokenEnc"] = encryptField(record.accessTokenEnc);
    if (record.refreshTokenEnc) set["refreshTokenEnc"] = encryptField(record.refreshTokenEnc);
    await this.col.updateOne(
      { orgId: record.orgId.toLowerCase() },
      { $set: set, $setOnInsert: { createdAt: now } },
      { upsert: true },
    );
  }

  async remove(orgId: string): Promise<void> {
    await this.col.deleteOne({ orgId: orgId.toLowerCase() });
  }
}

export async function ensureZohoLeadIndexes(col: Col): Promise<void> {
  await col.createIndex({ externalId: 1 }, { unique: true });
  await col.createIndex({ callId: 1 }, { unique: true, sparse: true });
  await col.createIndex({ batchId: 1 }, { sparse: true });
  await col.createIndex({ orgId: 1, recordId: 1 });
}

function toLeadRecord(doc: Docs): ZohoLeadRecord {
  const { _id: _ignored, ...rest } = doc;
  return rest as unknown as ZohoLeadRecord;
}

function requireDeleteMany(col: Col): (filter: Docs) => Promise<{ deletedCount: number }> {
  if (!col.deleteMany) throw new Error("Mongo collection does not implement deleteMany");
  return col.deleteMany.bind(col);
}

function requireFind(col: Col): (filter: Docs) => { toArray(): Promise<Docs[]> } {
  if (!col.find) throw new Error("Mongo collection does not implement find");
  return col.find.bind(col);
}

export class MongoZohoLeadLedger implements ZohoLeadLedger {
  constructor(private readonly col: Col) {}

  async save(record: ZohoLeadRecord): Promise<void> {
    await this.col.updateOne(
      { externalId: record.externalId },
      { $set: { ...record, updatedAt: new Date().toISOString() } },
      { upsert: true },
    );
  }

  async lookup(key: string): Promise<{ orgId: string; recordId: string; module: string } | null> {
    const doc = await this.col.findOne({
      $or: [{ externalId: key }, { callId: key }, { batchId: key }],
    } as unknown as Docs);
    return doc ? { orgId: String(doc["orgId"]), recordId: String(doc["recordId"]), module: String(doc["module"]) } : null;
  }

  async update(key: string, patch: Partial<ZohoLeadRecord>): Promise<void> {
    await this.col.updateOne(
      { $or: [{ externalId: key }, { callId: key }, { batchId: key }] } as unknown as Docs,
      { $set: { ...patch, updatedAt: new Date().toISOString() } },
    );
  }

  async list(orgId: string, limit = 100): Promise<ZohoLeadRecord[]> {
    const docs = await requireFind(this.col)({ orgId: orgId.toLowerCase() }).toArray();
    return docs
      .map(toLeadRecord)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit);
  }

  async deleteOrg(orgId: string): Promise<void> {
    await requireDeleteMany(this.col)({ orgId: orgId.toLowerCase() });
  }
}

export async function ensureZohoEventIndexes(col: Col): Promise<void> {
  await col.createIndex({ eventId: 1 }, { unique: true });
}

export class MongoZohoEventClaim implements ZohoEventClaim {
  constructor(private readonly col: Col) {}

  async claim(eventId: string): Promise<boolean> {
    try {
      await this.col.insertOne({ eventId, claimedAt: new Date().toISOString() });
      return true;
    } catch (err) {
      if ((err as { code?: number })?.code === 11000) return false;
      throw err;
    }
  }

  async release(eventId: string): Promise<void> {
    await this.col.deleteOne({ eventId });
  }
}
