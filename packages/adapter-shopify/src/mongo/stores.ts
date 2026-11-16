// Mongo settings + calls + events + sessions (senior item 3).
import { ShopSettingsSchema, type SettingsStore, type ShopSettings } from "../settings.js";
import type { CallLedger, CallRecord, EventClaim } from "../stores.js";
import type { Col, Docs } from "./collection.js";

export async function ensureSettingsIndexes(col: Col): Promise<void> {
  await col.createIndex({ externalAccountId: 1 }, { unique: true });
}

export class MongoSettingsStore implements SettingsStore {
  constructor(private readonly col: Col) {}

  async get(externalAccountId: string): Promise<ShopSettings | null> {
    const doc = await this.col.findOne({ externalAccountId: externalAccountId.toLowerCase() });
    if (!doc) return null;
    const { _id: _ignored, ...rest } = doc;
    return ShopSettingsSchema.parse(rest);
  }

  async save(settings: ShopSettings): Promise<void> {
    const parsed = ShopSettingsSchema.parse(settings);
    await this.col.updateOne(
      { externalAccountId: parsed.externalAccountId.toLowerCase() },
      { $set: { ...parsed, externalAccountId: parsed.externalAccountId.toLowerCase() } },
      { upsert: true },
    );
  }
}

export async function ensureCallIndexes(col: Col): Promise<void> {
  await col.createIndex({ externalId: 1 }, { unique: true });
  await col.createIndex({ callId: 1 }, { unique: true, sparse: true });
}

export class MongoCallLedger implements CallLedger {
  constructor(private readonly col: Col) {}

  async save(record: CallRecord): Promise<void> {
    await this.col.updateOne({ externalId: record.externalId }, { $set: { ...record, updatedAt: new Date().toISOString() } }, { upsert: true });
  }

  async lookup(key: string): Promise<{ shop: string; orderId: string } | null> {
    const doc = await this.col.findOne({ $or: [{ externalId: key }, { callId: key }] } as unknown as Docs);
    return doc ? { shop: String(doc["shop"]), orderId: String(doc["orderId"]) } : null;
  }

  async update(key: string, patch: Partial<CallRecord>): Promise<void> {
    await this.col.updateOne(
      { $or: [{ externalId: key }, { callId: key }] } as unknown as Docs,
      { $set: { ...patch, updatedAt: new Date().toISOString() } },
    );
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
    return { id: String(doc["id"]), shop: String(doc["shop"]), payload: (doc["payload"] as Record<string, unknown>) ?? {}, expiresAt: String(doc["expiresAt"]) };
  }

  async remove(id: string): Promise<void> {
    await this.col.deleteOne({ id });
  }
}
