// Mongo shops collection (senior items 3+4). Secrets are encrypted at rest;
// plaintext rows must never exist outside explicitly local test fakes.
import type { ShopRecord, ShopStore } from "../shopStore.js";
import { decryptSecret, encryptSecret } from "./crypto.js";
import type { Col, Docs } from "./collection.js";

export interface MongoShopDoc extends Docs {
  shopDomain: string;
  accessTokenEnc: string;
  refreshTokenEnc: string;
  tokenExpiresAt: string | null;
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
    accessTokenEnc: encryptSecret(shop.accessToken),
    refreshTokenEnc: shop.refreshToken ? encryptSecret(shop.refreshToken) : "",
    tokenExpiresAt: shop.tokenExpiresAt ?? null,
    techladderKeyEnc: encryptSecret(shop.techladderAccountId ?? ""),
    scopes: [],
    status: "active",
    installedAt: shop.installedAt ?? new Date().toISOString(),
    uninstalledAt: null,
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
    return {
      shopDomain: doc.shopDomain,
      accessToken: decryptSecret(doc.accessTokenEnc),
      ...(techladderAccountId ? { techladderAccountId } : {}),
      ...(doc.refreshTokenEnc ? { refreshToken: decryptSecret(doc.refreshTokenEnc) } : {}),
      ...(doc.tokenExpiresAt ? { tokenExpiresAt: doc.tokenExpiresAt } : {}),
      installedAt: doc.installedAt,
    };
  }

  async remove(shopDomain: string): Promise<void> {
    await this.col.updateOne(
      { shopDomain: shopDomain.toLowerCase() },
      { $set: { status: "uninstalled", uninstalledAt: new Date().toISOString(), accessTokenEnc: "", refreshTokenEnc: "", tokenExpiresAt: null, techladderKeyEnc: "" } },
    );
  }
}
