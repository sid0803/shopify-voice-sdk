// Per-shop token store interface (OAuth result).
// Shopify specifics stay in adapter-shopify. Core never sees tokens.
// Production store must encrypt accessToken at rest (TODO: KMS/envelope).

export interface ShopRecord {
  // Source of truth for Shopify tokens is the template session storage
  // (auto-refresh, single copy). This record keeps the TechLadder sk_ ref
  // and shop metadata only — never a token copy, so nothing can drift.
  shopDomain: string;
  accessToken: string;
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
