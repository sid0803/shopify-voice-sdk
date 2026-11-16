// Per-shop token store interface (OAuth result).
// Shopify specifics stay in adapter-shopify. Core never sees tokens.
// Production store must encrypt accessToken at rest (TODO: KMS/envelope).

export interface ShopRecord {
  shopDomain: string;
  accessToken: string;
  /** Expiring offline tokens rotate hourly (docs: access-tokens page) — the
   * shell refreshes via the template and rewrites both fields atomically. */
  refreshToken?: string;
  tokenExpiresAt?: string;
  techladderAccountId?: string;
  scopes?: string[];
  installedAt?: string;
}

export interface ShopStore {
  save(shop: ShopRecord): Promise<void>;
  get(shopDomain: string): Promise<ShopRecord | null>;
  remove(shopDomain: string): Promise<void>;
}

export class InMemoryShopStore implements ShopStore {
  private readonly map = new Map<string, ShopRecord>();

  async save(shop: ShopRecord): Promise<void> {
    this.map.set(shop.shopDomain.toLowerCase(), shop);
  }

  async get(shopDomain: string): Promise<ShopRecord | null> {
    return this.map.get(shopDomain.toLowerCase()) ?? null;
  }

  async remove(shopDomain: string): Promise<void> {
    this.map.delete(shopDomain.toLowerCase());
  }
}
