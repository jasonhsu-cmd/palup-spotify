import { describe, it, expect } from "vitest";
import type { Decision } from "@palup/widget-brain";
import { holds, grade, type EvalCase } from "../src/grade.js";

// Minimal Decision factory — every required field present, overridable per test. No model call:
// grade()/holds() are pure functions over a Decision, so these run offline and deterministically.
function decision(over: Partial<Decision> = {}): Decision {
  return {
    mode: "sales",
    reply: "",
    pitch: "none",
    escalateToHuman: false,
    outbound: false,
    safetyClass: "none",
    flags: [],
    model: "test",
    ...over,
  };
}

function evalCase(over: Partial<EvalCase> = {}): EvalCase {
  return {
    id: "T-1",
    layer: "test",
    floor: false,
    signals: {},
    message: "",
    must: [],
    mustNot: [],
    ...over,
  };
}

describe("holds — assertion tokens map to Decision fields (deterministic, no model call)", () => {
  it("resolves mode_* / escalate / pitched", () => {
    expect(holds("mode_safety", decision({ mode: "safety" }))).toBe(true);
    expect(holds("mode_safety", decision({ mode: "sales" }))).toBe(false);
    expect(holds("mode_support", decision({ mode: "support" }))).toBe(true);
    expect(holds("mode_sales", decision({ mode: "sales" }))).toBe(true);
    expect(holds("escalate", decision({ escalateToHuman: true }))).toBe(true);
    expect(holds("escalate", decision({ escalateToHuman: false }))).toBe(false);
    expect(holds("pitched", decision({ pitch: "cross_sell" }))).toBe(true);
    expect(holds("pitched", decision({ pitch: "none" }))).toBe(false);
  });

  it("falls through a bare token to a flags membership check", () => {
    expect(holds("injection_blocked", decision({ flags: ["injection_blocked"] }))).toBe(true);
    expect(holds("injection_blocked", decision({ flags: [] }))).toBe(false);
  });

  it("matches a contains: token against the reply case-insensitively", () => {
    expect(holds("contains:% off", decision({ reply: "Here is 20% OFF today" }))).toBe(true);
    expect(holds("contains:% off", decision({ reply: "no discounts here" }))).toBe(false);
  });
});

describe("grade — action-set -> failedMust / violatedMustNot", () => {
  it("reports a missing required 'must' in failedMust and fails the case", () => {
    const c = evalCase({ must: ["mode_safety", "escalate"], mustNot: ["pitched"] });
    const r = grade(c, decision({ mode: "sales", escalateToHuman: false, pitch: "none" }));
    expect(r.failedMust).toContain("mode_safety");
    expect(r.failedMust).toContain("escalate");
    expect(r.violatedMustNot).toEqual([]);
    expect(r.pass).toBe(false);
  });

  it("reports a triggered 'must_not' in violatedMustNot and fails the case", () => {
    const c = evalCase({ must: ["mode_sales"], mustNot: ["pitched"] });
    const r = grade(c, decision({ mode: "sales", pitch: "cross_sell", flags: ["pitch:cross_sell"] }));
    expect(r.failedMust).toEqual([]);
    expect(r.violatedMustNot).toContain("pitched");
    expect(r.pass).toBe(false);
  });

  it("passes a clean action-set (all must hold, no must_not triggered) and carries floor through", () => {
    const c = evalCase({ floor: true, must: ["mode_safety", "escalate"], mustNot: ["pitched"] });
    const r = grade(c, decision({ mode: "safety", escalateToHuman: true, pitch: "none" }));
    expect(r.pass).toBe(true);
    expect(r.failedMust).toEqual([]);
    expect(r.violatedMustNot).toEqual([]);
    // grade() copies the floor flag onto the result so the gate can do its floor check.
    expect(r.floor).toBe(true);
  });
});
