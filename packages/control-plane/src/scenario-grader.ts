import type { JudgePort, ModelPort } from "@palup/platform-ports";
import { createBrain, StaticGroundingAdapter, MockCommerceAdapter, type Policy } from "@palup/widget-brain";
import type { Grader, PolicyMetrics } from "@palup/evolution";
import { SCENARIOS, rubricFor, type Scenario } from "./scenarios.js";
import { measureCounterMetrics, createPersonaProbeBrain } from "./counter-metrics.js";
import { partitionScenarios, holdoutSeed } from "./holdout.js";

type Brain = ReturnType<typeof createBrain>;

// Grades a policy for REAL: runs the brain (with that policy) over every conversation scenario on the
// live model, judges each reply per-criterion with the cross-family judge, and aggregates into a
// quality score + per-criteria pass rates. This is the signal the loop improves against.
export class ScenarioGrader implements Grader {
  private readonly grounding = new StaticGroundingAdapter();
  private readonly commerce = new MockCommerceAdapter();
  constructor(
    private readonly model: ModelPort,
    private readonly judge: JudgePort,
    private readonly scenarios: Scenario[] = SCENARIOS,
    private readonly log: (m: string) => void = () => {},
  ) {}

  async grade(policy: Policy): Promise<PolicyMetrics> {
    const brain = createBrain(this.model, this.grounding, policy, this.commerce, "shopper-demo");
    // ADR-0014 #7 — split into the VISIBLE set (drives qualityScore + perCriteria, the ONLY signal shown
    // to the proposer via the weakness report) and a SECRET holdout (drives holdoutScore, the gate's
    // anti-overfit check the proposer never sees). Same total grading cost — the scenarios are partitioned,
    // not duplicated.
    const seed = holdoutSeed();
    const { visible, holdout } = partitionScenarios(this.scenarios, seed);
    const vis = await this.gradeSet(brain, visible);
    const hold = await this.gradeSet(brain, holdout);
    this.log(`    graded ${policy.id}: q=${vis.score.toFixed(3)} (visible ${visible.length}) · holdout=${hold.score.toFixed(3)} (${holdout.length})`);

    // Safety/floor are enforced in CODE and cannot be loosened by a style policy (see brain guardrails),
    // so a voice/proactivity policy is safe by construction; the gate decides on quality + counters + holdout.
    // Counter-metrics (ADR-0014 #5) are measured from the same brain so this grader's candidates carry the
    // evidence the fail-closed gate requires (else they would correctly block on counter-metrics-absent).
    //
    // Governance BLOCK closure (Finding 5, 2026-08-04): `brain` above is constructed with the disposition
    // flags at their default OFF, so it can never even see `personaStyle`/`personaRole` — feeding IT to
    // measureCounterMetrics would leave personaPriceInvariance measuring a brain that structurally can't
    // fail the persona-fairness probes, reporting a vacuous 1.0 regardless of the candidate policy. A
    // SEPARATE, disposition-flags-ON brain, built from the SAME model/grounding/policy/commerce/shopperId,
    // is used ONLY for the counter-metrics probes — this does not change what qualityScore grades or what
    // ships; it only lets the FAIR-1 blocking floor actually observe persona-conditioned behavior. Built
    // via the SHARED, named helper so this grader and live-grader.ts cannot drift apart on the flag; the
    // regression is locked by counter-metrics-probe-brain.test.ts, which grades a persona-discriminating
    // model through THIS grader and requires the fairness floor to actually catch it.
    const counterMetrics = await measureCounterMetrics(
      createPersonaProbeBrain(this.model, this.grounding, policy, this.commerce, "shopper-demo"),
    );
    return {
      policyId: policy.id,
      safetyPass: true,
      floorPass: true,
      qualityScore: vis.score,
      perCriteria: vis.perCriteria, // VISIBLE only — the holdout criteria are never surfaced to the proposer
      holdoutScore: holdout.length ? hold.score : undefined,
      holdoutSeed: holdout.length ? seed : undefined, // stamp the epoch so the gate compares like-for-like
      counterMetrics,
    };
  }

  /** Grade one scenario set → { per-criterion pass rate, mean score }. Used for the visible + holdout sets. */
  private async gradeSet(brain: Brain, scenarios: Scenario[]): Promise<{ perCriteria: Record<string, number>; score: number }> {
    const perScenario = await Promise.all(
      scenarios.map(async (s) => {
        const d = await brain.decide((s.signals ?? {}) as never, s.message);
        const transcript = `Shopper: ${s.message}\nAssistant: ${d.reply}`;
        const verdict = await this.judge.grade({
          rubric: rubricFor(s),
          transcript,
          criteria: s.criteria.map((c) => ({ id: c, description: c })),
        });
        return verdict.results.map((r) => ({ criterion: r.id, pass: r.pass }));
      }),
    );
    const tally: Record<string, { pass: number; total: number }> = {};
    for (const results of perScenario)
      for (const r of results) {
        const t = (tally[r.criterion] ??= { pass: 0, total: 0 });
        t.total++;
        if (r.pass) t.pass++;
      }
    const perCriteria: Record<string, number> = {};
    let pass = 0;
    let total = 0;
    for (const [c, t] of Object.entries(tally)) {
      perCriteria[c] = t.total ? t.pass / t.total : 0;
      pass += t.pass;
      total += t.total;
    }
    return { perCriteria, score: total ? Number((pass / total).toFixed(3)) : 0 };
  }
}
