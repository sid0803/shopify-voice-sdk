// Shared shop metadata + settings loading for the embedded admin routes.
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import {
  defaultSettings,
  type ShopSettings,
} from "@techladder/adapter-shopify";
import { getStores } from "./stores.server.js";

export interface ShopInfo {
  timezone: string;
  country?: string;
}

export async function loadShopInfo(admin: AdminApiContext): Promise<ShopInfo> {
  try {
    const res = await admin.graphql(
      `#graphql
      query TechLadderShopInfo {
        shop {
          ianaTimezone
          billingAddress { countryCodeV2 }
        }
      }`,
    );
    const json = (await res.json()) as {
      data?: {
        shop?: { ianaTimezone?: string; billingAddress?: { countryCodeV2?: string } | null };
      };
    };
    const shop = json.data?.shop;
    return {
      timezone: shop?.ianaTimezone || "UTC",
      ...(shop?.billingAddress?.countryCodeV2
        ? { country: shop.billingAddress.countryCodeV2 }
        : {}),
    };
  } catch {
    return { timezone: "UTC" };
  }
}

/** First-save defaults use Shopify's timezone/country, never a repo literal. */
export async function ensureSettings(shop: string, info: ShopInfo): Promise<ShopSettings> {
  const stores = await getStores();
  const existing = await stores.settings.get(shop);
  if (existing) return existing;
  const created = {
    ...defaultSettings(shop),
    callingHours: {
      start: "09:00",
      end: "21:00",
      timezone: info.timezone || "UTC",
    },
    ...(info.country ? { shopCountry: info.country } : {}),
  };
  await stores.settings.save(created);
  return created;
}
