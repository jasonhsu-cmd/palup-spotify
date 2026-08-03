import { describe, it, expect } from "vitest";
import { InMemoryRuntimeStore, type RuntimeStatePort } from "@palup/platform-ports";
import { armKill } from "@palup/state-postgres";
import { DEFAULT_POLICY, type Policy } from "@palup/widget-brain";
import { EvolutionEngine, MockGrader, type PolicyMetrics } from "@palup/evolution";
import { promoteToServing, rollbackServing, servingChampion } from "../src/champion-promoter.js";

// promote→serving (ADR-0003): a HUMAN-APPROVED, gate-passed promotion — and NOTHING else — reaches
// serving, and the transition survives a store fault. engine.promote is NOT the whole gate: the bridge
// independently verifies the approval was HUMAN (not "auto-loop"), fails closed on the shared kill
// registry, and writes the durable serving store BEFORE advancing the engine.

// Complete counter-metrics on both baseline + candidate (ADR-0014 #5 fail-closed gate) so the candidate
// passes the gate and this suite can exercise the promote→serving bridge (its actual subject).
const BASE_CM = { returnRate: 0.08, complaintRate: 0.03, optOutRate: 0.1, escalationRecall: 1 };
const CHAMP_METRICS: PolicyMetrics = { policyId: DEFAULT_POLICY.id, safetyPass: true, floorPass: true, qualityScore: 0.75, counterMetrics: BASE_CM };
const P = (id: string): Policy => ({ id, label: id, styleDirective: `voice-${id}`, proactivityDefault: "balanced" });
const mkEngine = () =>
  new EvolutionEngine({
    champion: { policy: DEFAULT_POLICY, metrics: CHAMP_METRICS },
    grader: new MockGrader({ cand: { policyId: "cand", safetyPass: true, floorPass: true, qualityScore: 0.9, counterMetrics: { ...BASE_CM, returnRate: 0.06, optOutRate: 0.08 } } }),
  });
const readyCandidate = async (engine: EvolutionEngine) => {
  engine.propose(P("cand"));
  await engine.evaluate("cand"); // gate passes → awaiting_approval
};

describe("promote→serving bridge (ADR-0003: only a human-approved promotion reaches serving)", () => {
  it("refuses to write a serving champion for an UN-approved candidate (no human approval yet)", async () => {
    const store = new InMemoryRuntimeStore();
    const engine = mkEngine();
    await readyCandidate(engine); // awaiting_approval, NOT approved
    await expect(promoteToServing(engine, "cand", store, "demo")).rejects.toThrow(/needs human approval/i);
    expect(await servingChampion(store, "demo")).toBeNull(); // ⇒ serving falls back to DEFAULT_POLICY
  });

  it("REFUSES an AUTO-LOOP-approved candidate — 'approved' ≠ 'human-approved' (no self-deployment)", async () => {
    const store = new InMemoryRuntimeStore();
    const engine = mkEngine();
    await readyCandidate(engine);
    engine.approve("cand", "auto-loop"); // automated approval reaches status "approved"
    await expect(promoteToServing(engine, "cand", store, "demo")).rejects.toThrow(/not HUMAN-approved/i);
    expect(await servingChampion(store, "demo")).toBeNull();
  });

  it("fails closed on the SHARED kill registry (armKill) — not just the engine's own flag", async () => {
    const store = new InMemoryRuntimeStore();
    const engine = mkEngine();
    await readyCandidate(engine);
    engine.approve("cand"); // human
    await armKill(store, "global", "operator-halt"); // shared registry armed; engine flag NOT armed
    await expect(promoteToServing(engine, "cand", store, "demo")).rejects.toThrow(/kill switch armed/i);
    expect(await servingChampion(store, "demo")).toBeNull();
  });

  it("with the engine kill switch ON, refuses to promote and writes nothing", async () => {
    const store = new InMemoryRuntimeStore();
    const engine = mkEngine();
    await readyCandidate(engine);
    engine.approve("cand");
    engine.kill("test-halt");
    await expect(promoteToServing(engine, "cand", store, "demo")).rejects.toThrow(/kill switch/i);
    expect(await servingChampion(store, "demo")).toBeNull();
  });

  it("a HUMAN-approved, gate-passed candidate is promoted to serving + audited to the human approver (NN #5)", async () => {
    const store = new InMemoryRuntimeStore();
    const engine = mkEngine();
    await readyCandidate(engine);
    engine.approve("cand", "jane.operator"); // ← the HUMAN gate, recorded on the candidate
    const champ = await promoteToServing(engine, "cand", store, "demo");
    expect(champ.policy.id).toBe("cand");
    const served = await servingChampion(store, "demo");
    expect(served?.policy.id).toBe("cand");
    expect(served?.promotedFrom).toBe(DEFAULT_POLICY.id);
    expect(served?.approvedBy).toBe("jane.operator");
    const audit = await store.readAudit({ tenantId: "demo" });
    const promoteEntry = audit.find((a) => a.action === "champion.promote");
    expect(promoteEntry).toBeTruthy();
    expect(promoteEntry?.actor).toBe("jane.operator"); // bound to the recorded human approver, not free text
    expect((await store.verifyAudit({ tenantId: "demo" })).ok).toBe(true); // hash-chain intact
  });

  it("rollbackServing restores the previous champion in the store + audits it", async () => {
    const store = new InMemoryRuntimeStore();
    const engine = mkEngine();
    await readyCandidate(engine);
    engine.approve("cand");
    await promoteToServing(engine, "cand", store, "demo");
    await rollbackServing(engine, store, "demo", "quality-regression");
    expect((await servingChampion(store, "demo"))?.policy.id).toBe(DEFAULT_POLICY.id);
    expect((await store.readAudit({ tenantId: "demo" })).map((a) => a.action)).toContain("champion.rollback");
  });

  it("a store fault during rollback leaves prevChampion intact so a retry recovers (auto-rollback survives)", async () => {
    const store = new InMemoryRuntimeStore();
    const engine = mkEngine();
    await readyCandidate(engine);
    engine.approve("cand");
    await promoteToServing(engine, "cand", store, "demo"); // champion=cand, prevChampion=DEFAULT
    const failing = { tx: async () => { throw new Error("store fault"); } } as unknown as RuntimeStatePort;
    await expect(rollbackServing(engine, failing, "demo", "regression")).rejects.toThrow(/store fault/);
    // Engine NOT mutated by the failed write ⇒ prevChampion still recoverable (was stranded null before).
    expect(engine.getPreviousChampion()?.policy.id).toBe(DEFAULT_POLICY.id);
    await rollbackServing(engine, store, "demo", "regression-retry"); // retry on a healthy store recovers
    expect((await servingChampion(store, "demo"))?.policy.id).toBe(DEFAULT_POLICY.id);
  });

  it("a promotion for tenant A never becomes tenant B's serving champion (blast-radius isolation)", async () => {
    const store = new InMemoryRuntimeStore();
    const engine = mkEngine();
    await readyCandidate(engine);
    engine.approve("cand");
    await promoteToServing(engine, "cand", store, "tenant-a");
    expect(await servingChampion(store, "tenant-b")).toBeNull();
  });
});
