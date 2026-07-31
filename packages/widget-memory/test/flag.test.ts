import { describe, it, expect } from "vitest";
import { MEMORY_ADR_ACCEPTED, isMemoryEnabled } from "../src/flag.js";

// ADR-0015 is "Proposed — NOT enacted" (CLAUDE.md §3: nothing that changes agent behavior auto-applies).
// A DOUBLE gate keeps the whole memory subsystem inert until a human-owned code change flips
// MEMORY_ADR_ACCEPTED — an operator config flag (MEMORY_ENABLED) alone can never turn it on.
describe("flag — the double gate (MEMORY_ADR_ACCEPTED AND MEMORY_ENABLED)", () => {
  it("MEMORY_ADR_ACCEPTED is hardcoded false until the ADR is Accepted", () => {
    expect(MEMORY_ADR_ACCEPTED).toBe(false);
  });

  it("default env (no MEMORY_ENABLED) → disabled", () => {
    expect(isMemoryEnabled({})).toBe(false);
  });

  it("MEMORY_ENABLED=\"true\" but MEMORY_ADR_ACCEPTED is false → STILL disabled (fail closed)", () => {
    expect(isMemoryEnabled({ MEMORY_ENABLED: "true" })).toBe(false);
  });

  it("only the exact string \"true\" would ever count — every other value is off", () => {
    for (const v of ["1", "yes", "", "TRUE", "True", "on"]) {
      expect(isMemoryEnabled({ MEMORY_ENABLED: v })).toBe(false);
    }
  });
});
