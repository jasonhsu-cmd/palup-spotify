import { describe, it, expect } from "vitest";
import { DEFAULT_POLICY, type Policy } from "@palup/widget-brain";
import { EvolutionEngine, MockGrader, type PolicyMetrics } from "../src/index.js";

// A complete counter-metrics baseline (ADR-0014 #5): both the champion AND a passing candidate must
// carry the measured counter-metrics, or the gate fails closed. escalationRecall higher=better;
// returnRate/complaintRate/optOutRate lower=better. personaPriceInvariance/personaLeakRate (PR-1
// governance floor) are the SAME fail-closed contract — personaPriceInvariance higher=better (1 = price/
// offer surface identical across a WTP-adjacent persona pair), personaLeakRate lower=better (0 = no
// persona/disposition fact reached the surface without consent).
const BASE_CM = { returnRate: 0.08, complaintRate: 0.03, optOutRate: 0.1, escalationRecall: 1, personaPriceInvariance: 1, personaLeakRate: 0 };

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
  const withHoldout = (m: Partial<PolicyMetrics>, score: number, seed = "s1"): PolicyMetrics => ({ ...GOOD, ...m, holdoutScore: score, holdoutSeed: seed } as PolicyMetrics);
  const champWithHoldout = (score: number, seed = "s1") => ({ policy: DEFAULT_POLICY, metrics: { ...champion.metrics, holdoutScore: score, holdoutSeed: seed } });

  it("BLOCKS a candidate that improves visible quality but REGRESSES the same-seed holdout (anti-overfit)", async () => {
    const e = new EvolutionEngine({ champion: champWithHoldout(0.8), grader: new MockGrader({ overfit: withHoldout({ policyId: "overfit", qualityScore: 0.95 }, 0.6) }) });
    e.propose(P("overfit"));
    const rec = await e.evaluate("overfit");
    expect(rec.status).toBe("blocked");
    expect(rec.gate?.reasons).toContain("holdout-regressed");
  });

  it("PASSES a candidate that improves BOTH visible quality and the holdout (genuine improvement)", async () => {
    const e = new EvolutionEngine({ champion: champWithHoldout(0.8), grader: new MockGrader({ gen: withHoldout({ policyId: "gen", qualityScore: 0.9 }, 0.85) }) });
    e.propose(P("gen"));
    const rec = await e.evaluate("gen");
    expect(rec.gate?.pass).toBe(true);
  });

  it("FAILS CLOSED — a champion with a holdout but a candidate WITHOUT one blocks (can't drop the holdout to dodge the gate)", async () => {
    const e = new EvolutionEngine({ champion: champWithHoldout(0.8), grader: new MockGrader({ noh: { ...GOOD, policyId: "noh", qualityScore: 0.95 } }) }); // no holdoutScore
    e.propose(P("noh"));
    const rec = await e.evaluate("noh");
    expect(rec.status).toBe("blocked");
    expect(rec.gate?.reasons).toContain("holdout-absent");
  });

  it("FAILS CLOSED — a candidate WITH a holdout but a champion baseline WITHOUT one blocks (no baseline to compare)", async () => {
    const e = new EvolutionEngine({ champion, grader: new MockGrader({ ch: withHoldout({ policyId: "ch", qualityScore: 0.95 }, 0.9) }) }); // champion has no holdoutScore
    e.propose(P("ch"));
    const rec = await e.evaluate("ch");
    expect(rec.status).toBe("blocked");
    expect(rec.gate?.reasons).toContain("holdout-baseline-absent");
  });

  it("BLOCKS a DIFFERENT-seed holdout comparison (a mid-run rotation is apples-to-oranges, not a pass)", async () => {
    const e = new EvolutionEngine({ champion: champWithHoldout(0.8, "seedA"), grader: new MockGrader({ mm: withHoldout({ policyId: "mm", qualityScore: 0.95 }, 0.99, "seedB") }) });
    e.propose(P("mm"));
    const rec = await e.evaluate("mm");
    expect(rec.status).toBe("blocked"); // even though 0.99 > 0.8, the seeds differ → not comparable
    expect(rec.gate?.reasons).toContain("holdout-seed-mismatch");
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

// PR-1 governance floor (shopper-disposition program) — fairness/leak/escalation guarantees as
// DETERMINISTIC gate floors, mirroring the counterMetricsComplete fail-closed pattern above EXACTLY, so no
// later persona/memory capability can land ungoverned. Two independent reasons: "fairness-regressed"
// (personaPriceInvariance) and "persona-leak" (personaLeakRate) — both fail CLOSED (absent/NaN/out-of-
// range on either side blocks, never fail-open), and a regression vs. the champion baseline blocks too.
describe("EvolutionEngine gate — PR-1 governance floor (fairness / leak / disposition-escalation)", () => {
  it("BLOCKS a candidate that price-discriminates by persona (fairness floor regresses)", async () => {
    const rec = await evalOne(
      { pd: { ...GOOD, policyId: "pd", qualityScore: 0.95, counterMetrics: { ...BASE_CM, personaPriceInvariance: 0.5 } } },
      "pd",
    );
    expect(rec.status).toBe("blocked");
    expect(rec.gate?.reasons).toContain("fairness-regressed");
  });

  it("BLOCKS a candidate that emits a persona/memory fact without consent (persona-leak floor regresses)", async () => {
    const rec = await evalOne(
      { leak: { ...GOOD, policyId: "leak", qualityScore: 0.95, counterMetrics: { ...BASE_CM, personaLeakRate: 0.3 } } },
      "leak",
    );
    expect(rec.status).toBe("blocked");
    expect(rec.gate?.reasons).toContain("persona-leak");
  });

  it("BLOCKS a candidate that suppresses a disposition-carrying (b2b) required escalation (counter-metrics-worsened)", async () => {
    // escalationRecall dropping because a b2b-tagged escalation probe stopped escalating is measured
    // identically to any other escalation drop (control-plane/counter-metrics.ts ESCALATION_PROBES now
    // include b2b-role variants) — the gate does not need to know WHY it dropped.
    const rec = await evalOne(
      { esc: { ...GOOD, policyId: "esc", qualityScore: 0.95, counterMetrics: { ...BASE_CM, escalationRecall: 0.7 } } },
      "esc",
    );
    expect(rec.status).toBe("blocked");
    expect(rec.gate?.reasons).toContain("counter-metrics-worsened");
  });

  it("FAIL-CLOSED — personaPriceInvariance ABSENT on the candidate blocks (never fail-open)", async () => {
    const { personaPriceInvariance, ...withoutPPI } = BASE_CM;
    void personaPriceInvariance;
    const rec = await evalOne({ x: { ...GOOD, policyId: "x", qualityScore: 0.95, counterMetrics: withoutPPI } }, "x");
    expect(rec.status).toBe("blocked");
    expect(rec.gate?.reasons).toContain("fairness-regressed");
  });

  it("FAIL-CLOSED — personaPriceInvariance is NaN on the candidate blocks (not a valid rate, not fail-open)", async () => {
    const rec = await evalOne(
      { nan: { ...GOOD, policyId: "nan", qualityScore: 0.95, counterMetrics: { ...BASE_CM, personaPriceInvariance: NaN } } },
      "nan",
    );
    expect(rec.status).toBe("blocked");
    expect(rec.gate?.reasons).toContain("fairness-regressed");
  });

  it("FAIL-CLOSED — personaLeakRate ABSENT on the candidate blocks (never fail-open)", async () => {
    const { personaLeakRate, ...withoutLeak } = BASE_CM;
    void personaLeakRate;
    const rec = await evalOne({ y: { ...GOOD, policyId: "y", qualityScore: 0.95, counterMetrics: withoutLeak } }, "y");
    expect(rec.status).toBe("blocked");
    expect(rec.gate?.reasons).toContain("persona-leak");
  });

  it("FAIL-CLOSED — the champion baseline lacks personaPriceInvariance/personaLeakRate (no baseline to prove not-worse)", async () => {
    const bareChampion = {
      policy: DEFAULT_POLICY,
      metrics: { policyId: DEFAULT_POLICY.id, safetyPass: true, floorPass: true, qualityScore: 0.75, counterMetrics: { returnRate: 0.08, complaintRate: 0.03, optOutRate: 0.1, escalationRecall: 1 } } as PolicyMetrics,
    };
    const e = new EvolutionEngine({ champion: bareChampion, grader: new MockGrader({ good: GOOD }) });
    e.propose(P("good"));
    const rec = await e.evaluate("good");
    expect(rec.status).toBe("blocked");
    expect(rec.gate?.reasons).toContain("fairness-regressed");
    expect(rec.gate?.reasons).toContain("persona-leak");
  });

  it("PASSES a style-only candidate that matches the baseline exactly (ships INERT — no champion-behavior change)", async () => {
    const rec = await evalOne({ styled: { ...GOOD, policyId: "styled", qualityScore: 0.95 } }, "styled");
    expect(rec.status).toBe("awaiting_approval");
    expect(rec.gate?.pass).toBe(true);
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
