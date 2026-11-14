// Shopify app constants (single place, easy review).
// apiVersion matches Partners dashboard dropdown (2026-10) — senior confirmed display value;
// keep here so a version bump is one line + test.

export const SHOPIFY_API_VERSION = "2026-10";

export const SHOPIFY_SCOPES = ["read_orders", "write_orders", "read_checkouts"] as const;

export const SHOPIFY_WEBHOOK_TOPICS = [
  "orders/create",
  "orders/updated",
  "checkouts/create",
  "checkouts/update",
  "carts/update",
  "app/uninstalled",
] as const;

export const SHOPIFY_GDPR_TOPICS = [
  "customers/data_request",
  "customers/redact",
  "shop/redact",
] as const;
