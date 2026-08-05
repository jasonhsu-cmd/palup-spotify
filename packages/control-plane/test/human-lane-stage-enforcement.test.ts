import { describe, it, expect } from "vitest";
import { InMemoryRuntimeStore } from "@palup/platform-ports";
import { DEFAULT_POLICY, type Policy } from "@palup/widget-brain";
import { EvolutionEngine, MockGrader, type PolicyMetrics } from "@palup/evolution";
import { promoteToServing, servingChampion } from "../src/champion-promoter.js";

// CLAUDE.md §3 NON-NEGOTIABLE #2: "The only path to prod is propose → shadow → canary(1–5%) → eval gate
// → human approve → promote → monitored… Never bypass a stage." The same absolute appears in
// docs/ARCHITECTURE.md:170 ("No stage is skippable"), docs/AGENT-GOVERNANCE.md:19,
// docs/design/governance-subsystems.md:60, and ADR-0003 (Status: Accepted).
//
// THE HOLE THIS CLOSES. That absolute was enforced ONLY on the auto-optimize lane. `recordShadow` /
// `recordCanary` / `autoPromotable` form a real, well-tested stage machine — but every one of them keys
// off `rec.auto`, which only `beginAutoOptimize` ever created. The HUMAN lane never touched them:
//
//     propose → evaluate (gate) → approve → promoteToServing        ← reached 100% of live traffic
//
// `promoteToServing` checked the kill switch, `status === "approved"`, and that the approver was human —
// and NEVER a shadow or canary marker. So the one lane an operator can actually drive was the one lane
// with no stage enforcement, while the lane that HAS enforcement (auto) is dormant and gated off.
//
// It was not reachable in the deployed system only because the control-plane is not containerized
// (Dockerfile runs `pnpm backend` only) — i.e. the protection was an accident of deployment, not a
// control. Deploying the control-plane is exactly what production requires, which is why this lands
// BEFORE that and not after.
//
// SCOPE DECISION, stated rather than buried: this requires shadow + canary evidence for a human
// promotion. It deliberately does NOT newly require a positive cross-family gating grade
// (`metrics.gating === true`) for the human lane — `engine.gate()` intentionally accepts
// `gating === undefined` (the offline MockGrader path), and requiring it would make the human lane
// unusable wherever the live judge is not configured. The auto lane's stricter `gating === true`
// precondition is untouched. Whether a human promotion should ALSO require a positive live-judge grade
// is a real policy question and belongs to the named owner, not to this fix.

const BASE_CM = { returnRate: 0.08, complaintRate: 0.03, optOutRate: 0.1, escalationRecall: 1, personaPriceInvariance: 1, personaLeakRate: 0 };
const CHAMP_METRICS: PolicyMetrics = { policyId: DEFAULT_POLICY.id, safetyPass: true, floorPass: true, qualityScore: 0.75, counterMetrics: BASE_CM };
const P = (id: string): Policy => ({ id, label: id, styleDirective: `voice-${id}`, proactivityDefault: "balanced" });

const mkEngine = () =>
  new EvolutionEngine({
    champion: { policy: DEFAULT_POLICY, metrics: CHAMP_METRICS },
    grader: new MockGrader({ cand: { policyId: "cand", safetyPass: true, floorPass: true, qualityScore: 0.9, counterMetrics: { ...BASE_CM, returnRate: 0.06, optOutRate: 0.08 } } }),
  });

const gated = async (engine: EvolutionEngine) => {
  engine.propose(P("cand"));
  await engine.evaluate("cand"); // → awaiting_approval
};

/** The stages the human lane must now walk. Mirrors the auto lane's own thresholds. */
const stage = (engine: EvolutionEngine) => {
  engine.beginStaging("cand");
  engine.recordShadow("cand", { n: 200, delta: 0.02, at: "2026-08-05T00:00:00Z" }, { maxRegression: 0.05 });
  engine.recordCanary("cand", { n: 500, delta: 0.02, elapsedMs: 3_600_000, at: "2026-08-05T01:00:00Z" }, { minN: 100, minWindowMs: 600_000, minDelta: -0.01 });
};

