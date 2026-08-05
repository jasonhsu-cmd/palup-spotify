import { describe, it, expect } from "vitest";
import { computeRegressions } from "../src/regression-check.js";

// THE HOLE: a layer with very few cases could NEVER flag a regression, no matter how far it fell.
//
// The small-n noise guard requires `caseDrop >= minCaseDrop` (default 2) actual cases below the
// baseline's expected count before a below-tolerance drop counts. For a layer with ONE case the maximum
// possible caseDrop is 1, so the condition is unsatisfiable — the layer is structurally exempt from the
// regression gate.
//
// That is exactly the FAIRNESS layer: one case in the live corpus, and a committed baseline of 0.0. So
// FAIR-1 — "persona steers style only, never price/pitch/outbound", a governance invariant with its own
// ADR — could go from passing to failing on main and the gate would stay green twice over. Raising the
// baseline alone would NOT have fixed it; the guard would still have suppressed the flag.
//
// THE FIX: require `min(minCaseDrop, total)` cases. A 1-case layer needs 1 case to drop; a 10-case layer
// still needs 2, so genuine judge noise on normal layers stays suppressed exactly as before.

const R = (layer: string, pass: number, total: number) => ({
  total,
  passed: pass,
  byLayer: { [layer]: { pass, total } },
  floorFails: [] as string[],
});
const B = (layer: string, base: number) => ({ overall: 0, byLayer: { [layer]: base } });
const OPTS = { overallTol: 0.1, layerTol: 0.2 };

describe("regression check — small layers are not structurally exempt", () => {
  it("THE HOLE: a 1-case layer collapsing 100% → 0% is now flagged", () => {
    const { regressions } = computeRegressions(R("fairness", 0, 1), B("fairness", 1.0), OPTS);
    expect(regressions.join(" ")).toMatch(/fairness/);
  });

  it("a 2-case layer losing BOTH cases is flagged", () => {
    const { regressions } = computeRegressions(R("fairness", 0, 2), B("fairness", 1.0), OPTS);
    expect(regressions.join(" ")).toMatch(/fairness/);
  });

  it("NOISE STILL SUPPRESSED: a 10-case layer losing a single case is not flagged", () => {
    // base 0.9 ⇒ expected 9; 8 passed ⇒ caseDrop 1, below min(2,10)=2 ⇒ suppressed, as before.
    const { regressions } = computeRegressions(R("mood", 8, 10), B("mood", 0.9), { ...OPTS, layerTol: 0.05 });
    expect(regressions).toHaveLength(0);
  });

  it("NOISE STILL SUPPRESSED: a 10-case layer losing two cases IS flagged (guard unchanged at n=10)", () => {
    const { regressions } = computeRegressions(R("mood", 7, 10), B("mood", 0.9), { ...OPTS, layerTol: 0.05 });
    expect(regressions.join(" ")).toMatch(/mood/);
  });

  it("a healthy small layer is not flagged", () => {
    const { regressions } = computeRegressions(R("fairness", 1, 1), B("fairness", 1.0), OPTS);
    expect(regressions).toHaveLength(0);
  });

  it("a drop WITHIN tolerance is not flagged even on a small layer", () => {
    // 3 cases, base 0.67, now 0.67 — no drop at all.
    const { regressions } = computeRegressions(R("fairness", 2, 3), B("fairness", 0.67), OPTS);
    expect(regressions).toHaveLength(0);
  });
});

describe("the committed baseline must not exempt a governance layer", () => {
  it("fairness has a NON-ZERO baseline — 0.0 makes any result acceptable", async () => {
    const baseline = (await import("../../../.github/eval-baseline.json", { with: { type: "json" } })).default as {
      byLayer: Record<string, number>;
    };
    // A 0.0 baseline means "no result is a regression": `now < 0 - tol` is unsatisfiable for a rate.
    expect(baseline.byLayer.fairness).toBeGreaterThan(0);
  });

  it("the COMMITTED baseline actually flags a fairness collapse (not just a hypothetical 1.0)", async () => {
    const baseline = (await import("../../../.github/eval-baseline.json", { with: { type: "json" } })).default as {
      overall: number;
      byLayer: Record<string, number>;
    };
    // The real shape: one fairness case in the live corpus, and it fails.
    const { regressions } = computeRegressions(
      { total: 190, passed: 142, byLayer: { fairness: { pass: 0, total: 1 } }, floorFails: [] },
      baseline,
      OPTS,
    );
    expect(regressions.join(" ")).toMatch(/fairness/);
  });

  it("the COMMITTED baseline does NOT false-alarm on the observed rates it was derived from", async () => {
    const baseline = (await import("../../../.github/eval-baseline.json", { with: { type: "json" } })).default as {
      overall: number;
      byLayer: Record<string, number>;
    };
    // Worst of the three CI runs the values were read from: overall 139/190, fairness 1/1.
    const { regressions } = computeRegressions(
      { total: 190, passed: 139, byLayer: { fairness: { pass: 1, total: 1 } }, floorFails: [] },
      baseline,
      OPTS,
    );
    expect(regressions).toHaveLength(0);
  });
});
