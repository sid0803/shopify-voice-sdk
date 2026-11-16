// Shopify session storage backed by Mongo. Tokens are encrypted at rest by
// storing the whole serialized session through the envelope-encryption helper.
//
// The shell passes Shopify's `Session` class as the revive function, so this
// package never imports Shopify (core/adapter stay platform-neutral enough to
// build without the app framework installed).
import { decryptSecret, encryptSecret } from "./crypto.js";
import type { Col, Docs } from "./collection.js";

export interface ShopifySessionLike {
  id: string;
  shop: string;
  expires?: Date;
  toObject(): Record<string, unknown>;
}

export interface ShopifySessionStorageLike<T extends ShopifySessionLike> {
  storeSession(session: T): Promise<boolean>;
  loadSession(id: string): Promise<T | undefined>;
  deleteSession(id: string): Promise<boolean>;
  deleteSessions(ids: string[]): Promise<boolean>;
  findSessionsByShop(shop: string): Promise<T[]>;
}

type ColProvider = () => Promise<Col>;
type Revive<T> = (payload: Record<string, unknown>) => T;

export async function ensureShopifySessionIndexes(col: Col): Promise<void> {
  await col.createIndex({ id: 1 }, { unique: true });
  await col.createIndex({ shop: 1 });
  await col.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
}

export class MongoShopifySessionStorage<T extends ShopifySessionLike>
  implements ShopifySessionStorageLike<T>
{
  constructor(
    private readonly getCol: ColProvider,
    private readonly revive: Revive<T>,
  ) {}

  private async col(): Promise<Col> {
    return this.getCol();
  }

  async storeSession(session: T): Promise<boolean> {
    const expiresAt = session.expires ? new Date(session.expires).toISOString() : undefined;
    await (
      await this.col()
    ).updateOne(
      { id: session.id },
      {
        $set: {
          id: session.id,
          shop: session.shop.toLowerCase(),
          payloadEnc: encryptSecret(JSON.stringify(session.toObject())),
          ...(expiresAt ? { expiresAt } : {}),
          updatedAt: new Date().toISOString(),
        },
      },
      { upsert: true },
    );
    return true;
  }

  async loadSession(id: string): Promise<T | undefined> {
    const doc = await (await this.col()).findOne({ id });
    if (!doc) return undefined;
    return this.revive(JSON.parse(decryptSecret(String(doc["payloadEnc"]))) as Record<string, unknown>);
  }

  async deleteSession(id: string): Promise<boolean> {
    await (await this.col()).deleteOne({ id });
    return true;
  }

  async deleteSessions(ids: string[]): Promise<boolean> {
    const col = await this.col();
    if (!col.deleteMany) throw new Error("Mongo collection does not implement deleteMany");
    await col.deleteMany({ id: { $in: ids } } as unknown as Docs);
    return true;
  }

  async findSessionsByShop(shop: string): Promise<T[]> {
    const col = await this.col();
    if (!col.find) throw new Error("Mongo collection does not implement find");
    const docs = await col.find({ shop: shop.toLowerCase() }).toArray();
    return docs.map((doc) =>
      this.revive(JSON.parse(decryptSecret(String(doc["payloadEnc"]))) as Record<string, unknown>),
    );
  }
}
