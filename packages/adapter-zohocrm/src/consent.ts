// Call-eligibility gate (P1). Runs BEFORE any outbound call attempt and FAILS
// CLOSED: unknown consent, missing phone, or any opt-out blocks the call.
// Layer 1 (Zoho DND/consent fields) is resolved by the P2 shell from mapped
// fields and passed in as plain booleans — this module holds the decision
// policy, not field-name knowledge. Layer 2 is TechLadder suppression.
// Layer 3 is the verdict below. A populated phone number is never treated as
// permission to call.
export type ConsentStatus = "granted" | "revoked" | "unknown";

export interface EligibilityInput {
  phone: string | null;
  /** Merchant DND list (E.164). Digits compared, formatting ignored. */
  blockedPhones: string[];
  /** Opt-out resolved from the Zoho record's DND/consent fields. */
  crmOptOut: boolean;
  consentStatus?: ConsentStatus;
  /** When true, only explicit "granted" proceeds. Default true (fail closed). */
  requireExplicitConsent?: boolean;
}

export interface Eligibility {
  eligible: boolean;
  reason: "eligible" | "no-phone" | "dnc" | "crm-opt-out" | "consent-revoked" | "consent-unverified";
}

function digitsOnly(value: string): string {
  return value.replace(/\D/g, "");
}

export function checkCallEligibility(input: EligibilityInput): Eligibility {
  if (!input.phone) return { eligible: false, reason: "no-phone" };
  const blocked = new Set(input.blockedPhones.map(digitsOnly));
  if (blocked.has(digitsOnly(input.phone))) return { eligible: false, reason: "dnc" };
  if (input.crmOptOut) return { eligible: false, reason: "crm-opt-out" };
  const status: ConsentStatus = input.consentStatus ?? "unknown";
  if (status === "revoked") return { eligible: false, reason: "consent-revoked" };
  const requireExplicit = input.requireExplicitConsent ?? true;
  if (requireExplicit && status !== "granted") return { eligible: false, reason: "consent-unverified" };
  return { eligible: true, reason: "eligible" };
}
