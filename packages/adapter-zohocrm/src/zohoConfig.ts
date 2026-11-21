// Zoho CRM constants (single place, easy review).
// Data-center domains: the org's DC is stored at connect time and the API base
// follows it. Get the DC wrong and every call 404s — never default it silently.
// API version: confirm against current Zoho CRM API docs before first deploy;
// the adapter reads this constant only, so a bump is one line.

export const ZOHO_API_VERSION = "v6";

/** Zoho CRM OAuth scopes for v1: read/write modules + settings. Least privilege. */
export const ZOHO_SCOPES = [
  "ZohoCRM.modules.ALL",
  "ZohoCRM.settings.ALL",
] as const;

/** Supported trigger modules for v1 (senior decision 1: Leads only, or +Deals). */
export const ZOHO_TRIGGER_MODULES = ["Leads", "Contacts", "Deals"] as const;

/** v1 trigger events: record created, or stuck N days (stuckDays in settings). */
export const ZOHO_TRIGGER_EVENTS = ["created", "stuck"] as const;

/** Zoho accounts host per data center (OAuth token endpoint prefix). */
export const ZOHO_ACCOUNTS_HOST: Record<string, string> = {
  in: "accounts.zoho.in",
  com: "accounts.zoho.com",
  eu: "accounts.zoho.eu",
  "com.au": "accounts.zoho.com.au",
};

/** Zoho CRM API base per data center. */
export function zohoApiBase(dataCenter: string): string {
  const tld = dataCenter === "com.au" ? "com.au" : dataCenter;
  return `https://www.zohoapis.${tld}/crm/${ZOHO_API_VERSION}`;
}
