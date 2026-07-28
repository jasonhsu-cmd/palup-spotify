import { describe, it, expect } from "vitest";
import type { ModelPort } from "@palup/platform-ports";
import { ModelJudge } from "../src/model-judge.js";
import { crossFamilyGuard } from "../src/guard.js";

const fake = (json: string): ModelPort => ({
  complete: async () => ({ text: json, model: "fake-judge" }),
});

describe("ModelJudge", () => {
  it("parses per-criterion verdicts (incl. code fences) and computes pass/score", async () => {
    const j = new ModelJudge(
      fake('```json\n{"results":[{"id":"a","pass":true,"reason":"ok"},{"id":"b","pass":false,"reason":"no"}]}\n```'),
      "anthropic",
    );
    const v = await j.grade({
      rubric: "r",
      transcript: "t",
      criteria: [{ id: "a", description: "A" }, { id: "b", description: "B" }],
    });
    expect(v.results.find((r) => r.id === "a")?.pass).toBe(true);
    expect(v.results.find((r) => r.id === "b")?.pass).toBe(false);
    expect(v.pass).toBe(false);
    expect(v.score).toBe(0.5);
    expect(v.judgeFamily).toBe("anthropic");
  });

  it("fails closed when the judge omits a criterion", async () => {
    const j = new ModelJudge(fake('{"results":[{"id":"a","pass":true,"reason":"ok"}]}'), "anthropic");
    const v = await j.grade({
      rubric: "r",
      transcript: "t",
      criteria: [{ id: "a", description: "A" }, { id: "missing", description: "M" }],
    });
    expect(v.results.find((r) => r.id === "missing")?.pass).toBe(false);
    expect(v.pass).toBe(false);
  });

  it("fails closed (never throws) when the judge returns non-JSON", async () => {
    const j = new ModelJudge(fake("Sorry, I can't produce that."), "anthropic");
    const v = await j.grade({ rubric: "r", transcript: "t", criteria: [{ id: "a", description: "A" }] });
    expect(v.pass).toBe(false);
    expect(v.results[0]!.reason).toMatch(/not parseable/);
  });
});

describe("crossFamilyGuard (proposer != evaluator)", () => {
  it("passes when families differ", () => {
    expect(crossFamilyGuard("gemini", "anthropic").crossFamily).toBe(true);
  });
  it("flags same-family and throws in strict mode", () => {
    expect(crossFamilyGuard("gemini", "gemini").crossFamily).toBe(false);
    expect(() => crossFamilyGuard("gemini", "gemini", { strict: true })).toThrow(/differ/);
  });
});
