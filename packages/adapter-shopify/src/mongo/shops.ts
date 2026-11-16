// Mongo shops collection (senior items 3+4). Secrets are encrypted at rest;
// plaintext rows must never exist outside explicitly local test fakes.
import type { ShopRecord, ShopStore } from "../shopStore.js";
import { decryptSecret, encryptSecret } from "./crypto.js";
import type { Col, Docs } from "./collection.js";

export interface MongoShopDoc extends Docs {
  shopDomain: string;
  accessTokenEnc: string;
  techladderKeyEnc: string;
  scopes: string[];
  status: string;
  installedAt: string;
  uninstalledAt: string | null;
}

export async function ensureShopIndexes(col: Col): Promise<void> {
  await col.createIndex({ shopDomain: 1 }, { unique: true });
}

function toDoc(shop: ShopRecord): MongoShopDoc {
  return {
    shopDomain: shop.shopDomain.toLowerCase(),
    accessTokenEnc: shop.accessToken ? encryptSecret(shop.accessToken) : "",
    techladderKeyEnc: shop.techladderAccountId ? encryptSecret(shop.techladderAccountId) : "",
    scopes: shop.scopes ?? [],
    status: shop.status ?? "installed",
    installedAt: shop.installedAt ?? new Date().toISOString(),
    uninstalledAt: shop.uninstalledAt ?? null,
  };
}

export class MongoShopStore implements ShopStore {
  constructor(private readonly col: Col) {}

  async save(shop: ShopRecord): Promise<void> {
    const doc = toDoc(shop);
    await this.col.updateOne({ shopDomain: doc.shopDomain }, { $set: doc }, { upsert: true });
  }

  async get(shopDomain: string): Promise<ShopRecord | null> {
    const doc = (await this.col.findOne({ shopDomain: shopDomain.toLowerCase() })) as MongoShopDoc | null;
    if (!doc || doc.uninstalledAt) return null;
    const techladderAccountId = doc.techladderKeyEnc ? decryptSecret(doc.techladderKeyEnc) : "";
    const accessToken = doc.accessTokenEnc ? decryptSecret(doc.accessTokenEnc) : "";
    return {
      shopDomain: doc.shopDomain,
      ...(accessToken ? { accessToken } : {}),
      ...(techladderAccountId ? { techladderAccountId } : {}),
      scopes: doc.scopes,
      status: doc.status,
      installedAt: doc.installedAt,
    };
  }

  async remove(shopDomain: string): Promise<void> {
    const now = new Date().toISOString();
    await this.col.updateOne(
      { shopDomain: shopDomain.toLowerCase() },
      {
        $set: {
          status: "uninstalled",
          uninstalledAt: now,
          accessTokenEnc: "",
          techladderKeyEnc: "",
        },
      },
    );
  }
}
