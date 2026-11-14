// Mandatory GDPR webhooks for App Store review.
// Topics: customers/data_request, customers/redact, shop/redact.
// Behavior: acknowledge fast, delete shop/customer data for redact.
// No TechLadder API call here — pure adapter concern.

import type { ShopStore } from "./shopStore.js";

export type GdprTopic = "customers/data_request" | "customers/redact" | "shop/redact" | string;

export async function handleGdprWebhook(
  topic: GdprTopic,
  shopDomain: string,
  store: ShopStore,
): Promise<{ status: number }> {
  if (topic === "shop/redact" || topic === "customers/redact") {
    await store.remove(shopDomain);
  }
  // customers/data_request: nothing to return beyond 200 for scaffold (TODO: export log).
  return { status: 200 };
}
