// Shopify app constants (single place, easy review).
// apiVersion matches the Partners dashboard / shopify.app.toml value.
// Keep both files in sync; a version bump is one line + the config.

export const SHOPIFY_API_VERSION = "2026-10";

/** v1: read orders + write tags. No checkout/cart scopes. */
export const SHOPIFY_SCOPES = ["read_orders", "write_orders"] as const;

/** v1 webhook scope (senior item 2): orders/create only, never updates. */
export const SHOPIFY_WEBHOOK_TOPICS = ["orders/create", "app/uninstalled"] as const;

export const SHOPIFY_GDPR_TOPICS = [
  "customers/data_request",
  "customers/redact",
  "shop/redact",
] as const;

export const SHOPIFY_ALL_WEBHOOK_TOPICS = [
  ...SHOPIFY_WEBHOOK_TOPICS,
  ...SHOPIFY_GDPR_TOPICS,
] as const;
