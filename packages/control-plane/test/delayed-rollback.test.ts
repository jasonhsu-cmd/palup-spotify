import { describe, it, expect } from "vitest";
import { InMemoryRuntimeStore } from "@palup/platform-ports";
import { readOrchestratorState } from "@palup/state-postgres";
import { DEFAULT_POLICY, type Policy } from "@palup/widget-brain";
import { EvolutionEngine, MockGrader, type PolicyMetrics } from "@palup/evolution";
import { promoteToServing, servingChampion, delayedRollbackToBaseline } from "../src/champion-promoter.js";
import { recordKnownGood, readKnownGood } from "../src/known-good-baseline.js";

// ADR-0014 #10 — delayed-signal rollback to a DURABLE known-good baseline. When lagging return/complaint
// harm surfaces days-to-weeks AFTER a promotion, the engine's depth-1 prevChampion is not enough: several
// promotions may have happened since the last CONFIRMED-good champion. The known-good baseline is a
// durable, per-tenant record beyond depth-1; the delayed rollback auto-reverts serving to it and freezes
// the fast-lane (owner's choice: auto-revert self-heal, HITL §4).

const BASE_CM = { returnRate: 0.08, complaintRate: 0.03, optOutRate: 0.1, escalationRecall: 1 };
const CHAMP_METRICS: PolicyMetrics = { policyId: DEFAULT_POLICY.id, safetyPass: true, floorPass: true, qualityScore: 0.75, counterMetrics: BASE_CM };
const P = (id: string): Policy => ({ id, label: id, styleDirective: `voice-${id}`, proactivityDefault: "balanced" });
const mkEngine = () =>
  new EvolutionEngine({
    champion: { policy: DEFAULT_POLICY, metrics: CHAMP_METRICS },
    grader: new MockGrader({ C: { policyId: "C", safetyPass: true, floorPass: true, qualityScore: 0.9, counterMetrics: { ...BASE_CM, returnRate: 0.06 } } }),
  });

describe("delayed-signal rollback to a durable known-good baseline (ADR-0014 #10)", () => {
  it("reverts serving to the retained known-good — BEYOND the engine's depth-1 prevChampion — + freezes + audits", async () => {
    const store = new InMemoryRuntimeStore();
    const engine = mkEngine();
    // A distinct, earlier CONFIRMED-good policy — the durable baseline (not the engine's prevChampion).
    const A = P("known-good-A");
    await recordKnownGood(store, "acme", A, "2026-07-01T00:00:00Z");
    expect((await readKnownGood(store, "acme"))?.policy.id).toBe("known-good-A");

    // Meanwhile serving advanced to C via the human path (engine.prevChampion becomes DEFAULT_POLICY,
    // NOT A) — so depth-1 could only revert C→DEFAULT, never back to the known-good A.
    engine.propose(P("C"));
    await engine.evaluate("C");
    engine.approve("C", "jane.operator");
    await promoteToServing(engine, "C", store, "acme");
    expect((await servingChampion(store, "acme"))?.policy.id).toBe("C");
    expect(engine.getPreviousChampion()?.policy.id).toBe(DEFAULT_POLICY.id); // depth-1 = DEFAULT, not A

    // Lagging harm surfaces on C → delayed rollback to the durable known-good A.
    const restored = await delayedRollbackToBaseline(store, "acme", "lagging-return-harm", "2026-08-05T00:00:00Z");
    expect(restored.policy.id).toBe("known-good-A");
    expect((await servingChampion(store, "acme"))?.policy.id).toBe("known-good-A"); // reverted beyond depth-1
    // fast-lane frozen so the harmful change can't be re-promoted immediately
    expect((await readOrchestratorState(store, "acme")).frozenUntil).toBeTruthy();
    // audited as a delayed rollback
    expect((await store.readAudit({ tenantId: "acme" })).map((a) => a.action)).toContain("champion.delayed_rollback");
    expect((await store.verifyAudit({ tenantId: "acme" })).ok).toBe(true);
  });

  it("refuses to roll back when no known-good baseline was ever recorded (fail-closed)", async () => {
    const store = new InMemoryRuntimeStore();
    await expect(delayedRollbackToBaseline(store, "acme", "harm")).rejects.toThrow(/no known-good baseline/i);
  });

  it("a known-good recorded for tenant A is not visible to tenant B (blast-radius isolation)", async () => {
    const store = new InMemoryRuntimeStore();
    await recordKnownGood(store, "tenant-a", P("a-good"), "2026-07-01T00:00:00Z");
    expect(await readKnownGood(store, "tenant-b")).toBeNull();
  });
});
