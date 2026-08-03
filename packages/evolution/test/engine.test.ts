import { describe, it, expect } from "vitest";
import { DEFAULT_POLICY, type Policy } from "@palup/widget-brain";
import { EvolutionEngine, MockGrader, type PolicyMetrics } from "../src/index.js";

// A complete counter-metrics baseline (ADR-0014 #5): both the champion AND a passing candidate must
// carry the measured counter-metrics, or the gate fails closed. escalationRecall higher=better;
// returnRate/complaintRate/optOutRate lower=better.
const BASE_CM = { returnRate: 0.08, complaintRate: 0.03, optOutRate: 0.1, escalationRecall: 1 };

const champion = {
  policy: DEFAULT_POLICY,
  metrics: { policyId: DEFAULT_POLICY.id, safetyPass: true, floorPass: true, qualityScore: 0.75, counterMetrics: BASE_CM } as PolicyMetrics,
};
// A safe, improved candidate with counter-metrics no worse than the baseline — the canonical "should pass".
const GOOD: PolicyMetrics = { policyId: "good", safetyPass: true, floorPass: true, qualityScore: 0.9, counterMetrics: BASE_CM };

const P = (id: string): Policy => ({ id, label: id, styleDirective: "x", proactivityDefault: "balanced" });

function engineWith(scores: Record<string, PolicyMetrics>) {
  return new EvolutionEngine({ champion, grader: new MockGrader(scores) });
}
const evalOne = async (scores: Record<string, PolicyMetrics>, id: string) => {
  const e = engineWith(scores);
  e.propose(P(id));
  return e.evaluate(id);
};

