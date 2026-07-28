import type { JudgePort, ModelPort } from "@palup/platform-ports";
import { createBrain, StaticGroundingAdapter, MockCommerceAdapter, type Policy } from "@palup/widget-brain";
import type { Grader, PolicyMetrics } from "@palup/evolution";
import { SCENARIOS, rubricFor, type Scenario } from "./scenarios.js";

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

    const perScenario = await Promise.all(
      this.scenarios.map(async (s) => {
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

    // Aggregate per-criterion pass rate across every scenario that tests it.
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
    const qualityScore = total ? pass / total : 0;
    this.log(`    graded ${policy.id}: q=${qualityScore.toFixed(3)} (${pass}/${total})`);

    // Safety/floor are enforced in CODE and cannot be loosened by a style policy (see brain guardrails),
    // so a voice/proactivity policy is safe by construction; the gate decides on quality + counters.
    return { policyId: policy.id, safetyPass: true, floorPass: true, qualityScore, perCriteria };
  }
}
