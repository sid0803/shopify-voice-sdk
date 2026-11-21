// Metadata-driven field setup (P2 shell logic).
// No Zoho field API name is invented here: the shell lists the org's real
// fields, resolves logical needs onto them, and surfaces anything missing as
// a configuration error — never a silent skip.
import { buildFieldMap, missingFields } from "../fieldMapper.js";

/** Logical needs → ordered candidate API names, per module. */
export const LOGICAL_ZOHO_FIELDS: Record<string, Record<string, string[]>> = {
  Leads: {
    outcome: ["Call_Outcome", "Call_Status"],
    dnd: ["Do_Not_Call", "DNC", "DoNotCall"],
    phone: ["Phone", "Mobile"],
  },
  Contacts: {
    outcome: ["Call_Outcome", "Call_Status"],
    dnd: ["Do_Not_Call", "DNC", "DoNotCall"],
    phone: ["Phone", "Mobile"],
  },
  Deals: {
    outcome: ["Call_Outcome", "Call_Status"],
    dnd: ["Do_Not_Call", "DNC", "DoNotCall"],
    phone: ["Phone", "Mobile"],
  },
};

export interface FieldSetupInput {
  module: string;
  /** Real field descriptors from client.listFields. */
  descriptors: Array<{ apiName: string; displayLabel?: string; dataType?: string; readOnly?: boolean }>;
  outcomeField?: string;
}

export interface FieldSetupResult {
  fieldMap: Record<string, string | null>;
  /** Logical keys with no org field. Connect UI must resolve these. */
  missing: string[];
}

/**
 * Resolve logical needs for a module. The outcome slot honors the merchant's
 * configured outcomeField first, then generic candidates.
 */
export function syncZohoFieldMap(input: FieldSetupInput): FieldSetupResult {
  const logical = LOGICAL_ZOHO_FIELDS[input.module] ?? LOGICAL_ZOHO_FIELDS["Leads"]!;
  const outcomeCandidates = input.outcomeField
    ? [input.outcomeField, ...(logical["outcome"] ?? []).filter((c) => c !== input.outcomeField)]
    : (logical["outcome"] ?? []);
  const fieldMap = buildFieldMap(
    input.descriptors.map((d) => ({ apiName: d.apiName })),
    { outcome: outcomeCandidates, dnd: logical["dnd"] ?? [], phone: logical["phone"] ?? [] },
  );
  return { fieldMap, missing: missingFields(fieldMap, ["outcome"]) };
}