describe("EvolutionEngine gate", () => {
  it("gates PASS a safe, improved candidate with complete, not-worse counter-metrics -> awaiting_approval", async () => {
    const rec = await evalOne({ good: GOOD }, "good");
    expect(rec.status).toBe("awaiting_approval");
    expect(rec.gate?.pass).toBe(true);
  });

  it("BLOCKS a candidate that regresses quality", async () => {
    const rec = await evalOne({ worse: { ...GOOD, policyId: "worse", qualityScore: 0.6 } }, "worse");
    expect(rec.status).toBe("blocked");
    expect(rec.gate?.reasons).toContain("quality-regressed");
  });

  it("BLOCKS on a safety-floor failure regardless of quality (hard gate)", async () => {
    const rec = await evalOne({ unsafe: { ...GOOD, policyId: "unsafe", safetyPass: false, qualityScore: 0.99 } }, "unsafe");
    expect(rec.status).toBe("blocked");
    expect(rec.gate?.reasons).toContain("safety-floor-failed");
  });

  // ADR-0014 #5 — the core fail-closed property: an engagement/quality lift can NEVER promote on its own.
  it("BLOCKS a higher-quality candidate that carries NO counter-metrics (fail-closed, never on quality alone)", async () => {
    const rec = await evalOne({ eng: { policyId: "eng", safetyPass: true, floorPass: true, qualityScore: 0.95 } }, "eng");
    expect(rec.status).toBe("blocked");
    expect(rec.gate?.reasons).toContain("counter-metrics-absent");
    expect(rec.gate?.pass).toBe(false);
  });

  it("BLOCKS when the return rate worsens", async () => {
    const rec = await evalOne({ pushy: { ...GOOD, policyId: "pushy", qualityScore: 0.95, counterMetrics: { ...BASE_CM, returnRate: 0.2 } } }, "pushy");
    expect(rec.status).toBe("blocked");
    expect(rec.gate?.reasons).toContain("counter-metrics-worsened");
  });

  it("BLOCKS when opt-out risk worsens", async () => {
    const rec = await evalOne({ c: { ...GOOD, policyId: "c", qualityScore: 0.95, counterMetrics: { ...BASE_CM, optOutRate: 0.4 } } }, "c");
    expect(rec.gate?.reasons).toContain("counter-metrics-worsened");
  });

  it("BLOCKS when escalation recall drops (a silent support/safety regression)", async () => {
    const rec = await evalOne({ c: { ...GOOD, policyId: "c", qualityScore: 0.95, counterMetrics: { ...BASE_CM, escalationRecall: 0.5 } } }, "c");
    expect(rec.gate?.reasons).toContain("counter-metrics-worsened");
  });

  it("BLOCKS a candidate whose counter-metrics contain NaN / out-of-range (fail-closed, not fail-open)", async () => {
    const rec = await evalOne({ nan: { ...GOOD, policyId: "nan", qualityScore: 0.95, counterMetrics: { ...BASE_CM, optOutRate: NaN } } }, "nan");
    expect(rec.status).toBe("blocked");
    expect(rec.gate?.reasons).toContain("counter-metrics-absent"); // NaN is not a valid rate ⇒ treated as absent
  });

  // ADR-0014 #7 — anti-overfit: improving the visible set but regressing the SECRET holdout is gaming.
  it("BLOCKS a candidate that improves visible quality but REGRESSES the secret holdout (anti-overfit)", async () => {
    const champ = { policy: DEFAULT_POLICY, metrics: { ...champion.metrics, holdoutScore: 0.8 } };
    const e = new EvolutionEngine({ champion: champ, grader: new MockGrader({ overfit: { ...GOOD, policyId: "overfit", qualityScore: 0.95, holdoutScore: 0.6 } }) });
    e.propose(P("overfit"));
    const rec = await e.evaluate("overfit");
    expect(rec.status).toBe("blocked");
    expect(rec.gate?.reasons).toContain("holdout-regressed");
  });

  it("PASSES a candidate that improves BOTH visible quality and the holdout (genuine improvement)", async () => {
    const champ = { policy: DEFAULT_POLICY, metrics: { ...champion.metrics, holdoutScore: 0.8 } };
    const e = new EvolutionEngine({ champion: champ, grader: new MockGrader({ gen: { ...GOOD, policyId: "gen", qualityScore: 0.9, holdoutScore: 0.85 } }) });
    e.propose(P("gen"));
    const rec = await e.evaluate("gen");
    expect(rec.gate?.pass).toBe(true);
  });

  it("BLOCKS when the champion baseline has no counter-metrics (can't prove not-worse)", async () => {
    const bareChampion = { policy: DEFAULT_POLICY, metrics: { policyId: DEFAULT_POLICY.id, safetyPass: true, floorPass: true, qualityScore: 0.75 } as PolicyMetrics };
    const e = new EvolutionEngine({ champion: bareChampion, grader: new MockGrader({ good: GOOD }) });
    e.propose(P("good"));
    const rec = await e.evaluate("good");
    expect(rec.status).toBe("blocked");
    expect(rec.gate?.reasons).toContain("counter-metrics-baseline-absent");
  });
});

describe("EvolutionEngine governance", () => {
  it("cannot promote without a human approval (no self-promotion)", async () => {
    const e = engineWith({ good: GOOD });
    e.propose(P("good"));
    await e.evaluate("good");
    expect(() => e.promote("good")).toThrow(/needs human approval/);
    e.approve("good");
    const champ = e.promote("good");
    expect(champ.policy.id).toBe("good");
  });

  it("kill switch halts approvals and promotions", async () => {
    const e = engineWith({ good: GOOD });
    e.propose(P("good"));
    await e.evaluate("good");
    e.kill("test");
    expect(() => e.approve("good")).toThrow(/kill switch/i);
  });

  it("auto-rolls back on a post-promotion regression", async () => {
    const e = engineWith({ good: GOOD });
    e.propose(P("good"));
    await e.evaluate("good");
    e.approve("good");
    e.promote("good");
    expect(e.getChampion().policy.id).toBe("good");
    const r = e.monitor({ qualityScore: 0.5, safetyPass: true }); // below the prev champion's 0.75
    expect(r.rolledBack).toBe(true);
    expect(e.getChampion().policy.id).toBe(DEFAULT_POLICY.id);
  });

  it("audits every action", async () => {
    const e = engineWith({ good: GOOD });
    e.propose(P("good"));
    await e.evaluate("good");
    e.approve("good");
    e.promote("good");
    const actions = e.getAudit().map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["init", "propose", "gate_pass", "approve", "promote"]));
  });
});
