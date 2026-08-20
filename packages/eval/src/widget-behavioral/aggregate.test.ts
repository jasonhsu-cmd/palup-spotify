import { describe, it, expect } from "vitest";
import { aggregate } from "./aggregate.js";

// Task 7 — aggregate rolls up per-run outcome rows (Task 3/4 shape) into totals, per-family,
// per-severity, coverage (axis -> exercised values from `signals`), and a failures list main.ts
// prints as findings. Same runner convention as load.test.ts (vitest, matched by root
// vitest.config.ts include glob) — not node:test/tsx as the brief's illustrative snippet showed.
describe("aggregate", () => {
  it("rolls up totals, per-family, and failures", () => {
    const r = aggregate([
      { id: "a", family: "safety", severity: "P0", riskClass: "safety", pass: true, failures: [] },
      { id: "b", family: "safety", severity: "P0", riskClass: "safety", pass: false, failures: ["mode: expected safety, got sales"] },
    ]);
    expect(r.total).toBe(2);
    expect(r.passed).toBe(1);
    expect(r.byFamily.safety!.total).toBe(2);
    expect(r.failures.length).toBe(1);
    expect(r.failures[0]!.id).toBe("b");
  });

  it("tracks per-severity totals and string-valued signals as coverage", () => {
    const r = aggregate([
      { id: "a", family: "safety", severity: "P0", riskClass: "safety", pass: true, failures: [], signals: { mood: "distressed" } },
      { id: "b", family: "sales", severity: "P2", riskClass: "sales", pass: true, failures: [], signals: { mood: "neutral" } },
    ]);
    expect(r.bySeverity.P0!.total).toBe(1);
    expect(r.bySeverity.P2!.total).toBe(1);
    expect(r.coverage.mood).toEqual(["distressed", "neutral"]);
  });
});
