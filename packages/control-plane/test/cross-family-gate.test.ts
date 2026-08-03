import { describe, it, expect } from "vitest";
import { DEFAULT_POLICY, type Policy } from "@palup/widget-brain";
import { EvolutionEngine, type Grader, type PolicyMetrics } from "@palup/evolution";
import { AGENT_FAMILY, decideGating, liveJudgeFamily } from "../src/gating.js";

// ADR-0014 fail-CLOSED cross-family promotion gate. The evolution eval gate must NEVER gate a promotion
// on a SAME-family judge (Gemini grading the Gemini agent) or when no cross-family judge is available.
// Deterministic — the family inputs are controlled directly; no live model/judge is called.

// A grader that stamps `gating` exactly the way LiveGrader does: from decideGating(agent, judge).
class FamilyGrader implements Grader {
  constructor(private readonly judgeFamily: string, private readonly qualityScore: number) {}
  async grade(policy: Policy): Promise<PolicyMetrics> {
    const { gating } = decideGating(AGENT_FAMILY, this.judgeFamily);
    return { policyId: policy.id, safetyPass: true, floorPass: true, qualityScore: this.qualityScore, gating, counterMetrics: CM };
  }
}

// Complete, equal counter-metrics (ADR-0014 #5) so this suite exercises the CROSS-FAMILY gating check,
// not the counter-metrics fail-closed one.
const CM = { returnRate: 0.08, complaintRate: 0.03, optOutRate: 0.1, escalationRecall: 1 };
const champion = {
  policy: DEFAULT_POLICY,
  metrics: { policyId: DEFAULT_POLICY.id, safetyPass: true, floorPass: true, qualityScore: 0.5, counterMetrics: CM } as PolicyMetrics,
};
const cand = (id: string): Policy => ({ id, label: id, styleDirective: "x", proactivityDefault: "balanced" });

describe("cross-family promotion gate (fail-closed, ADR-0014)", () => {
  it("REFUSES a same-family judge (gemini judges gemini): a promotion cannot gate on it", async () => {
    expect(decideGating(AGENT_FAMILY, "gemini").gating).toBe(false);
    // Improved score, but graded by the same family → advisory only.
    const e = new EvolutionEngine({ champion, grader: new FamilyGrader("gemini", 0.9) });
    const id = e.propose(cand("same-family"));
    const rec = await e.evaluate(id);
    expect(rec.gate?.pass).toBe(false);
    expect(rec.gate?.reasons).toContain("advisory-grade-not-gating");
    expect(rec.status).toBe("blocked");
    // Structurally incapable of gating: it never reaches human approval, so it cannot be promoted.
    expect(() => e.approve(id)).toThrow(/cannot approve/);
  });

  it("ALLOWS a real cross-family judge (anthropic judges gemini) to gate a promotion", async () => {
    expect(decideGating(AGENT_FAMILY, "anthropic").gating).toBe(true);
    const e = new EvolutionEngine({ champion, grader: new FamilyGrader("anthropic", 0.9) });
    const id = e.propose(cand("cross-family"));
    const rec = await e.evaluate(id);
    expect(rec.gate?.pass).toBe(true);
    expect(rec.status).toBe("awaiting_approval");
    // The human gate + promotion path is available (preserves existing behavior with a real judge).
    expect(e.approve(id).status).toBe("approved");
    expect(e.promote(id).policy.id).toBe("cross-family");
  });

  it("FAILS CLOSED when no cross-family judge is available (ANTHROPIC unset -> gemini fallback)", async () => {
    // liveJudgeFamily(false) mirrors LiveGrader's fallback when ANTHROPIC_API_KEY is unset.
    const fallback = liveJudgeFamily(false);
    expect(fallback).toBe("gemini");
    expect(decideGating(AGENT_FAMILY, fallback).gating).toBe(false);
    // Even a near-perfect advisory score cannot pass the gate.
    const e = new EvolutionEngine({ champion, grader: new FamilyGrader(fallback, 0.99) });
    const id = e.propose(cand("no-cross-family"));
    const rec = await e.evaluate(id);
    expect(rec.gate?.pass).toBe(false);
    expect(rec.status).toBe("blocked");
  });

  it("liveJudgeFamily(true) selects the anthropic cross-family judge (which gates)", () => {
    expect(liveJudgeFamily(true)).toBe("anthropic");
    expect(decideGating(AGENT_FAMILY, liveJudgeFamily(true)).gating).toBe(true);
  });

  it("keeps the offline path gating-eligible: a grade with NO gating flag can still pass (MockGrader)", async () => {
    // MockGrader / offline deterministic metrics carry no `gating` field (undefined) — the gate must
    // treat that as gating-eligible so the offline demo + existing tests keep working (opt-out, not opt-in).
    class NoFlagGrader implements Grader {
      async grade(policy: Policy): Promise<PolicyMetrics> {
        return { policyId: policy.id, safetyPass: true, floorPass: true, qualityScore: 0.9, counterMetrics: CM }; // no gating field
      }
    }
    const e = new EvolutionEngine({ champion, grader: new NoFlagGrader() });
    const id = e.propose(cand("offline"));
    const rec = await e.evaluate(id);
    expect(rec.gate?.pass).toBe(true);
    expect(rec.status).toBe("awaiting_approval");
  });
});