describe("§3 NN#2 — the HUMAN lane cannot skip shadow or canary either", () => {
  it("THE HOLE: propose → gate → approve → promoteToServing is now REFUSED (it used to reach 100% of traffic)", async () => {
    const store = new InMemoryRuntimeStore();
    const engine = mkEngine();
    await gated(engine);
    engine.approve("cand", "jane.operator"); // a real human approval — still not enough on its own

    await expect(promoteToServing(engine, "cand", store, "demo")).rejects.toThrow(/shadow-not-passed|canary-not-passed/);
    expect(await servingChampion(store, "demo")).toBeNull(); // nothing reached serving
  });

  it("the full staged path still promotes — this constrains the lane, it does not remove it", async () => {
    const store = new InMemoryRuntimeStore();
    const engine = mkEngine();
    await gated(engine);
    stage(engine);
    engine.approve("cand", "jane.operator");

    const champ = await promoteToServing(engine, "cand", store, "demo");
    expect(champ.policy.id).toBe("cand");
    expect((await servingChampion(store, "demo"))?.policy.id).toBe("cand");
  });

  it("shadow alone is not enough — canary is independently required", async () => {
    const store = new InMemoryRuntimeStore();
    const engine = mkEngine();
    await gated(engine);
    engine.beginStaging("cand");
    engine.recordShadow("cand", { n: 200, delta: 0.02, at: "2026-08-05T00:00:00Z" }, { maxRegression: 0.05 });
    engine.approve("cand", "jane.operator");

    await expect(promoteToServing(engine, "cand", store, "demo")).rejects.toThrow(/canary-not-passed/);
    expect(await servingChampion(store, "demo")).toBeNull();
  });

  it("a FAILING shadow blocks promotion, and canary cannot be recorded on top of it", async () => {
    const store = new InMemoryRuntimeStore();
    const engine = mkEngine();
    await gated(engine);
    engine.beginStaging("cand");
    // delta well past maxRegression ⇒ shadow fails
    engine.recordShadow("cand", { n: 200, delta: -0.9, at: "2026-08-05T00:00:00Z" }, { maxRegression: 0.05 });
    expect(() =>
      engine.recordCanary("cand", { n: 500, delta: 0.02, elapsedMs: 3_600_000, at: "x" }, { minN: 100, minWindowMs: 600_000, minDelta: -0.01 }),
    ).toThrow(/requires a passing shadow/i);

    engine.approve("cand", "jane.operator");
    await expect(promoteToServing(engine, "cand", store, "demo")).rejects.toThrow(/shadow-not-passed/);
  });

  it("an UNDERPOWERED canary (too few samples / too short a window) does not count as passed", async () => {
    const store = new InMemoryRuntimeStore();
    const engine = mkEngine();
    await gated(engine);
    engine.beginStaging("cand");
    engine.recordShadow("cand", { n: 200, delta: 0.02, at: "2026-08-05T00:00:00Z" }, { maxRegression: 0.05 });
    engine.recordCanary("cand", { n: 5, delta: 0.02, elapsedMs: 1_000, at: "x" }, { minN: 100, minWindowMs: 600_000, minDelta: -0.01 });
    engine.approve("cand", "jane.operator");

    await expect(promoteToServing(engine, "cand", store, "demo")).rejects.toThrow(/canary-not-passed/);
  });

  it("staging does NOT substitute for the human approval — both are required, neither implies the other", async () => {
    const store = new InMemoryRuntimeStore();
    const engine = mkEngine();
    await gated(engine);
    stage(engine); // fully staged, never approved
    await expect(promoteToServing(engine, "cand", store, "demo")).rejects.toThrow(/needs human approval/i);
    expect(await servingChampion(store, "demo")).toBeNull();
  });

  it("staging does NOT launder an AUTO-LOOP approval into a human one", async () => {
    const store = new InMemoryRuntimeStore();
    const engine = mkEngine();
    await gated(engine);
    stage(engine);
    engine.approve("cand", "auto-loop");
    await expect(promoteToServing(engine, "cand", store, "demo")).rejects.toThrow(/not HUMAN-approved/i);
    expect(await servingChampion(store, "demo")).toBeNull();
  });

  it("beginStaging requires a PASSED gate — staging cannot start on an ungated candidate", async () => {
    const engine = mkEngine();
    engine.propose(P("cand")); // proposed only, never evaluated
    expect(() => engine.beginStaging("cand")).toThrow(/gate|status/i);
  });

  it("the AUTO lane keeps its own STRICTER bar — beginStaging does not open an auto-promote path", async () => {
    const engine = mkEngine();
    await gated(engine);
    engine.beginStaging("cand"); // human-lane staging: no positive cross-family grade required
    engine.recordShadow("cand", { n: 200, delta: 0.02, at: "x" }, { maxRegression: 0.05 });
    engine.recordCanary("cand", { n: 500, delta: 0.02, elapsedMs: 3_600_000, at: "x" }, { minN: 100, minWindowMs: 600_000, minDelta: -0.01 });

    // Fully staged, but the MockGrader yields gating===undefined, so the auto lane must still refuse.
    const check = engine.autoPromotable("cand");
    expect(check.ok).toBe(false);
    expect(check.reasons).toContain("not-positively-gating");
  });
});
