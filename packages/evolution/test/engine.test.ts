import { describe, it, expect } from "vitest";
import { DEFAULT_POLICY, type Policy } from "@palup/widget-brain";
import { EvolutionEngine, MockGrader, MEASURED_OUTCOME_POWER_FLOOR, type PolicyMetrics } from "../src/index.js";

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

// Revenue-flywheel Wave-1 (C) — complaintRate hard-gate #1: OPTIONAL (no deterministic pre-promotion
// proxy exists — control-plane/counter-metrics.ts) but, once present on BOTH sides, enforced fail-closed
// exactly like returnRate/optOutRate/escalationRecall — never fail-open, never forced required.
describe("EvolutionEngine gate — complaintRate hard-gate (Wave-1 C)", () => {
  it("BLOCKS a candidate whose complaintRate worsens vs. the champion baseline (fail-closed, present on both)", async () => {
    const rec = await evalOne(
      { c: { ...GOOD, policyId: "c", qualityScore: 0.95, counterMetrics: { ...BASE_CM, complaintRate: 0.2 } } },
      "c",
    );
    expect(rec.status).toBe("blocked");
    expect(rec.gate?.reasons).toContain("counter-metrics-worsened");
  });

  it("PASSES a candidate whose complaintRate is no worse than the champion's (present on both, not worse)", async () => {
    const rec = await evalOne(
      { c: { ...GOOD, policyId: "c", qualityScore: 0.95, counterMetrics: { ...BASE_CM, complaintRate: BASE_CM.complaintRate } } },
      "c",
    );
    expect(rec.status).toBe("awaiting_approval");
    expect(rec.gate?.pass).toBe(true);
  });

  it("does NOT block when complaintRate is ABSENT on the candidate — never forced required (unchanged behavior)", async () => {
    const { complaintRate, ...withoutComplaint } = BASE_CM;
    void complaintRate;
    const rec = await evalOne({ c: { ...GOOD, policyId: "c", qualityScore: 0.95, counterMetrics: withoutComplaint } }, "c");
    expect(rec.status).toBe("awaiting_approval");
    expect(rec.gate?.pass).toBe(true);
  });

  it("BLOCKS a candidate with a malformed complaintRate (NaN) — fail-closed, not fail-open", async () => {
    const rec = await evalOne(
      { c: { ...GOOD, policyId: "c", qualityScore: 0.95, counterMetrics: { ...BASE_CM, complaintRate: NaN } } },
      "c",
    );
    expect(rec.status).toBe("blocked");
    expect(rec.gate?.reasons).toContain("complaint-rate-invalid");
  });
});

