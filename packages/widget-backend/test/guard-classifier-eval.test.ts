import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelPort, ModelRequest, ModelResponse } from "@palup/platform-ports";
import { SUPPORT_INTENTS } from "@palup/widget-brain";
import { classifyGuardSignals } from "../src/guard-classifier.js";
import { gradeGuardSignals, type GuardCase } from "../src/guard-classifier-eval.js";

// broaden eval — grader + plumbing, gate-tested WITHOUT creds. A scripted model returns canned classifier
// JSON so we prove classifyGuardSignals' parse/whitelist path (the runner's) and the grader end-to-end. The
// real-model classifier-quality run is `pnpm eval:guard-classifier` (needs Vertex creds).

class ScriptedClassifier implements ModelPort {
  constructor(private readonly raw: string) {}
  async complete(_req: ModelRequest): Promise<ModelResponse> {
    return { text: this.raw, model: "scripted" };
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const { cases } = JSON.parse(readFileSync(join(here, "..", "cases", "guard-classifier.json"), "utf8")) as { cases: GuardCase[] };
const SUPPORT_INTENT_SET = new Set<string>(SUPPORT_INTENTS);
const SAFETY_CLASSES = new Set(["none", "distress", "product_safety", "regulated_claim", "medical", "legal", "abuse"]);

describe("broaden guard-classifier — grader (null ⇔ absent)", () => {
  it("matches when the pinned fields agree; null expectation matches an absent field", () => {
    expect(gradeGuardSignals({ safetyClass: null, injection: false, supportIntent: null }, { injection: false, degraded: false }).pass).toBe(true);
    expect(gradeGuardSignals({ supportIntent: "refund" }, { injection: false, supportIntent: "refund", degraded: false }).pass).toBe(true);
    expect(gradeGuardSignals({ injection: true }, { injection: true, degraded: false }).pass).toBe(true);
  });
  it("fails on a mismatch and only checks the pinned fields", () => {
    expect(gradeGuardSignals({ supportIntent: "refund" }, { injection: false, supportIntent: "return", degraded: false }).pass).toBe(false);
    expect(gradeGuardSignals({ safetyClass: "distress" }, { injection: false, degraded: false }).pass).toBe(false);
    // injection not pinned ⇒ not checked, so a differing injection value does not fail the case
    expect(gradeGuardSignals({ supportIntent: "refund" }, { injection: true, supportIntent: "refund", degraded: false }).pass).toBe(true);
  });
});

describe("broaden guard-classifier — plumbing (classifyGuardSignals parse/whitelist path)", () => {
  it("a valid support classification maps to the pinned fields and grades pass", async () => {
    const got = await classifyGuardSignals(new ScriptedClassifier('{"safetyClass":"none","injection":false,"supportIntent":"refund"}'), "money back please", "t");
    expect(got).toMatchObject({ supportIntent: "refund", injection: false });
    expect(got.safetyClass).toBeUndefined();
    expect(gradeGuardSignals({ supportIntent: "refund" }, got).pass).toBe(true);
  });
  it("an out-of-enum supportIntent is dropped to undefined (not trusted)", async () => {
    const got = await classifyGuardSignals(new ScriptedClassifier('{"safetyClass":"none","injection":false,"supportIntent":"delete_everything"}'), "x", "t");
    expect(got.supportIntent).toBeUndefined();
    expect(gradeGuardSignals({ supportIntent: null }, got).pass).toBe(true);
  });
  it("unparseable output ⇒ degraded, no server signal (grades as 'none')", async () => {
    const got = await classifyGuardSignals(new ScriptedClassifier("I cannot classify that"), "x", "t");
    expect(got).toMatchObject({ injection: false, degraded: true });
    expect(gradeGuardSignals({ safetyClass: null, injection: false, supportIntent: null }, got).pass).toBe(true);
  });
});

describe("broaden guard-classifier — corpus is well-formed", () => {
  it("every case is unique, non-empty, and pins only valid enum values", () => {
    const ids = new Set<string>();
    for (const c of cases) {
      expect(c.id, JSON.stringify(c)).toBeTruthy();
      expect(ids.has(c.id), `duplicate id ${c.id}`).toBe(false);
      ids.add(c.id);
      expect(c.message.length).toBeGreaterThan(0);
      expect(Object.keys(c.expect).length, `${c.id} pins nothing`).toBeGreaterThan(0);
      if (c.expect.safetyClass != null) expect(SAFETY_CLASSES.has(c.expect.safetyClass), `${c.id} bad safetyClass`).toBe(true);
      if (c.expect.supportIntent != null) expect(SUPPORT_INTENT_SET.has(c.expect.supportIntent), `${c.id} bad supportIntent`).toBe(true);
    }
  });
  it("has gating support, injection, and safety cases", () => {
    const gating = cases.filter((c) => !c.advisory);
    expect(gating.some((c) => c.expect.supportIntent)).toBe(true);
    expect(gating.some((c) => c.expect.injection === true)).toBe(true);
    expect(gating.some((c) => c.expect.safetyClass)).toBe(true);
  });
});
