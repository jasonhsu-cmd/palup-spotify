import { describe, it, expect } from "vitest";
import { computeRegressions, type Baseline, type LiveReport } from "../src/regression-check.js";

// Pure no-regression gate logic (pnpm eval:regression). baseline.overall 60%, safety 90%, accuracy 50%.
const baseline: Baseline = { overall: 0.6, byLayer: { safety: 0.9, accuracy: 0.5 } };
const TOL = { overallTol: 0.1, layerTol: 0.2 }; // fail if overall < 50% or a layer > 20pp below its base

describe("computeRegressions — no-regression tolerance gate (deterministic, no I/O)", () => {
  it("passes when overall and every layer are within tolerance", () => {
    const report: LiveReport = {
      passed: 55, total: 100, // 55% ≥ 50% floor
      byLayer: { safety: { pass: 80, total: 100 }, accuracy: { pass: 45, total: 100 } }, // 80%≥70%, 45%≥30%
      floorFails: [],
    };
    expect(computeRegressions(report, baseline, TOL).regressions).toEqual([]);
  });

  it("flags an overall regression when overall drops more than overallTol below baseline", () => {
    const report: LiveReport = {
      passed: 40, total: 100, // 40% < 60%−10% = 50%
      byLayer: { safety: { pass: 85, total: 100 }, accuracy: { pass: 45, total: 100 } },
      floorFails: [],
    };
    const { regressions } = computeRegressions(report, baseline, TOL);
    expect(regressions.some((r) => r.startsWith("overall"))).toBe(true);
    expect(regressions.some((r) => r.startsWith("safety") || r.startsWith("accuracy"))).toBe(false);
  });

  it("flags a layer regression when a single layer drops more than layerTol below its baseline", () => {
    const report: LiveReport = {
      passed: 60, total: 100, // overall fine
      byLayer: { safety: { pass: 60, total: 100 }, accuracy: { pass: 45, total: 100 } }, // safety 60% < 90%−20% = 70%
      floorFails: [],
    };
    const { regressions } = computeRegressions(report, baseline, TOL);
    expect(regressions.some((r) => r.startsWith("safety"))).toBe(true);
    expect(regressions.some((r) => r.startsWith("overall"))).toBe(false);
  });

  it("flags any safety/injection floor fail regardless of rates", () => {
    const report: LiveReport = {
      passed: 60, total: 100,
      byLayer: { safety: { pass: 90, total: 100 }, accuracy: { pass: 50, total: 100 } },
      floorFails: ["SX-01"],
    };
    const { regressions } = computeRegressions(report, baseline, TOL);
    expect(regressions.some((r) => r.includes("floor fails"))).toBe(true);
  });

  it("ignores layers not present in the baseline (no false regression)", () => {
    const report: LiveReport = {
      passed: 60, total: 100,
      byLayer: { safety: { pass: 90, total: 100 }, brandnew: { pass: 0, total: 100 } }, // brandnew not in baseline
      floorFails: [],
    };
    expect(computeRegressions(report, baseline, TOL).regressions).toEqual([]);
  });

  // Small-layer noise guard (minCaseDrop, default 2): a stochastic judge flips single cases run-to-run,
  // so a tiny layer can breach layerTol from ONE flip. That must not trip the gate.
  const smallBase: Baseline = { overall: 0.6, byLayer: { identity: 0.66 } }; // ~2/3 expected

  it("does NOT flag a tiny layer that drops one case below its baseline (within noise)", () => {
    const report: LiveReport = {
      passed: 60, total: 100,
      byLayer: { identity: { pass: 1, total: 3 } }, // 33% < 66%−20% = 46%, but only 1 case below expected (2)
      floorFails: [],
    };
    expect(computeRegressions(report, smallBase, TOL).regressions).toEqual([]);
  });

  it("DOES flag a tiny layer that collapses by ≥2 cases (real drop, not noise)", () => {
    const report: LiveReport = {
      passed: 60, total: 100,
      byLayer: { identity: { pass: 0, total: 3 } }, // 0% — 2 cases below expected (2)
      floorFails: [],
    };
    const { regressions } = computeRegressions(report, smallBase, TOL);
    expect(regressions.some((r) => r.startsWith("identity"))).toBe(true);
  });
});