// Revenue-flywheel Wave-1 (D) — the measured-outcome seam: `measuredOutcome` is OPTIONAL (nothing
// populates it today; every existing caller is byte-identical), and when present it ADDITIONALLY requires
// a non-regressive `relativeLift` vs. the champion's own measuredOutcome, on top of every other check.
// Durability NOW-2: the comparison is RATE-normalized (`relativeLift`), never the absolute, exposure-
// scaled `incrementalLift` — `incrementalLift` still rides along on every fixture below for audit/display
// and for the malformed/non-finite fail-closed check, but it no longer decides pass/fail.
describe("EvolutionEngine gate — measured-outcome seam (Wave-1 D)", () => {
  const champWithMO = (relativeLift: number, incrementalLift = relativeLift) => ({
    policy: DEFAULT_POLICY,
    metrics: { ...champion.metrics, measuredOutcome: { incrementalLift, relativeLift } } as PolicyMetrics,
  });

  it("gates IDENTICALLY to the baseline case when measuredOutcome is absent (no behavior change)", async () => {
    const baseline = await evalOne({ good: GOOD }, "good");
    const rec = await evalOne({ good2: { ...GOOD, policyId: "good2" } }, "good2");
    expect(rec.gate).toEqual(baseline.gate);
  });

  it("BLOCKS a candidate whose measuredOutcome REGRESSES vs. the champion's (present on both)", async () => {
    const e = new EvolutionEngine({
      champion: champWithMO(0.05),
      grader: new MockGrader({ mo: { ...GOOD, policyId: "mo", measuredOutcome: { incrementalLift: 0.02, relativeLift: 0.02 } } }),
    });
    e.propose(P("mo"));
    const rec = await e.evaluate("mo");
    expect(rec.status).toBe("blocked");
    expect(rec.gate?.reasons).toContain("measured-outcome-regressed");
  });

  it("PASSES a candidate whose measuredOutcome IMPROVES on the champion's (present on both, non-regressive)", async () => {
    const e = new EvolutionEngine({
      champion: champWithMO(0.05),
      grader: new MockGrader({ mo: { ...GOOD, policyId: "mo", measuredOutcome: { incrementalLift: 0.08, relativeLift: 0.08 } } }),
    });
    e.propose(P("mo"));
    const rec = await e.evaluate("mo");
    expect(rec.status).toBe("awaiting_approval");
    expect(rec.gate?.pass).toBe(true);
  });

  it("FAILS CLOSED — a candidate whose measuredOutcome.incrementalLift is NON-FINITE (NaN) blocks (never silently passes)", async () => {
    const e = new EvolutionEngine({
      champion: champWithMO(0.05),
      // relativeLift alone is a valid, non-regressive 0.08 — isolates that it is incrementalLift's NaN
      // (still checked, never relaxed by NOW-2) that trips the malformed block, not a missing relativeLift.
      grader: new MockGrader({ mo: { ...GOOD, policyId: "mo", measuredOutcome: { incrementalLift: NaN, relativeLift: 0.08 } } }),
    });
    e.propose(P("mo"));
    const rec = await e.evaluate("mo");
    expect(rec.status).toBe("blocked");
    expect(rec.gate?.reasons).toContain("measured-outcome-invalid");
  });

  it("FAILS CLOSED (durability NOW-2) — a candidate whose measuredOutcome.relativeLift is NON-FINITE (NaN) blocks, even with a valid incrementalLift", async () => {
    const e = new EvolutionEngine({
      champion: champWithMO(0.05),
      grader: new MockGrader({ mo: { ...GOOD, policyId: "mo", measuredOutcome: { incrementalLift: 0.08, relativeLift: NaN } } }),
    });
    e.propose(P("mo"));
    const rec = await e.evaluate("mo");
    expect(rec.status).toBe("blocked");
    expect(rec.gate?.reasons).toContain("measured-outcome-invalid");
  });

  it("FAILS CLOSED — a candidate WITH a measuredOutcome but a champion baseline WITHOUT one blocks (no baseline to compare)", async () => {
    const e = new EvolutionEngine({
      champion, // no measuredOutcome
      grader: new MockGrader({ mo: { ...GOOD, policyId: "mo", measuredOutcome: { incrementalLift: 0.5, relativeLift: 0.5 } } }),
    });
    e.propose(P("mo"));
    const rec = await e.evaluate("mo");
    expect(rec.status).toBe("blocked");
    expect(rec.gate?.reasons).toContain("measured-outcome-baseline-absent");
  });
});

