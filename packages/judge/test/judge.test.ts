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

  it("requests structured output (responseSchema) on the first attempt", async () => {
    const reqs: { responseSchema?: Record<string, unknown> }[] = [];
    const capturing: ModelPort = {
      complete: async (r) => {
        reqs.push(r);
        return { text: '{"results":[{"id":"a","pass":true,"reason":"ok"}]}', model: "fake" };
      },
    };
    await new ModelJudge(capturing, "anthropic").grade({ rubric: "r", transcript: "t", criteria: [{ id: "a", description: "A" }] });
    expect(reqs).toHaveLength(1); // valid JSON on attempt 0 → no retry
    expect(reqs[0]!.responseSchema).toBeDefined();
    expect((reqs[0]!.responseSchema as { required?: string[] }).required).toContain("results");
  });

  it("drops the schema on the retry when the first response won't parse", async () => {
    const reqs: { responseSchema?: Record<string, unknown> }[] = [];
    const capturing: ModelPort = {
      complete: async (r) => {
        reqs.push(r);
        return { text: "not json", model: "fake" };
      },
    };
    const v = await new ModelJudge(capturing, "anthropic").grade({ rubric: "r", transcript: "t", criteria: [{ id: "a", description: "A" }] });
    expect(reqs).toHaveLength(2);
    expect(reqs[0]!.responseSchema).toBeDefined();
    expect(reqs[1]!.responseSchema).toBeUndefined(); // fallback without schema
    expect(v.pass).toBe(false); // still fail-closed
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
