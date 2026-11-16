// Per-shop record interface (install metadata only).
// Shopify access tokens live in the template session storage (auto-refresh,
// single copy). This record intentionally does NOT store a token in the shell;
// `accessToken` remains optional for the legacy standalone connector only.
// Production stores still encrypt any token/secret they do write (KMS/envelope).

export interface ShopRecord {
  shopDomain: string;
  /** Legacy standalone connector only. The shell leaves this unset. */
  accessToken?: string;
  techladderAccountId?: string;
  scopes?: string[];
  status?: "installed" | "uninstalled" | string;
  installedAt?: string;
  uninstalledAt?: string;
}

export interface ShopStore {
  save(shop: ShopRecord): Promise<void>;
  get(shopDomain: string): Promise<ShopRecord | null>;
  remove(shopDomain: string): Promise<void>;
}

export class InMemoryShopStore implements ShopStore {
  private readonly map = new Map<string, ShopRecord>();

  async save(shop: ShopRecord): Promise<void> {
    this.map.set(shop.shopDomain.toLowerCase(), { ...shop, shopDomain: shop.shopDomain.toLowerCase() });
  }

  async get(shopDomain: string): Promise<ShopRecord | null> {
    return this.map.get(shopDomain.toLowerCase()) ?? null;
  }

  async remove(shopDomain: string): Promise<void> {
    this.map.delete(shopDomain.toLowerCase());
  }
}
