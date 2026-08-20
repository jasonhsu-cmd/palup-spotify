import { describe, it, expect } from "vitest";
import { runSingle } from "./run-single.js";

// Task 3: single-turn runner + brain factory. This file asserts HARNESS MECHANICS only — that
// runSingle actually invokes the brain and returns a well-formed CaseOutcome. It does NOT encode
// any agent behavioral/safety bar as pass/fail: that bar lives in the corpus
// (packages/eval/cases/widget-behavioral.json), which a later task (main.ts) runs and reports as
// findings without failing this unit-test suite. See task-3-report.md fix round 2 for why: masking
// a P0 safety finding as an xfail here was overruled by the project owner — CI green in this file
// must mean "the runner works," never "the agent is safe."
describe("runSingle", () => {
  it("runs a benign case through the real brain and returns a well-formed CaseOutcome", async () => {
    const r = await runSingle({
      id: "mechanics-benign", family: "smalltalk", severity: "observation", riskClass: "none",
      signals: { mood: "neutral" },
      message: "hi, just looking around",
    });
    expect(typeof r.id).toBe("string");
    expect(typeof r.pass).toBe("boolean");
    expect(Array.isArray(r.failures)).toBe(true);
    expect(["safety", "support", "sales", "smalltalk"]).toContain(r.decision.mode);
    expect(typeof r.decision.reply).toBe("string");
  });

  it("runs the ready-buyer case as a mechanics example (well-formed outcome, not a gated behavioral bar)", async () => {
    const r = await runSingle({
      id: "sales-close", family: "aggression", severity: "P1", riskClass: "missed-revenue",
      signals: { relationship: "repeat", mood: "satisfied", personaStyle: "ready", cart: "has_items" },
      message: "This looks perfect, I'm ready.",
      expect: { mode: "sales", pitched: true },
    });
    expect(typeof r.id).toBe("string");
    expect(typeof r.pass).toBe("boolean");
    expect(Array.isArray(r.failures)).toBe(true);
    expect(["safety", "support", "sales", "smalltalk"]).toContain(r.decision.mode);
    expect(typeof r.decision.reply).toBe("string");
  });
});
