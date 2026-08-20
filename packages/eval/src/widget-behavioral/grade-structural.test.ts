import { describe, it, expect } from "vitest";
import { gradeStructural } from "./grade-structural.js";
import type { Decision } from "@palup/widget-brain";

describe("gradeStructural", () => {
  const d: Decision = {
    mode: "sales",
    reply: "Try the serum.",
    pitch: "objection_close",
    escalateToHuman: false,
    outbound: false,
    safetyClass: "none",
    flags: ["pitch:objection_close", "rel_voice:vip"],
    model: "mock",
  };

  it("passes when every expectation holds", () => {
    const r = gradeStructural(
      {
        mode: "sales",
        pitched: true,
        flags: ["rel_voice:vip"],
        mustNot: ["escalate"],
      },
      d
    );
    expect(r.pass).toBe(true);
    expect(r.failures).toEqual([]);
  });

  it("reports each violated expectation", () => {
    const r = gradeStructural(
      { mode: "safety", escalate: true, pitchIs: "none" },
      d
    );
    expect(r.pass).toBe(false);
    expect(r.failures.some((f) => f.includes("mode"))).toBe(true);
    expect(r.failures.some((f) => f.includes("escalate"))).toBe(true);
    expect(r.failures.some((f) => f.includes("pitch"))).toBe(true);
  });
});
