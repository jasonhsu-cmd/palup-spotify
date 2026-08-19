import { describe, it, expect } from "vitest";
import { InMemoryRuntimeStore } from "@palup/platform-ports";
import { DEFAULT_POLICY, type Policy } from "@palup/widget-brain";
import { EvolutionEngine, MockGrader, type PolicyMetrics } from "@palup/evolution";
import { promoteToServing, servingChampion, monitorServing } from "../src/champion-promoter.js";

// Revenue-flywheel Wave-2 (D), item 4 + acceptance (a)/(e) — `monitorServing` PREFERS a trustworthy,
// comparable measured lift over the caller-attested `qualityScore` WHEN present; absent (every existing
// caller — durable-rollback.test.ts) it stays byte-identical.

const BASE_CM = { returnRate: 0.08, complaintRate: 0.03, optOutRate: 0.1, escalationRecall: 1, personaPriceInvariance: 1, personaLeakRate: 0 };
const P = (id: string): Policy => ({ id, label: id, styleDirective: `voice-${id}`, proactivityDefault: "balanced" });
const T = "demo";

/** Champion whose OWN recorded metrics carry a measuredOutcome baseline (0.05 incremental lift), so a
 * later observation's measured lift is COMPARABLE against it (the "bar" `regressionVerdict` reads). */
const mkEngine = () =>
  new EvolutionEngine({
    champion: {
      policy: DEFAULT_POLICY,
      metrics: { policyId: DEFAULT_POLICY.id, safetyPass: true, floorPass: true, qualityScore: 0.75, counterMetrics: BASE_CM, measuredOutcome: { incrementalLift: 0.05, relativeLift: 0.05, power: 0.95 } } as PolicyMetrics,
    },
    grader: new MockGrader({
      cand: { policyId: "cand", safetyPass: true, floorPass: true, qualityScore: 0.9, counterMetrics: { ...BASE_CM, returnRate: 0.06, optOutRate: 0.08 } },
    }),
  });

/** propose → gate → stage (§3 NN#2) → human approve → durable promote. */
async function promote(engine: EvolutionEngine, store: InMemoryRuntimeStore, id: string) {
  engine.propose(P(id));
  await engine.evaluate(id);
  engine.beginStaging(id);
  engine.recordShadow(id, { n: 200, delta: 0.02, at: "2026-08-05T00:00:00Z" }, { maxRegression: 0.05 });
  engine.recordCanary(id, { n: 500, delta: 0.02, elapsedMs: 3_600_000, at: "2026-08-05T01:00:00Z" }, { minN: 100, minWindowMs: 600_000, minDelta: -0.01 });
  engine.approve(id, "jane.operator");
  await promoteToServing(engine, id, store, T);
}

