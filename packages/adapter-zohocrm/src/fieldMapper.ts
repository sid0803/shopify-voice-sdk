// Metadata-driven field mapping (P1).
// Zoho field API names are NEVER invented here: the shell fetches them via
// client.listFields (Fields Metadata API) at connect time, and this module
// resolves logical needs onto whatever the org actually has. Missing fields
// are a config error surfaced to the merchant — never a silent skip.
export interface FieldDescriptor {
  apiName: string;
  displayLabel?: string;
  dataType?: string;
  readOnly?: boolean;
}

/**
 * Resolve one logical field from an ordered candidate list. First candidate
 * present in the org wins. Returns null when nothing matches — the caller
 * fails closed with a configuration error, not a guessed field name.
 */
export function resolveField(
  descriptors: FieldDescriptor[],
  candidates: string[],
): string | null {
  const names = new Set(descriptors.map((d) => d.apiName));
  for (const candidate of candidates) {
    if (names.has(candidate)) return candidate;
  }
  return null;
}

/** Logical needs → resolved API names (null = missing in this org). */
export function buildFieldMap(
  descriptors: FieldDescriptor[],
  logical: Record<string, string[]>,
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [key, candidates] of Object.entries(logical)) {
    out[key] = resolveField(descriptors, candidates);
  }
  return out;
}

/** Required logical keys whose resolution came back null. */
export function missingFields(
  fieldMap: Record<string, string | null>,
  required: string[],
): string[] {
  return required.filter((key) => fieldMap[key] == null);
}
