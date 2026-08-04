import { describe, it, expect } from "vitest";
import { decideMemoryWrite, mergeConsentTier, mergeAccountConsent } from "../src/consent.js";

// ADR-0015 Inv 3 (EU-consent-gated, fail-closed) + Inv 9 (special-category ALWAYS needs its own
// explicit consent, independent of region and of Consent 1). Pure decision table, no I/O.
describe("consent — decideMemoryWrite (fail-closed by region; Consent 2 independent everywhere)", () => {
  it("eu + consent1 unknown → ordinary NOT allowed (fail closed)", () => {
    const cap = decideMemoryWrite({ region: "eu", consent1: "unknown", consent2: "unknown" });
    expect(cap.mayWriteOrdinary).toBe(false);
  });

  it("region undefined behaves exactly like eu — fail closed", () => {
    const capUnknownRegion = decideMemoryWrite({ consent1: "unknown", consent2: "unknown" });
    const capEu = decideMemoryWrite({ region: "eu", consent1: "unknown", consent2: "unknown" });
    expect(capUnknownRegion.mayWriteOrdinary).toBe(false);
    expect(capUnknownRegion.mayWriteOrdinary).toBe(capEu.mayWriteOrdinary);
  });

  it("eu + consent1 'in' → ordinary allowed", () => {
    expect(decideMemoryWrite({ region: "eu", consent1: "in", consent2: "unknown" }).mayWriteOrdinary).toBe(true);
  });

  it("us + consent1 unknown → ordinary allowed (opt-out regime, not yet opted out)", () => {
    expect(decideMemoryWrite({ region: "us", consent1: "unknown", consent2: "unknown" }).mayWriteOrdinary).toBe(true);
  });

  it("us + consent1 'out' → ordinary NOT allowed", () => {
    expect(decideMemoryWrite({ region: "us", consent1: "out", consent2: "unknown" }).mayWriteOrdinary).toBe(false);
  });

  it("uk and other are explicit-consent-required, exactly like eu", () => {
    for (const region of ["uk", "other"] as const) {
      const cap = decideMemoryWrite({ region, consent1: "unknown", consent2: "unknown" });
      expect(cap.mayWriteOrdinary).toBe(false);
      expect(decideMemoryWrite({ region, consent1: "in", consent2: "unknown" }).mayWriteOrdinary).toBe(true);
    }
  });

  it("consent2 'in' + consent1 'out' → special allowed, ordinary NOT (Consent 2 is INDEPENDENT)", () => {
    const cap = decideMemoryWrite({ region: "us", consent1: "out", consent2: "in" });
    expect(cap.mayWriteSpecial).toBe(true);
    expect(cap.mayWriteOrdinary).toBe(false);
  });

  it("consent2 'unknown' → special NOT allowed in ANY region, including us (fail closed, Inv 9)", () => {
    for (const region of ["us", "eu", "uk", "other", undefined] as const) {
      expect(decideMemoryWrite({ region, consent1: "in", consent2: "unknown" }).mayWriteSpecial).toBe(false);
    }
  });

  it("consent2 'out' → special NOT allowed", () => {
    expect(decideMemoryWrite({ region: "us", consent1: "in", consent2: "out" }).mayWriteSpecial).toBe(false);
  });

  it("carries a human-readable reason string", () => {
    const cap = decideMemoryWrite({ region: "eu", consent1: "unknown", consent2: "unknown" });
    expect(typeof cap.reason).toBe("string");
    expect(cap.reason.length).toBeGreaterThan(0);
  });
});

// BLOCK-1 (security-review remediation, PR #152) — restrictive-merge across the guest/account subjects
// on sign-in. See consent.ts's own doc comment on `mergeConsentTier` for the full rationale.
describe("mergeConsentTier — most-restrictive-wins across account/guest records", () => {
  it("an 'out' on the GUEST side wins even when the account record is 'unknown' (THE REVIEWER'S SCENARIO)", () => {
    expect(mergeConsentTier("unknown", "out")).toBe("out");
  });

  it("an 'out' on the ACCOUNT side wins even when the guest record is 'in'", () => {
    expect(mergeConsentTier("out", "in")).toBe("out");
  });

  it("both 'out' -> 'out'", () => {
    expect(mergeConsentTier("out", "out")).toBe("out");
  });

  it("a guest 'in' is NEVER adopted for the account — account 'unknown' + guest 'in' -> 'unknown', not 'in'", () => {
    expect(mergeConsentTier("unknown", "in")).toBe("unknown");
  });

  it("the account's OWN 'in' is honored regardless of the guest value", () => {
    expect(mergeConsentTier("in", "unknown")).toBe("in");
    expect(mergeConsentTier("in", "in")).toBe("in");
  });

  it("no guest value supplied (undefined) -> the account record alone governs", () => {
    expect(mergeConsentTier("unknown", undefined)).toBe("unknown");
    expect(mergeConsentTier("in", undefined)).toBe("in");
    expect(mergeConsentTier("out", undefined)).toBe("out");
  });

  it("both unknown -> unknown", () => {
    expect(mergeConsentTier("unknown", "unknown")).toBe("unknown");
  });
});

describe("mergeAccountConsent — applies the restrictive merge independently to both tiers", () => {
  it("merges memoryOrdinary and memorySpecial independently", () => {
    const merged = mergeAccountConsent(
      { memoryOrdinary: "unknown", memorySpecial: "in" },
      { memoryOrdinary: "out", memorySpecial: "out" },
    );
    expect(merged).toEqual({ memoryOrdinary: "out", memorySpecial: "out" });
  });

  it("no guest record -> the account record is returned unchanged", () => {
    const account = { memoryOrdinary: "in", memorySpecial: "unknown" } as const;
    expect(mergeAccountConsent(account, undefined)).toEqual(account);
  });
});
