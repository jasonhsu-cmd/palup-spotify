import { describe, it, expect } from "vitest";
import { hasStatisticalPower, windowedVerdictFor, verdictFor, DEFAULT_CANARY_POWER } from "../src/canary-controller.js";

// ADR-0014 cond #6 / prereq #10 — a canary "≥ incumbent" is only meaningful with enough traffic over a
// long-enough window. Below the per-tenant floor the windowed verdict must NOT promote (returns
// "insufficient-power" → the orchestrator routes to human), even when the raw delta looks good. Low-
// traffic tenants therefore stay on the human path. Thresholds are conservative PLACEHOLDER defaults,
// owner-set at ADR-0014 enablement; the mechanism is what these tests lock.

describe("statistical power gate (ADR-0014 #10: no auto-promote without power)", () => {
  it("hasStatisticalPower is false below the min-N or min-window floor, true at/above both", () => {
    const { minN, minWindowMs } = DEFAULT_CANARY_POWER;
    expect(hasStatisticalPower(minN - 1, minWindowMs)).toBe(false); // too few observations
    expect(hasStatisticalPower(minN, minWindowMs - 1)).toBe(false); // window too short
    expect(hasStatisticalPower(minN, minWindowMs)).toBe(true);
  });

  it("fails CLOSED on an unreadable count/elapsed (NaN ⇒ no power ⇒ never auto-promote)", () => {
    expect(hasStatisticalPower(Number.NaN, DEFAULT_CANARY_POWER.minWindowMs)).toBe(false);
    expect(hasStatisticalPower(DEFAULT_CANARY_POWER.minN, Number.NaN)).toBe(false);
  });

  it("windowedVerdictFor returns 'insufficient-power' (NOT 'promote') at n=1 even with a good delta", () => {
    // Raw verdictFor would promote — that's the bug this gate fixes.
    expect(verdictFor(1, 0.2)).toBe("promote");
    expect(windowedVerdictFor(1, 0.2, 0)).toBe("insufficient-power");
  });

  it("blocks even with ENOUGH traffic when the observation window is too short (both floors matter)", () => {
    const { minN, minWindowMs } = DEFAULT_CANARY_POWER;
    // plenty of samples + a strong delta, but the window hasn't elapsed ⇒ still no auto-promote
    expect(windowedVerdictFor(minN, 0.2, minWindowMs - 1)).toBe("insufficient-power");
  });

  it("with power, windowedVerdictFor delegates to the raw verdict (promote / rollback / hold)", () => {
    const { minN, minWindowMs } = DEFAULT_CANARY_POWER;
    expect(windowedVerdictFor(minN, 0.2, minWindowMs)).toBe("promote");
    expect(windowedVerdictFor(minN, -0.2, minWindowMs)).toBe("rollback");
    expect(windowedVerdictFor(minN, 0.0, minWindowMs)).toBe("hold");
  });
});
