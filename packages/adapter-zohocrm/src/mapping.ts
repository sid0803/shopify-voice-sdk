// Pure mapping helpers — unit-tested, no I/O.
// Zoho specifics stay in adapter-zohocrm. Core never imports this.

export function headerVal(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === name) return Array.isArray(v) ? v[0] : v;
  }
  return undefined;
}

type UnknownRecord = Record<string, unknown>;

/** Zoho keeps the dialable number in Phone and/or Mobile — check both. */
export function extractPhone(payload: UnknownRecord): string | null {
  return (
    (payload["Phone"] as string | undefined) ||
    (payload["Mobile"] as string | undefined) ||
    (payload["phone"] as string | undefined) ||
    null
  );
}

export function extractName(payload: UnknownRecord): { first?: string; last?: string } {
  const full = payload["Full_Name"] as string | undefined;
  if (!payload["First_Name"] && !payload["Last_Name"] && full) {
    const [first, ...rest] = full.split(" ");
    return { first, last: rest.join(" ") || undefined };
  }
  return {
    first: (payload["First_Name"] as string | undefined) ?? undefined,
    last: (payload["Last_Name"] as string | undefined) ?? undefined,
  };
}

/** Zoho record id, used for write-back, ledger identity and delete scoping. */
export function extractRecordId(payload: UnknownRecord): string | undefined {
  const id = payload["id"];
  if (id === undefined || id === null || id === "") return undefined;
  return String(id);
}

/** Country dialing codes used only as a default region for national-format
 * numbers. Extend deliberately; unknown countries fall back to the recorded
 * digits with a + prefix (never silently invent a country). */
const COUNTRY_CALLING_CODE: Record<string, string> = {
  US: "1",
  CA: "1",
  GB: "44",
  IN: "91",
  AU: "61",
  AE: "971",
  SG: "65",
  DE: "49",
  FR: "33",
  BR: "55",
  MX: "52",
  ZA: "27",
  NZ: "64",
  JP: "81",
  KR: "82",
  ID: "62",
  PH: "63",
  MY: "60",
  SA: "966",
  NG: "234",
  KE: "254",
  PK: "92",
  BD: "880",
  LK: "94",
  NP: "977",
};

/** E.164 normalization. `+`/`00` prefixes are preserved; national-format
 * numbers use the org country as the default region. Requires 8-15 digits.
 * Returns null when undialable. */
export function normalizePhone(
  raw: string | null | undefined,
  defaultCountry?: string | null,
): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  let digits = trimmed.replace(/\D/g, "");
  if (!digits) return null;
  if (trimmed.startsWith("+")) {
    // Already international.
  } else if (trimmed.startsWith("00")) {
    digits = digits.slice(2);
  } else if (defaultCountry) {
    const code = COUNTRY_CALLING_CODE[defaultCountry.toUpperCase()];
    if (code) {
      const national = digits.replace(/^0+/, "");
      // Country code 1 is ambiguous (US/CA national numbers can start with 1),
      // so only treat it as international at the full 11-digit length.
      const alreadyInternational =
        national.startsWith(code) &&
        national.length >= (code === "1" ? 11 : code.length + 9);
      digits = alreadyInternational ? national : `${code}${national}`;
    }
  }
  if (digits.length < 8 || digits.length > 15) return null;
  return `+${digits}`;
}

/** Calling-hours gate. Outside the window the record is logged and skipped —
 * never queued. Times are HH:MM in the supplied timezone. */
export function withinCallingHours(start: string, end: string, timezone: string, nowMs = Date.now()): boolean {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hour12: false })
    .formatToParts(new Date(nowMs))
    .reduce<Record<string, string>>((acc, p) => ({ ...acc, [p.type]: p.value }), {});
  const now = `${parts["hour"]}:${parts["minute"]}`;
  if (start <= end) return now >= start && now < end;
  return now >= start || now < end; // overnight window
}

/** Fresh schedule slot per record — never a hardcoded date. */
export function scheduleSlot(nowMs = Date.now(), timezone = "UTC"): { schedule_date: string; schedule_time: string; timezone: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
    .formatToParts(new Date(nowMs))
    .reduce<Record<string, string>>((acc, p) => ({ ...acc, [p.type]: p.value }), {});
  return {
    schedule_date: `${parts["year"]}-${parts["month"]}-${parts["day"]}`,
    schedule_time: `${parts["hour"]}:${parts["minute"]}`,
    timezone,
  };
}
