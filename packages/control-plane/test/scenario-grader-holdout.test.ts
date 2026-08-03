import { describe, it, expect } from "vitest";
import type { ModelPort, JudgePort } from "@palup/platform-ports";
import { DEFAULT_POLICY } from "@palup/widget-brain";
import { ScenarioGrader } from "../src/scenario-grader.js";
import { SCENARIOS } from "../src/scenarios.js";
import { partitionScenarios, holdoutSeed } from "../src/holdout.js";

// ADR-0014 #7 — the grader→metrics integration (the actual acceptance criterion): a graded policy carries
// a holdoutScore + the rotation seed, and the proposer-facing perCriteria is VISIBLE-only.
const stubModel: ModelPort = { async complete() { return { text: "ok", model: "stub" }; } };
const passJudge: JudgePort = {
  async grade(input) {
    return { pass: true, score: 1, results: input.criteria.map((c) => ({ id: c.id, pass: true })) };
  },
};

describe("ScenarioGrader → holdout integration", () => {
  it("returns a holdoutScore + stamped seed, and perCriteria is VISIBLE-only (holdout never surfaced to the proposer)", async () => {
    const g = new ScenarioGrader(stubModel, passJudge, SCENARIOS);
    const m = await g.grade(DEFAULT_POLICY);

    expect(typeof m.holdoutScore).toBe("number"); // the gate's anti-overfit signal is present
    expect(m.holdoutSeed).toBe(holdoutSeed()); // stamped with the epoch so the gate compares like-for-like

    const { visible, holdout } = partitionScenarios(SCENARIOS, holdoutSeed());
    const visibleCriteria = new Set(visible.flatMap((s) => s.criteria));
    // every criterion the proposer would see (perCriteria) comes from a VISIBLE scenario
    for (const c of Object.keys(m.perCriteria ?? {})) expect(visibleCriteria.has(c)).toBe(true);
    // a criterion tested ONLY by holdout scenarios never appears in perCriteria
    const holdoutOnly = holdout.flatMap((s) => s.criteria).filter((c) => !visibleCriteria.has(c));
    for (const c of holdoutOnly) expect(m.perCriteria?.[c]).toBeUndefined();
  });
});
