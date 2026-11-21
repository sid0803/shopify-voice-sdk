import { describe, expect, it } from "vitest";
import { buildFieldMap, missingFields, resolveField } from "../src/fieldMapper.js";
import { checkCallEligibility } from "../src/consent.js";

const FIELDS = [{ apiName: "Phone" }, { apiName: "Call_Outcome" }, { apiName: "Email" }];

describe("field mapper", () => {
  it("picks the first candidate the org actually has", () => {
    expect(resolveField(FIELDS, ["Call_Outcome", "Outcome"])).toBe("Call_Outcome");
    expect(resolveField(FIELDS, ["Missing", "Also_Missing"])).toBeNull();
  });

  it("builds a logical map and reports what is missing", () => {
    const map = buildFieldMap(FIELDS, {
      outcome: ["Call_Outcome", "Outcome"],
      dnc: ["Do_Not_Call", "DNC"],
    });
    expect(map["outcome"]).toBe("Call_Outcome");
    expect(map["dnc"]).toBeNull();
    expect(missingFields(map, ["outcome", "dnc"])).toEqual(["dnc"]);
    expect(missingFields(map, ["outcome"])).toEqual([]);
  });
});

describe("consent gate", () => {
  const open = { phone: "+91 90000 00001", blockedPhones: [], crmOptOut: false, consentStatus: "granted" as const };

  it("allows verified-eligible calls", () => {
    expect(checkCallEligibility(open)).toEqual({ eligible: true, reason: "eligible" });
  });

  it("fails closed on every ineligible shape", () => {
    expect(checkCallEligibility({ ...open, phone: null }).reason).toBe("no-phone");
    expect(checkCallEligibility({ ...open, blockedPhones: ["+91 90000 00001"] }).reason).toBe("dnc");
    expect(checkCallEligibility({ ...open, blockedPhones: ["919000000001"] }).reason).toBe("dnc");
    expect(checkCallEligibility({ ...open, crmOptOut: true }).reason).toBe("crm-opt-out");
    expect(checkCallEligibility({ ...open, consentStatus: "revoked" }).reason).toBe("consent-revoked");
    expect(checkCallEligibility({ ...open, consentStatus: "unknown" }).reason).toBe("consent-unverified");
  });

  it("unverified consent passes only when explicitly not required", () => {
    expect(
      checkCallEligibility({ ...open, consentStatus: "unknown", requireExplicitConsent: false }).eligible,
    ).toBe(true);
    expect(
      checkCallEligibility({ ...open, consentStatus: "granted", requireExplicitConsent: false }).eligible,
    ).toBe(true);
  });
});
