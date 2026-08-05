import { describe, it, expect } from "vitest";
import { InMemoryRuntimeStore } from "@palup/platform-ports";
import { readOrchestratorState } from "@palup/state-postgres";
import { DEFAULT_POLICY, type Policy } from "@palup/widget-brain";
import { EvolutionEngine, MockGrader, type PolicyMetrics } from "@palup/evolution";
import { promoteToServing, servingChampion, monitorServing } from "../src/champion-promoter.js";
import { readKnownGood } from "../src/known-good-baseline.js";

// ADR-0003's CORE PROMISE — "automatic rollback on regression" — did not exist in a deployable form.
//
// THE DEFECT. The only wired monitor route called `engine.monitor()`, which rolls back the engine's
// IN-MEMORY champion and nothing else. The DURABLE serving champion (CHAMPION/active, the row
// widget-backend reads on every /chat turn via readActiveChampion) was never touched — so after a
// detected regression the shopper kept being served the regressing policy indefinitely, while the
// control-plane dashboard showed a successful rollback. `rollbackServing`, which does the durable revert
// AND freezes the auto-promote fast-lane, existed, was tested, and had NO CALLER.
//
// Compounding it: `recordKnownGood` also had no non-test caller, so the durable baseline was permanently
// null and `delayedRollbackToBaseline` — the ONLY mechanism that can revert further than the engine's
// depth-1 prevChampion — could do nothing but throw. ADR-0014 prereq #10 is listed as BLOCKING.
//
// `monitorServing` is the wiring: it decides from the engine (read-only), then acts on the STORE.

const BASE_CM = { returnRate: 0.08, complaintRate: 0.03, optOutRate: 0.1, escalationRecall: 1, personaPriceInvariance: 1, personaLeakRate: 0 };
const CHAMP_METRICS: PolicyMetrics = { policyId: DEFAULT_POLICY.id, safetyPass: true, floorPass: true, qualityScore: 0.75, counterMetrics: BASE_CM };
const P = (id: string): Policy => ({ id, label: id, styleDirective: `voice-${id}`, proactivityDefault: "balanced" });
const T = "demo";

const mkEngine = () =>
  new EvolutionEngine({
    champion: { policy: DEFAULT_POLICY, metrics: CHAMP_METRICS },
    grader: new MockGrader({
      cand: { policyId: "cand", safetyPass: true, floorPass: true, qualityScore: 0.9, counterMetrics: { ...BASE_CM, returnRate: 0.06, optOutRate: 0.08 } },
      cand2: { policyId: "cand2", safetyPass: true, floorPass: true, qualityScore: 0.92, counterMetrics: { ...BASE_CM, returnRate: 0.05, optOutRate: 0.07 } },
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

const GOOD = { qualityScore: 0.95, safetyPass: true };
const BAD_QUALITY = { qualityScore: 0.1, safetyPass: true };
const BAD_SAFETY = { qualityScore: 0.99, safetyPass: false };

describe("durable rollback — a regression must change what SHOPPERS get, not just engine memory", () => {
  it("THE DEFECT: a quality regression reverts the DURABLE serving champion", async () => {
    const store = new InMemoryRuntimeStore();
    const engine = mkEngine();
    await promote(engine, store, "cand");
    expect((await servingChampion(store, T))?.policy.id).toBe("cand"); // shoppers are on `cand`

    const r = await monitorServing(engine, store, T, BAD_QUALITY);

    expect(r.rolledBack).toBe(true);
    expect(r.reason).toBe("quality-regression");
    // The assertion that actually matters: SERVING moved, so shoppers stop getting the bad policy.
    expect((await servingChampion(store, T))?.policy.id).toBe(DEFAULT_POLICY.id);
    expect(engine.getChampion().policy.id).toBe(DEFAULT_POLICY.id); // engine agrees
  });

  it("a SAFETY regression reverts serving too, and is labelled distinctly", async () => {
    const store = new InMemoryRuntimeStore();
    const engine = mkEngine();
    await promote(engine, store, "cand");

    const r = await monitorServing(engine, store, T, BAD_SAFETY);

    expect(r.reason).toBe("safety-regression");
    expect((await servingChampion(store, T))?.policy.id).toBe(DEFAULT_POLICY.id);
  });

  it("the rollback FREEZES the auto-promote fast-lane — the freeze lives inside rollbackServing, which had no caller", async () => {
    const store = new InMemoryRuntimeStore();
    const engine = mkEngine();
    await promote(engine, store, "cand");

    await monitorServing(engine, store, T, BAD_QUALITY);

    const orch = await readOrchestratorState(store, T);
    expect(orch?.frozenUntil).toBeTruthy();
  });

  it("a healthy observation records the serving champion as the durable KNOWN-GOOD baseline", async () => {
    const store = new InMemoryRuntimeStore();
    const engine = mkEngine();
    await promote(engine, store, "cand");
    expect(await readKnownGood(store, T)).toBeNull(); // nothing confirmed yet

    const r = await monitorServing(engine, store, T, GOOD);

    expect(r.rolledBack).toBe(false);
    expect(r.confirmedKnownGood).toBe(true);
    expect((await readKnownGood(store, T))?.policy.id).toBe("cand");
  });

  it("BEYOND DEPTH-1: with the engine's prevChampion spent, a later regression still reverts — to the known-good baseline", async () => {
    const store = new InMemoryRuntimeStore();
    const engine = mkEngine();

    await promote(engine, store, "cand");
    await monitorServing(engine, store, T, GOOD); // `cand` confirmed known-good
    await promote(engine, store, "cand2"); // serving = cand2, engine prev = cand

    // First regression consumes the engine's depth-1 prevChampion (rollback nulls it).
    await monitorServing(engine, store, T, BAD_QUALITY);
    expect((await servingChampion(store, T))?.policy.id).toBe("cand");
    expect(engine.getPreviousChampion()).toBeNull();

    // A SECOND regression with no depth-1 target left. Before this wiring that threw, or silently did
    // nothing, and serving stayed on the bad policy.
    const r = await monitorServing(engine, store, T, BAD_QUALITY);
    expect(r.rolledBack).toBe(true);
    expect(r.viaBaseline).toBe(true);
    expect((await servingChampion(store, T))?.policy.id).toBe("cand");
  });

  it("regressed with NO revert target at all: reports honestly and does NOT throw", async () => {
    const store = new InMemoryRuntimeStore();
    const engine = mkEngine();
    // Never promoted ⇒ no prevChampion, no baseline, nothing in the serving slot.
    const r = await monitorServing(engine, store, T, BAD_QUALITY);

    expect(r.rolledBack).toBe(false);
    expect(r.reason).toBe("no-revert-target");
    expect(await servingChampion(store, T)).toBeNull();
  });

  it("a healthy observation NEVER touches serving", async () => {
    const store = new InMemoryRuntimeStore();
    const engine = mkEngine();
    await promote(engine, store, "cand");

    await monitorServing(engine, store, T, GOOD);

    expect((await servingChampion(store, T))?.policy.id).toBe("cand"); // unchanged
    expect(engine.getChampion().policy.id).toBe("cand");
  });

  it("every rollback is on the immutable audit log with its reason", async () => {
    const store = new InMemoryRuntimeStore();
    const engine = mkEngine();
    await promote(engine, store, "cand");
    await monitorServing(engine, store, T, BAD_QUALITY);

    const actions = (await store.readAudit({ tenantId: T })).map((a) => a.action);
    expect(actions).toContain("champion.rollback");
  });
});
