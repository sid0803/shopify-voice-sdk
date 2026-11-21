import { describe, expect, it } from "vitest";
import {
  extractName,
  extractPhone,
  extractRecordId,
  normalizePhone,
  scheduleSlot,
  withinCallingHours,
} from "../src/mapping.js";

describe("zoho mapping", () => {
  it("extracts phone from Phone then Mobile", () => {
    expect(extractPhone({ Phone: "+91 90000 00001" })).toBe("+91 90000 00001");
    expect(extractPhone({ Mobile: "+91 90000 00002" })).toBe("+91 90000 00002");
    expect(extractPhone({})).toBeNull();
  });

  it("extracts names from parts or Full_Name", () => {
    expect(extractName({ First_Name: "Test", Last_Name: "Lead" })).toEqual({ first: "Test", last: "Lead" });
    expect(extractName({ Full_Name: "Test Lead" })).toEqual({ first: "Test", last: "Lead" });
  });

  it("extracts record id, undefined when missing", () => {
    expect(extractRecordId({ id: "987654321" })).toBe("987654321");
    expect(extractRecordId({})).toBeUndefined();
  });

  it("normalizes to E.164 with org country as default region", () => {
    expect(normalizePhone("+91 90000 00001", "IN")).toBe("+919000000001");
    expect(normalizePhone("9000000001", "IN")).toBe("+919000000001");
    expect(normalizePhone("0091 90000 00001", "IN")).toBe("+919000000001");
    expect(normalizePhone("abc")).toBeNull();
    expect(normalizePhone("123")).toBeNull();
  });

  it("gates calling hours including overnight windows", () => {
    const noonUtc = Date.UTC(2026, 0, 1, 12, 0, 0);
    expect(withinCallingHours("09:00", "21:00", "UTC", noonUtc)).toBe(true);
    expect(withinCallingHours("09:00", "10:00", "UTC", noonUtc)).toBe(false);
    const nightUtc = Date.UTC(2026, 0, 1, 23, 0, 0);
    expect(withinCallingHours("22:00", "06:00", "UTC", nightUtc)).toBe(true);
  });

  it("builds a fresh schedule slot, never hardcoded", () => {
    const slot = scheduleSlot(Date.UTC(2026, 5, 15, 8, 30, 0), "UTC");
    expect(slot).toEqual({ schedule_date: "2026-06-15", schedule_time: "08:30", timezone: "UTC" });
  });
});
