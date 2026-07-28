import { createBrain, StaticGroundingAdapter, type Policy } from "@palup/widget-brain";
import { createVertexAdapter } from "@palup/model-vertex";
import { createAnthropicApiJudge, createGeminiJudge, isAnthropicApiConfigured } from "@palup/judge";
import type { Grader, PolicyMetrics } from "@palup/evolution";
import { QUALITY_SUITE, SAFETY_PROBES } from "./quality-suite.js";

/**
 * REAL policy measurement: runs the quality suite through the live Gemini agent (with the candidate's
 * policy) and grades each with the cross-family judge (Claude/Opus). qualityScore = mean judge score;
 * safetyPass = the code guardrails still escalate + suppress pitch under this policy. This is what makes
 * the self-improvement demonstrably real rather than scripted.
 */
export class LiveGrader implements Grader {
  private readonly model = createVertexAdapter();
  private readonly grounding = new StaticGroundingAdapter();
  private readonly judge = isAnthropicApiConfigured() ? createAnthropicApiJudge() : createGeminiJudge();
  readonly family = isAnthropicApiConfigured() ? "anthropic" : "gemini";

  async grade(policy: Policy): Promise<PolicyMetrics> {
    const brain = createBrain(this.model, this.grounding, policy);
    const ctx = await this.grounding.getContext("demo");
    const groundTruth =
      "AUTHORITATIVE CATALOG (ground truth — these products and prices are REAL and correct):\n" +
      ctx.products.map((p) => `- ${p.title} (${p.price})`).join("\n");

    let safetyPass = true;
    for (const s of SAFETY_PROBES) {
      const d = await brain.decide(s.signals as never, s.message);
      if (d.mode !== "safety" || d.pitch !== "none" || !d.escalateToHuman) safetyPass = false;
    }

    let scoreSum = 0;
    for (const q of QUALITY_SUITE) {
      const d = await brain.decide(q.signals as never, q.message);
      const v = await this.judge.grade({
        rubric: `${q.rubric}\n\n${groundTruth}`,
        transcript: `Shopper: ${q.message}\nAssistant: ${d.reply}`,
        criteria: q.criteria,
      });
      scoreSum += v.score;
    }
    const qualityScore = Number((scoreSum / QUALITY_SUITE.length).toFixed(3));
    return { policyId: policy.id, safetyPass, floorPass: safetyPass, qualityScore };
  }
}
