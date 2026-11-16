// Mongo settings + calls + events + sessions (senior item 3).
import { ShopSettingsSchema, type SettingsStore, type ShopSettings } from "../settings.js";
import type { CallLedger, CallRecord, EventClaim } from "../stores.js";
import { decryptSecret, encryptSecret } from "./crypto.js";
import type { Col, Docs } from "./collection.js";

export async function ensureSettingsIndexes(col: Col): Promise<void> {
  await col.createIndex({ externalAccountId: 1 }, { unique: true });
}

const SECRET_FIELDS = ["techladderKeyRef", "techladderWebhookSecretRef"] as const;

function encryptField(value: string): string {
  // Blank means "not connected yet" — do not require a key just to save defaults.
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

function settingsDoc(settings: ShopSettings): Docs {
  const parsed = ShopSettingsSchema.parse(settings);
  const { techladderKeyRef, techladderWebhookSecretRef, ...rest } = parsed;
  return {
    ...rest,
    externalAccountId: parsed.externalAccountId.toLowerCase(),
    techladderKeyEnc: encryptField(techladderKeyRef),
    techladderWebhookSecretEnc: encryptField(techladderWebhookSecretRef),
  };
}

export class MongoSettingsStore implements SettingsStore {
  constructor(private readonly col: Col) {}

  async get(externalAccountId: string): Promise<ShopSettings | null> {
    const doc = await this.col.findOne({ externalAccountId: externalAccountId.toLowerCase() });
    if (!doc) return null;
    const {
      _id: _ignored,
      techladderKeyEnc,
      techladderWebhookSecretEnc,
      ...rest
    } = doc;
    return ShopSettingsSchema.parse({
      ...rest,
      techladderKeyRef: decryptField(techladderKeyEnc ?? rest["techladderKeyRef"]),
      techladderWebhookSecretRef: decryptField(
        techladderWebhookSecretEnc ?? rest["techladderWebhookSecretRef"],
      ),
    });
  }

  async save(settings: ShopSettings): Promise<void> {
    const doc = settingsDoc(settings);
    // Do not overwrite an existing key with a blank value when the merchant
    // re-saves non-secret settings. Connect explicitly supplies a new key.
    const set: Docs = { ...doc };
    for (const field of SECRET_FIELDS) {
      const encKey = field === "techladderKeyRef" ? "techladderKeyEnc" : "techladderWebhookSecretEnc";
      if (set[encKey] === "") delete set[encKey];
      delete set[field];
    }
    await this.col.updateOne(
      { externalAccountId: doc["externalAccountId"] },
      { $set: set },
      { upsert: true },
    );
  }

  async remove(externalAccountId: string): Promise<void> {
    await this.col.deleteOne({ externalAccountId: externalAccountId.toLowerCase() });
  }
}

export async function ensureCallIndexes(col: Col): Promise<void> {
  await col.createIndex({ externalId: 1 }, { unique: true });
  await col.createIndex({ callId: 1 }, { unique: true, sparse: true });
  await col.createIndex({ batchId: 1 }, { sparse: true });
  await col.createIndex({ shop: 1, customerId: 1 }, { sparse: true });
}

function toCallRecord(doc: Docs): CallRecord {
  const { _id: _ignored, ...rest } = doc;
  return rest as unknown as CallRecord;
}

function requireDeleteMany(col: Col): (filter: Docs) => Promise<{ deletedCount: number }> {
  if (!col.deleteMany) throw new Error("Mongo collection does not implement deleteMany");
  return col.deleteMany.bind(col);
}

function requireFind(col: Col): (filter: Docs) => { toArray(): Promise<Docs[]> } {
  if (!col.find) throw new Error("Mongo collection does not implement find");
  return col.find.bind(col);
}

export class MongoCallLedger implements CallLedger {
  constructor(private readonly col: Col) {}

  async save(record: CallRecord): Promise<void> {
    await this.col.updateOne(
      { externalId: record.externalId },
      { $set: { ...record, updatedAt: new Date().toISOString() } },
      { upsert: true },
    );
  }

  async lookup(key: string): Promise<{ shop: string; orderId: string } | null> {
    const doc = await this.col.findOne({
      $or: [{ externalId: key }, { callId: key }, { batchId: key }],
    } as unknown as Docs);
    return doc ? { shop: String(doc["shop"]), orderId: String(doc["orderId"]) } : null;
  }

  async update(key: string, patch: Partial<CallRecord>): Promise<void> {
    await this.col.updateOne(
      { $or: [{ externalId: key }, { callId: key }, { batchId: key }] } as unknown as Docs,
      { $set: { ...patch, updatedAt: new Date().toISOString() } },
    );
  }

  async list(shop: string, limit = 100): Promise<CallRecord[]> {
    const docs = await requireFind(this.col)({ shop: shop.toLowerCase() }).toArray();
    return docs
      .map(toCallRecord)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit);
  }

  async deleteCustomerData(shop: string, customerId: string): Promise<void> {
    await requireDeleteMany(this.col)({ shop: shop.toLowerCase(), customerId });
  }

  async customerCallLog(shop: string, customerId: string): Promise<CallRecord[]> {
    const docs = await requireFind(this.col)({ shop: shop.toLowerCase(), customerId }).toArray();
    return docs.map(toCallRecord);
  }

  async deleteShop(shop: string): Promise<void> {
    await requireDeleteMany(this.col)({ shop: shop.toLowerCase() });
  }
}

export async function ensureEventIndexes(col: Col): Promise<void> {
  await col.createIndex({ eventId: 1 }, { unique: true });
}

export class MongoEventClaim implements EventClaim {
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

export interface SessionRecord {
  id: string;
  shop: string;
  payload: Record<string, unknown>;
  expiresAt: string;
}

export async function ensureSessionIndexes(col: Col): Promise<void> {
  await col.createIndex({ id: 1 }, { unique: true });
  await col.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
}

export class MongoSessionStore {
  constructor(private readonly col: Col) {}

  async save(session: SessionRecord): Promise<void> {
    await this.col.updateOne({ id: session.id }, { $set: session }, { upsert: true });
  }

  async get(id: string): Promise<SessionRecord | null> {
    const doc = await this.col.findOne({ id });
    if (!doc) return null;
    if (new Date(String(doc["expiresAt"])).getTime() < Date.now()) return null;
    return {
      id: String(doc["id"]),
      shop: String(doc["shop"]),
      payload: (doc["payload"] as Record<string, unknown>) ?? {},
      expiresAt: String(doc["expiresAt"]),
    };
  }

  async remove(id: string): Promise<void> {
    await this.col.deleteOne({ id });
  }
}
