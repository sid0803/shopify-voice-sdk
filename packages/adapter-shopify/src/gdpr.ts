// Mandatory GDPR + uninstall handling (senior item 2).
// customers/redact: delete THAT customer's data only, never the shop.
// shop/redact: delete the shop. customers/data_request: export the customer's
// call log. app/uninstalled: revoke the token and stop calling.
import type { ShopStore } from "./shopStore.js";

export type GdprTopic = "customers/data_request" | "customers/redact" | "shop/redact" | "app/uninstalled" | string;

export interface GdprStore extends ShopStore {
  deleteCustomerData?(shopDomain: string, customerId: string): Promise<void> | void;
  customerCallLog?(shopDomain: string, customerId: string): Promise<unknown> | unknown;
}

function customerIdOf(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) return "";
  const p = payload as Record<string, unknown>;
  const c = p["customer"] as Record<string, unknown> | undefined;
  return String(c?.["id"] ?? p["customer_id"] ?? "");
}

export async function handleGdprWebhook(
  topic: GdprTopic,
  shopDomain: string,
  store: GdprStore,
  payload: unknown = {},
): Promise<{ status: number; body: unknown }> {
  const shop = shopDomain.toLowerCase();
  if (topic === "shop/redact" || topic === "app/uninstalled") {
    await store.remove(shop);
    return { status: 200, body: { deleted_shop: shop } };
  }
  if (topic === "customers/redact") {
    const customerId = customerIdOf(payload);
    if (store.deleteCustomerData && customerId) await store.deleteCustomerData(shop, customerId);
    return { status: 200, body: { deleted_customer: customerId || true } };
  }
  if (topic === "customers/data_request") {
    const customerId = customerIdOf(payload);
    const log = store.customerCallLog && customerId ? await store.customerCallLog(shop, customerId) : [];
    return { status: 200, body: { customer_id: customerId, calls: log ?? [] } };
  }
  return { status: 200, body: {} };
}
