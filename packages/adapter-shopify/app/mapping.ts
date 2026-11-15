// Pure mapping helpers for app/server.ts — unit-tested, no I/O.
// Shopify specifics stay in adapter-shopify. Core never imports this.

export function headerVal(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === name) return Array.isArray(v) ? v[0] : v;
  }
  return undefined;
}

/** Shopify marks "Send test" deliveries so dummy payloads never reach the API. */
export function isTestDelivery(headers: Record<string, string | string[] | undefined>): boolean {
  return (headerVal(headers, "x-shopify-test") ?? "").toLowerCase() === "true";
}

type UnknownRecord = Record<string, unknown>;

/** Real Shopify nests the phone 4+ levels deep — check all of them. */
export function extractPhone(payload: UnknownRecord): string | null {
  const cust = (payload["customer"] as UnknownRecord | undefined) ?? {};
  const ship = (payload["shipping_address"] as UnknownRecord | undefined) ?? {};
  const bill = (payload["billing_address"] as UnknownRecord | undefined) ?? {};
  return (
    (payload["phone"] as string | undefined) ||
    (cust["phone"] as string | undefined) ||
    (ship["phone"] as string | undefined) ||
    (bill["phone"] as string | undefined) ||
    null
  );
}

export function extractName(payload: UnknownRecord): { first?: string; last?: string } {
  const cust = (payload["customer"] as UnknownRecord | undefined) ?? {};
  return {
    first: (payload["first_name"] as string | undefined) ?? (cust["first_name"] as string | undefined),
    last: (cust["last_name"] as string | undefined),
  };
}

/** Raw *.myshopify.com domains must never be spoken aloud. */
export function friendlyStoreName(shopDomain: string, override = ""): string {
  if (override.trim()) return override.trim();
  const sub = shopDomain.split(".")[0] ?? shopDomain;
  return sub.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim() || shopDomain;
}

/** E.164-ish normalization (senior item 5). Strips trunk/punctuation noise and
 * forces an explicit + prefix (shop-country numbers are recorded as given).
 * Requires 8-15 digits. Returns null when undialable. */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.trim().replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15) return null;
  return `+${digits}`;
}

/** Calling-hours gate (senior item 5). Outside the window the order is logged
 * and skipped — never queued. Times are HH:MM in the shop's timezone. */
export function withinCallingHours(start: string, end: string, timezone: string, nowMs = Date.now()): boolean {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hour12: false })
    .formatToParts(new Date(nowMs))
    .reduce<Record<string, string>>((acc, p) => ({ ...acc, [p.type]: p.value }), {});
  const now = `${parts["hour"]}:${parts["minute"]}`;
  if (start <= end) return now >= start && now < end;
  return now >= start || now < end; // overnight window
}

/** Fresh schedule slot per order — never a hardcoded date. */
export function scheduleSlot(nowMs = Date.now(), timezone = "Asia/Kolkata"): { schedule_date: string; schedule_time: string; timezone: string } {
  const inTz = new Date(nowMs + 5 * 60 * 1000);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
    .formatToParts(inTz)
    .reduce<Record<string, string>>((acc, p) => ({ ...acc, [p.type]: p.value }), {});
  return {
    schedule_date: `${parts["year"]}-${parts["month"]}-${parts["day"]}`,
    schedule_time: `${parts["hour"]}:${parts["minute"]}`,
    timezone,
  };
}
