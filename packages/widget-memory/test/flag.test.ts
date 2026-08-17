import { describe, it, expect } from "vitest";
import { MEMORY_ADR_ACCEPTED, isMemoryEnabled } from "../src/flag.js";

// ADR-0015 was Accepted for INTERNAL STAGING on 2026-08-17 (internal users only; legal DEFERRED as a
// named-owner-accepted risk; security-reviewer PASS-WITH-CONDITIONS recorded at MEMORY-GO-LIVE-CHECKLIST
// A4), so the build-time gate MEMORY_ADR_ACCEPTED is now true and the SECOND lock is spent: MEMORY_ENABLED
// alone governs whether memory runs. The remaining fail-closed guarantee is the ENV half — only the exact
// string "true" enables it — so a build with MEMORY_ENABLED unset (production, deployed nowhere) stays
// fully inert. This is NOT external/production go-live: the legal items stay OPEN (see the ADR / checklist).
describe("flag — memory gate (ADR Accepted for internal staging; MEMORY_ENABLED alone governs)", () => {
  it("MEMORY_ADR_ACCEPTED is true — ADR-0015 Accepted for internal staging (2026-08-17)", () => {
    expect(MEMORY_ADR_ACCEPTED).toBe(true);
  });

  it("default env (no MEMORY_ENABLED) → disabled — memory stays OFF wherever the operator flag is unset", () => {
    expect(isMemoryEnabled({})).toBe(false);
  });

  it("MEMORY_ENABLED=\"true\" → enabled — with the ADR gate Accepted, the operator flag now governs", () => {
    expect(isMemoryEnabled({ MEMORY_ENABLED: "true" })).toBe(true);
  });

  it("only the exact string \"true\" counts — every other value is off (the load-bearing fail-closed gate)", () => {
    for (const v of ["1", "yes", "", "TRUE", "True", "on"]) {
      expect(isMemoryEnabled({ MEMORY_ENABLED: v })).toBe(false);
    }
  });
});
