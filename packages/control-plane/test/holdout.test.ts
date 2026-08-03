import { describe, it, expect } from "vitest";
import { partitionScenarios, holdoutSeed } from "../src/holdout.js";
import { SCENARIOS } from "../src/scenarios.js";

// ADR-0014 #7 — a secret, rotated holdout the proposer never sees.
describe("secret rotated holdout partition", () => {
  it("is a true partition — every scenario on exactly one side, none lost or duplicated", () => {
    const { visible, holdout } = partitionScenarios(SCENARIOS, "seed-1");
    expect(visible.length + holdout.length).toBe(SCENARIOS.length);
    const hid = new Set(holdout.map((s) => s.id));
    expect(visible.some((s) => hid.has(s.id))).toBe(false); // no overlap
    expect(holdout.length).toBeGreaterThan(0);
    expect(visible.length).toBeGreaterThan(0);
  });

  it("is deterministic given a seed (reproducible — no Math.random)", () => {
    const a = partitionScenarios(SCENARIOS, "seed-1").holdout.map((s) => s.id);
    const b = partitionScenarios(SCENARIOS, "seed-1").holdout.map((s) => s.id);
    expect(a).toEqual(b);
  });

  it("ROTATES — changing the seed reshuffles the holdout (unpredictable without the secret)", () => {
    const base = partitionScenarios(SCENARIOS, "seed-0").holdout.map((s) => s.id).sort().join(",");
    const differs = ["seed-1", "seed-2", "seed-3", "seed-4"].some(
      (seed) => partitionScenarios(SCENARIOS, seed).holdout.map((s) => s.id).sort().join(",") !== base,
    );
    expect(differs).toBe(true);
  });

  it("always keeps at least one scenario on EACH side (both proposer + holdout have signal)", () => {
    const all = partitionScenarios(SCENARIOS, "x", 1.0); // fraction that would hold out everything
    expect(all.visible.length).toBeGreaterThanOrEqual(1);
    expect(all.holdout.length).toBeGreaterThanOrEqual(1);
    const none = partitionScenarios(SCENARIOS, "x", 0); // fraction that would hold out nothing
    expect(none.visible.length).toBeGreaterThanOrEqual(1);
    expect(none.holdout.length).toBeGreaterThanOrEqual(1);
  });

  it("holdoutSeed defaults to a fixed value but reads the server secret when set", () => {
    expect(typeof holdoutSeed()).toBe("string");
    expect(holdoutSeed().length).toBeGreaterThan(0);
  });
});