// Durability NOW-2 (security review) — the core fix: the gate must compare the RATE-normalized
// `relativeLift`, never the absolute, exposure-scaled `incrementalLift`, so a candidate cannot "win" a
// promotion purely by having run on higher-volume traffic than the champion.
describe("EvolutionEngine gate — durability NOW-2: rate-normalized comparison (relativeLift, not incrementalLift)", () => {
  const champWithMO = (relativeLift: number, incrementalLift = relativeLift) => ({
    policy: DEFAULT_POLICY,
    metrics: { ...champion.metrics, measuredOutcome: { incrementalLift, relativeLift } } as PolicyMetrics,
  });

  it("a candidate with a HIGHER absolute incrementalLift but a LOWER relativeLift BLOCKS — never wins purely on volume", async () => {
    const e = new EvolutionEngine({
      // Champion: low absolute lift (low traffic) but a healthy 50% per-exposure rate.
      champion: champWithMO(0.5, 100),
      // Candidate: a much bigger ABSOLUTE lift (5000 >> 100 — ran on far more traffic) but converts
      // WORSE per shopper (10% relative lift < the champion's 50%). Must still block.
      grader: new MockGrader({ mo: { ...GOOD, policyId: "mo", measuredOutcome: { incrementalLift: 5000, relativeLift: 0.1 } } }),
    });
    e.propose(P("mo"));
    const rec = await e.evaluate("mo");
    expect(rec.status).toBe("blocked");
    expect(rec.gate?.reasons).toContain("measured-outcome-regressed");
  });

  it("a candidate with a LOWER absolute incrementalLift but a HIGHER relativeLift PASSES — a genuinely higher-rate win is not penalized for lower volume", async () => {
    const e = new EvolutionEngine({
      // Champion: a big absolute lift purely from high traffic, but a weak 10% per-exposure rate.
      champion: champWithMO(0.1, 5000),
      // Candidate: a much SMALLER absolute lift (100 << 5000) but a genuinely better 50% per-shopper rate.
      grader: new MockGrader({ mo: { ...GOOD, policyId: "mo", measuredOutcome: { incrementalLift: 100, relativeLift: 0.5 } } }),
    });
    e.propose(P("mo"));
    const rec = await e.evaluate("mo");
    expect(rec.status).toBe("awaiting_approval");
    expect(rec.gate?.pass).toBe(true);
    expect(rec.gate?.reasons).not.toContain("measured-outcome-regressed");
  });
});