describe("monitorServing — measured-outcome preference (Wave-2 D)", () => {
  it("(a) absent measuredOutcome ⇒ byte-identical to the qualityScore-only verdict (dormancy pin)", async () => {
    const store = new InMemoryRuntimeStore();
    const engine = mkEngine();
    await promote(engine, store, "cand");

    const r = await monitorServing(engine, store, T, { qualityScore: 0.99, safetyPass: true });

    expect(r.rolledBack).toBe(false);
    expect(r.confirmedKnownGood).toBe(true);
    expect((await servingChampion(store, T))?.policy.id).toBe("cand");
  });

  it("(e) a trustworthy, comparable measured-lift REGRESSION rolls back serving even though qualityScore looks healthy", async () => {
    const store = new InMemoryRuntimeStore();
    const engine = mkEngine();
    await promote(engine, store, "cand");
    expect((await servingChampion(store, T))?.policy.id).toBe("cand");

    // qualityScore (0.99) is well above the bar (0.75) — the OLD proxy-only verdict would call this
    // healthy. The measured lift (0.01) REGRESSED vs. the champion's own baseline (0.05).
    const r = await monitorServing(engine, store, T, {
      qualityScore: 0.99,
      safetyPass: true,
      measuredOutcome: { incrementalLift: 0.01, relativeLift: 0.01, power: 0.95 },
    });

    expect(r.rolledBack).toBe(true);
    expect(r.reason).toBe("measured-outcome-regression");
    expect((await servingChampion(store, T))?.policy.id).toBe(DEFAULT_POLICY.id); // shoppers actually moved
    const actions = (await store.readAudit({ tenantId: T })).map((a) => a.action);
    expect(actions).toContain("champion.rollback");
  });

  it("a trustworthy, comparable measured lift that did NOT regress is healthy — confirms known-good, never touches serving", async () => {
    const store = new InMemoryRuntimeStore();
    const engine = mkEngine();
    await promote(engine, store, "cand");

    const r = await monitorServing(engine, store, T, {
      qualityScore: 0.01, // would look like a regression on the OLD proxy-only path
      safetyPass: true,
      measuredOutcome: { incrementalLift: 0.08, relativeLift: 0.08, power: 0.95 },
    });

    expect(r.rolledBack).toBe(false);
    expect(r.confirmedKnownGood).toBe(true);
    expect((await servingChampion(store, T))?.policy.id).toBe("cand");
  });

  it("an UNDERPOWERED measured lift falls back to the caller-attested qualityScore ('else keep attested')", async () => {
    const store = new InMemoryRuntimeStore();
    const engine = mkEngine();
    await promote(engine, store, "cand");

    const r = await monitorServing(engine, store, T, {
      qualityScore: 0.1, // BELOW the bar (0.75) ⇒ the fallback should regress
      safetyPass: true,
      measuredOutcome: { incrementalLift: -50, relativeLift: -50, power: 0.1 }, // present but far below the floor
    });

    expect(r.rolledBack).toBe(true);
    expect(r.reason).toBe("quality-regression"); // NOT "measured-outcome-regression" — untrusted signal ignored
    expect((await servingChampion(store, T))?.policy.id).toBe(DEFAULT_POLICY.id);
  });

  it("a safety failure rolls back regardless of a positive measured lift", async () => {
    const store = new InMemoryRuntimeStore();
    const engine = mkEngine();
    await promote(engine, store, "cand");

    const r = await monitorServing(engine, store, T, {
      qualityScore: 0.99,
      safetyPass: false,
      measuredOutcome: { incrementalLift: 1000, relativeLift: 1000, power: 0.99 },
    });

    expect(r.rolledBack).toBe(true);
    expect(r.reason).toBe("safety-regression");
  });

  // Durability NOW-2 — the core fix, at the monitorServing layer: a candidate must not be able to mask a
  // rate regression behind a bigger absolute number, nor be penalized for a smaller absolute number when
  // its rate is genuinely better.
  it("(durability NOW-2) a HIGHER absolute lift but LOWER relativeLift rolls back — never healthy purely on volume", async () => {
    const store = new InMemoryRuntimeStore();
    const engine = mkEngine(); // champion baseline: incrementalLift 0.05, relativeLift 0.05, power 0.95
    await promote(engine, store, "cand");

    const r = await monitorServing(engine, store, T, {
      qualityScore: 0.99, // looks healthy on the proxy
      safetyPass: true,
      measuredOutcome: { incrementalLift: 5000, relativeLift: 0.01, power: 0.95 }, // huge absolute, worse rate
    });

    expect(r.rolledBack).toBe(true);
    expect(r.reason).toBe("measured-outcome-regression");
  });

  it("(durability NOW-2) a LOWER absolute lift but HIGHER relativeLift is healthy — not penalized for lower volume", async () => {
    const store = new InMemoryRuntimeStore();
    const engine = mkEngine();
    await promote(engine, store, "cand");

    const r = await monitorServing(engine, store, T, {
      qualityScore: 0.01, // looks bad on the proxy
      safetyPass: true,
      measuredOutcome: { incrementalLift: 0.001, relativeLift: 0.9, power: 0.95 }, // tiny absolute, genuinely better rate
    });

    expect(r.rolledBack).toBe(false);
    expect(r.confirmedKnownGood).toBe(true);
  });
});
