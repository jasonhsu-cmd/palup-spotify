import { describe, it, expect } from "vitest";
import { decideMemoryWrite } from "../src/consent.js";

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