// Revenue-flywheel Wave-2 (D) — the power-floor ENFORCEMENT on top of the Wave-1 (D) seam above. `power`
// absent (every test above) preserves Wave-1's unconditional enforcement exactly; these tests exercise
// the NEW behavior that only activates when a caller EXPLICITLY supplies `power`.
describe("EvolutionEngine gate — measured-outcome POWER FLOOR (Wave-2 D)", () => {
  const champPowered = (relativeLift: number, power: number, incrementalLift = relativeLift) => ({
    policy: DEFAULT_POLICY,
    metrics: { ...champion.metrics, measuredOutcome: { incrementalLift, relativeLift, power } } as PolicyMetrics,
  });

  it("(b) present + POWERED + POSITIVE lift vs. a powered champion baseline ⇒ gate allows", async () => {
    const e = new EvolutionEngine({
      champion: champPowered(0.05, 0.95),
      grader: new MockGrader({ mo: { ...GOOD, policyId: "mo", measuredOutcome: { incrementalLift: 0.08, relativeLift: 0.08, power: 0.95 } } }),
    });
    e.propose(P("mo"));
    const rec = await e.evaluate("mo");
    expect(rec.status).toBe("awaiting_approval");
    expect(rec.gate?.pass).toBe(true);
  });

  it("(c) present + POWERED + NEGATIVE lift vs. a powered champion baseline ⇒ gate BLOCKS", async () => {
    const e = new EvolutionEngine({
      champion: champPowered(0.05, 0.95),
      grader: new MockGrader({ mo: { ...GOOD, policyId: "mo", measuredOutcome: { incrementalLift: 0.02, relativeLift: 0.02, power: 0.95 } } }),
    });
    e.propose(P("mo"));
    const rec = await e.evaluate("mo");
    expect(rec.status).toBe("blocked");
    expect(rec.gate?.reasons).toContain("measured-outcome-regressed");
  });

  it("(d) present but UNDERPOWERED (candidate side) ⇒ does NOT block on the regressed lift — falls back to the proxy, which passes", async () => {
    const e = new EvolutionEngine({
      champion: champPowered(0.05, 0.95),
      // The rate itself REGRESSES (0.02 < 0.05), but the candidate's OWN measurement is far below the
      // floor — too noisy to trust in EITHER direction, so the gate must not block on it.
      grader: new MockGrader({ mo: { ...GOOD, policyId: "mo", measuredOutcome: { incrementalLift: 0.02, relativeLift: 0.02, power: 0.1 } } }),
    });
    e.propose(P("mo"));
    const rec = await e.evaluate("mo");
    expect(rec.status).toBe("awaiting_approval");
    expect(rec.gate?.pass).toBe(true);
    expect(rec.gate?.reasons).not.toContain("measured-outcome-regressed");
    expect(rec.gate?.reasons).toContain("measured-outcome-underpowered-fallback-to-proxy");
  });

  it("(d) present but UNDERPOWERED (champion baseline side) ⇒ also falls back to the proxy", async () => {
    const e = new EvolutionEngine({
      champion: champPowered(0.05, 0.2), // champion's OWN baseline measurement is underpowered
      grader: new MockGrader({ mo: { ...GOOD, policyId: "mo", measuredOutcome: { incrementalLift: 0.02, relativeLift: 0.02, power: 0.95 } } }),
    });
    e.propose(P("mo"));
    const rec = await e.evaluate("mo");
    expect(rec.status).toBe("awaiting_approval");
    expect(rec.gate?.pass).toBe(true);
    expect(rec.gate?.reasons).not.toContain("measured-outcome-regressed");
  });

  it("(d) a NON-FINITE lift still BLOCKS even though `power` is present and adequate — malformed is never merely 'underpowered'", async () => {
    const e = new EvolutionEngine({
      champion: champPowered(0.05, 0.95),
      grader: new MockGrader({ mo: { ...GOOD, policyId: "mo", measuredOutcome: { incrementalLift: NaN, relativeLift: 0.5, power: 0.99 } } }),
    });
    e.propose(P("mo"));
    const rec = await e.evaluate("mo");
    expect(rec.status).toBe("blocked");
    expect(rec.gate?.reasons).toContain("measured-outcome-invalid");
  });

  it("(d, durability NOW-2) a NON-FINITE relativeLift still BLOCKS even though `power` is present and adequate — malformed is never merely 'underpowered'", async () => {
    const e = new EvolutionEngine({
      champion: champPowered(0.05, 0.95),
      grader: new MockGrader({ mo: { ...GOOD, policyId: "mo", measuredOutcome: { incrementalLift: 0.5, relativeLift: NaN, power: 0.99 } } }),
    });
    e.propose(P("mo"));
    const rec = await e.evaluate("mo");
    expect(rec.status).toBe("blocked");
    expect(rec.gate?.reasons).toContain("measured-outcome-invalid");
  });

  it("underpowered ALSO bypasses the baseline-absent check (no champion measuredOutcome at all)", async () => {
    const e = new EvolutionEngine({
      champion, // no measuredOutcome whatsoever
      grader: new MockGrader({ mo: { ...GOOD, policyId: "mo", measuredOutcome: { incrementalLift: 0.5, relativeLift: 0.5, power: 0.05 } } }),
    });
    e.propose(P("mo"));
    const rec = await e.evaluate("mo");
    expect(rec.status).toBe("awaiting_approval");
    expect(rec.gate?.pass).toBe(true);
    expect(rec.gate?.reasons).not.toContain("measured-outcome-baseline-absent");
  });

  it("power exactly AT the floor is adequate (>=, not >)", async () => {
    const e = new EvolutionEngine({
      champion: champPowered(0.05, MEASURED_OUTCOME_POWER_FLOOR),
      grader: new MockGrader({ mo: { ...GOOD, policyId: "mo", measuredOutcome: { incrementalLift: 0.02, relativeLift: 0.02, power: MEASURED_OUTCOME_POWER_FLOOR } } }),
    });
    e.propose(P("mo"));
    const rec = await e.evaluate("mo");
    // at-floor is adequate ⇒ trusted ⇒ the regressed lift (0.02 < 0.05) BLOCKS, same as (c).
    expect(rec.status).toBe("blocked");
    expect(rec.gate?.reasons).toContain("measured-outcome-regressed");
  });

  it("(durability NOW-2) a candidate with a HIGHER absolute lift but LOWER relativeLift still BLOCKS even when both sides are well-powered", async () => {
    const e = new EvolutionEngine({
      champion: champPowered(0.5, 0.95, 100), // low volume, high 50% rate
      grader: new MockGrader({ mo: { ...GOOD, policyId: "mo", measuredOutcome: { incrementalLift: 5000, relativeLift: 0.1, power: 0.95 } } }),
    });
    e.propose(P("mo"));
    const rec = await e.evaluate("mo");
    expect(rec.status).toBe("blocked");
    expect(rec.gate?.reasons).toContain("measured-outcome-regressed");
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

// Revenue-flywheel Wave-2 (D) — `regressionVerdict` PREFERS a trustworthy, comparable measured lift over
// the caller-attested qualityScore. This is the pure engine half of item (e); the control-plane half
// (monitorServing actually reverting serving on this verdict) is covered in control-plane's test suite.
describe("EvolutionEngine.regressionVerdict — measured-outcome preference (Wave-2 D)", () => {
  // durability NOW-2: the comparison is on `relativeLift` (rate-normalized), never the absolute
  // `incrementalLift` — see `gate()`'s header comment on the same seam. `incrementalLift` still rides
  // along (defaults to the same value as `relativeLift` unless a test explicitly diverges them) for the
  // malformed/non-finite fail-closed check.
  const champWithMO = (relativeLift: number, power?: number, incrementalLift = relativeLift) => ({
    policy: DEFAULT_POLICY,
    metrics: {
      ...champion.metrics,
      measuredOutcome: power === undefined ? { incrementalLift, relativeLift } : { incrementalLift, relativeLift, power },
    } as PolicyMetrics,
  });

  it("(a) measuredOutcome absent on the observation ⇒ byte-identical to the qualityScore-only verdict", () => {
    const e = engineWith({ good: GOOD });
    expect(e.regressionVerdict({ qualityScore: 0.5, safetyPass: true })).toEqual({ regressed: true, reason: "quality-regression" });
    expect(e.regressionVerdict({ qualityScore: 0.9, safetyPass: true })).toEqual({ regressed: false });
  });

  it("(e) PREFERS a trustworthy measured-lift regression over a HEALTHY caller-attested qualityScore", () => {
    const e = new EvolutionEngine({ champion: champWithMO(0.05, 0.95), grader: new MockGrader({}) });
    // qualityScore looks great (0.99 >> champion's 0.75) — the OLD proxy-only verdict would say healthy.
    const verdict = e.regressionVerdict({ qualityScore: 0.99, safetyPass: true, measuredOutcome: { incrementalLift: 0.01, relativeLift: 0.01, power: 0.95 } });
    expect(verdict).toEqual({ regressed: true, reason: "measured-outcome-regression" });
  });

  it("a trustworthy measured lift that did NOT regress reports healthy even if isolated from qualityScore", () => {
    const e = new EvolutionEngine({ champion: champWithMO(0.05, 0.95), grader: new MockGrader({}) });
    const verdict = e.regressionVerdict({ qualityScore: 0.01, safetyPass: true, measuredOutcome: { incrementalLift: 0.08, relativeLift: 0.08, power: 0.95 } });
    expect(verdict).toEqual({ regressed: false });
  });

  it("underpowered measured lift ⇒ falls back to the caller-attested qualityScore ('else keep attested')", () => {
    const e = new EvolutionEngine({ champion: champWithMO(0.05, 0.95), grader: new MockGrader({}) });
    const verdict = e.regressionVerdict({ qualityScore: 0.5, safetyPass: true, measuredOutcome: { incrementalLift: 0.01, relativeLift: 0.01, power: 0.1 } });
    expect(verdict).toEqual({ regressed: true, reason: "quality-regression" });
  });

  // HIGH fix (review, W3-2 follow-up) — symmetric with `gate()`'s `powerAdequate` check on BOTH sides.
  // Before the fix, `preferMeasured` only checked `observedMO.power`; an UNDERPOWERED bar (e.g. a thin
  // gate-time ledger read, power:0) would still be treated as "comparable", so a well-powered observation
  // that beat that meaningless bar on the measured lift alone would report healthy — SUPPRESSING a real
  // quality regression the proxy would have caught. The fix requires the bar to also clear
  // `powerAdequate`, so this case now falls straight through to the qualityScore check instead.
  it("HIGH fix: an UNDERPOWERED bar + a well-powered observation ⇒ preferMeasured is false — falls back to qualityScore, regression is NOT suppressed", () => {
    // Bar's own measuredOutcome is present but power:0 (underpowered) — e.g. a thin gate-time read.
    const e = new EvolutionEngine({ champion: champWithMO(0.05, 0), grader: new MockGrader({}) });
    // The OBSERVATION is well-powered and shows a POSITIVE lift vs. the (untrustworthy) bar — the OLD,
    // asymmetric check would have called this "comparable" (only observedMO's power mattered) and
    // reported healthy purely on the lift beating 0.05. qualityScore, meanwhile, genuinely regressed
    // (0.5 < the champion's 0.75 baseline — see `champion` in this file's shared fixtures).
    const verdict = e.regressionVerdict({
      qualityScore: 0.5,
      safetyPass: true,
      measuredOutcome: { incrementalLift: 0.5, relativeLift: 0.5, power: 0.99 },
    });
    expect(verdict).toEqual({ regressed: true, reason: "quality-regression" }); // NOT suppressed as healthy
  });

  it("HIGH fix, confirmed unaffected: BOTH sides powered still prefers the measured verdict (regression case, (e) above) and the non-regression case", () => {
    const e = new EvolutionEngine({ champion: champWithMO(0.05, 0.95), grader: new MockGrader({}) });
    // Regression: qualityScore looks healthy but the powered-both-sides measured lift regressed.
    expect(
      e.regressionVerdict({ qualityScore: 0.99, safetyPass: true, measuredOutcome: { incrementalLift: 0.01, relativeLift: 0.01, power: 0.95 } }),
    ).toEqual({ regressed: true, reason: "measured-outcome-regression" });
    // Healthy: qualityScore looks bad but the powered-both-sides measured lift did not regress.
    expect(
      e.regressionVerdict({ qualityScore: 0.01, safetyPass: true, measuredOutcome: { incrementalLift: 0.08, relativeLift: 0.08, power: 0.95 } }),
    ).toEqual({ regressed: false });
  });

  it("no baseline measuredOutcome to compare against ⇒ falls back to qualityScore", () => {
    const e = engineWith({ good: GOOD }); // champion carries no measuredOutcome
    const verdict = e.regressionVerdict({ qualityScore: 0.9, safetyPass: true, measuredOutcome: { incrementalLift: -5, relativeLift: -5, power: 0.95 } });
    expect(verdict).toEqual({ regressed: false });
  });

  it("a safety failure always regresses regardless of a positive measured lift", () => {
    const e = new EvolutionEngine({ champion: champWithMO(0.05, 0.95), grader: new MockGrader({}) });
    const verdict = e.regressionVerdict({ qualityScore: 0.99, safetyPass: false, measuredOutcome: { incrementalLift: 100, relativeLift: 100, power: 0.99 } });
    expect(verdict).toEqual({ regressed: true, reason: "safety-regression" });
  });

  // Durability NOW-2 — the core fix, at the regressionVerdict layer: a HIGHER absolute incrementalLift
  // must never mask a LOWER relativeLift, and vice versa.
  it("(durability NOW-2) a HIGHER absolute lift but LOWER relativeLift observation ⇒ regressed — never healthy purely on volume", () => {
    const e = new EvolutionEngine({ champion: champWithMO(0.5, 0.95, 100), grader: new MockGrader({}) }); // low volume, high 50% rate bar
    const verdict = e.regressionVerdict({
      qualityScore: 0.99, // looks healthy on the proxy
      safetyPass: true,
      measuredOutcome: { incrementalLift: 5000, relativeLift: 0.1, power: 0.95 }, // huge absolute lift, worse per-shopper rate
    });
    expect(verdict).toEqual({ regressed: true, reason: "measured-outcome-regression" });
  });

  it("(durability NOW-2) a LOWER absolute lift but HIGHER relativeLift observation ⇒ healthy — not penalized for lower volume", () => {
    const e = new EvolutionEngine({ champion: champWithMO(0.1, 0.95, 5000), grader: new MockGrader({}) }); // high volume, weak 10% rate bar
    const verdict = e.regressionVerdict({
      qualityScore: 0.01, // looks bad on the proxy
      safetyPass: true,
      measuredOutcome: { incrementalLift: 100, relativeLift: 0.5, power: 0.95 }, // small absolute lift, genuinely better rate
    });
    expect(verdict).toEqual({ regressed: false });
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
