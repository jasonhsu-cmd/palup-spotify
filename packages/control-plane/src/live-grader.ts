import { createBrain, StaticGroundingAdapter, MockCommerceAdapter, type Policy } from "@palup/widget-brain";
import { createVertexAdapter } from "@palup/model-vertex";
import { createAnthropicApiJudge, createGeminiJudge, isAnthropicApiConfigured } from "@palup/judge";
import type { Grader, PolicyMetrics } from "@palup/evolution";
import { deterministicFloorPass } from "@palup/eval";
import { AGENT_FAMILY, decideGating, liveJudgeFamily } from "./gating.js";
import { QUALITY_SUITE, SAFETY_PROBES } from "./quality-suite.js";
import { measureCounterMetrics } from "./counter-metrics.js";
import { partitionScenarios, holdoutSeed } from "./holdout.js";

/**
 * REAL policy measurement: runs the quality suite through the live Gemini agent (with the candidate's
 * policy) and grades each with the cross-family judge (Claude/Opus). qualityScore = mean judge score;
 * safetyPass = the code guardrails still escalate + suppress pitch under this policy. floorPass is a
 * DETERMINISTIC, machine-checkable pass over the safety/injection/compliance floor cases (packages/eval
 * floor:true, graded by the code-only grade()) — computed INDEPENDENTLY of the subjective
 * qualityScore/safetyPass so a floor regression can never be bought back by a high judge score (ADR-0014).
 * This is what makes the self-improvement demonstrably real rather than scripted.
 */
export class LiveGrader implements Grader {
  private readonly model = createVertexAdapter();
  private readonly grounding = new StaticGroundingAdapter();
  private readonly commerce = new MockCommerceAdapter();
  private readonly judge = isAnthropicApiConfigured() ? createAnthropicApiJudge() : createGeminiJudge();
  readonly family = liveJudgeFamily(isAnthropicApiConfigured());
  // Fail-CLOSED (ADR-0014): if the judge is the SAME family as the Gemini agent (the advisory fallback
  // when ANTHROPIC_API_KEY is unset), this grade is ADVISORY ONLY — stamp gating:false so engine.gate
  // refuses to pass it. A real cross-family (Anthropic) judge is gating.
  readonly gating = decideGating(AGENT_FAMILY, this.family).gating;

  async grade(policy: Policy): Promise<PolicyMetrics> {
    const brain = createBrain(this.model, this.grounding, policy, this.commerce, "shopper-demo");
    const ctx = await this.grounding.getContext("demo");
    const groundTruth =
      "AUTHORITATIVE CATALOG (ground truth — these products and prices are REAL and correct):\n" +
      ctx.products.map((p) => `- ${p.title} (${p.price})`).join("\n");

    let safetyPass = true;
    for (const s of SAFETY_PROBES) {
      const d = await brain.decide(s.signals as never, s.message);
      if (d.mode !== "safety" || d.pitch !== "none" || !d.escalateToHuman) safetyPass = false;
    }

    // DETERMINISTIC floor (ADR-0014): run THIS candidate's brain through the safety/injection/compliance
    // floor cases (packages/eval floor:true) and require ALL to pass via the code-only grade() — NOT an
    // alias of the subjective safetyPass. Every floor case short-circuits in the brain's CODE guardrails
    // before any model call, so floorPass is deterministic and independent of qualityScore: a candidate
    // that degrades a floor invariant fails here no matter how high the judge scores its quality.
    const floorPass = await deterministicFloorPass(brain);

    // ADR-0014 #7 — the LIVE ship-path grade must carry the holdout too (else the anti-overfit gate is
    // dormant on the path that reaches shoppers). Partition QUALITY_SUITE into the VISIBLE set (→
    // qualityScore) and the SECRET holdout (→ holdoutScore); live mode REQUIRES the rotation secret.
    const seed = holdoutSeed(true);
    const { visible, holdout } = partitionScenarios(QUALITY_SUITE, seed);
    const scoreSet = async (cases: typeof QUALITY_SUITE): Promise<number> => {
      let sum = 0;
      for (const q of cases) {
        const d = await brain.decide(q.signals as never, q.message);
        const v = await this.judge.grade({
          rubric: `${q.rubric}\n\n${groundTruth}`,
          transcript: `Shopper: ${q.message}\nAssistant: ${d.reply}`,
          criteria: q.criteria,
        });
        sum += v.score;
      }
      return cases.length ? Number((sum / cases.length).toFixed(3)) : 0;
    };
    const qualityScore = await scoreSet(visible);
    const holdoutScore = holdout.length ? await scoreSet(holdout) : undefined;
    // ADR-0014 #5 — populate the counter-metrics so a quality lift can never promote on its own without
    // proof it didn't drive returns/complaints/opt-outs or stop escalating. Deterministic, PII-free.
    //
    // Governance BLOCK closure (Finding 5, 2026-08-04): `brain` above (used for safetyPass/floorPass/
    // qualityScore/holdoutScore) is constructed with the disposition flags at their default OFF, so it
    // can never even see `personaStyle`/`personaRole` — feeding IT to measureCounterMetrics would leave
    // personaPriceInvariance measuring a brain that structurally can't fail the persona-fairness probes,
    // reporting a vacuous 1.0 regardless of the candidate policy. A SEPARATE, disposition-flags-ON brain,
    // built from the SAME model/grounding/policy/commerce/shopperId, is used ONLY for the counter-metrics
    // probes — this does not change what safetyPass/floorPass/qualityScore grade or what ships; it only
    // lets the FAIR-1 blocking floor actually observe persona-conditioned behavior.
    const personaProbeBrain = createBrain(this.model, this.grounding, policy, this.commerce, "shopper-demo", undefined, false, true);
    const counterMetrics = await measureCounterMetrics(personaProbeBrain);
    return { policyId: policy.id, safetyPass, floorPass, qualityScore, holdoutScore, holdoutSeed: holdout.length ? seed : undefined, counterMetrics, gating: this.gating };
  }
}
