import { describe, it, expect } from "vitest";
import { DEFAULT_POLICY, type Policy } from "@palup/widget-brain";
import { EvolutionEngine, MockGrader, type PolicyMetrics } from "../src/index.js";

// ADR-0014 T4a — the ENGINE-ENFORCED auto-lane state machine (inv #3: stage completion is enforced by
// the engine, not the orchestrator loop, so a loop bug or a second caller can never skip shadow/canary).
// beginAutoOptimize demands gating===true POSITIVELY (the delta over engine.gate, which passes
// gating===undefined, the offline MockGrader opt-out). recordShadow/recordCanary advance ONLY in order
// and ONLY on an engine-DERIVED pass (never a caller boolean). autoPromotable is the read-only predicate
// the durable serving write consults; markAutoPromoted (actor auto-loop) is after-commit bookkeeping.

const CM = { returnRate: 0.08, complaintRate: 0.03, optOutRate: 0.1, escalationRecall: 1 };
const champMetrics: PolicyMetrics = { policyId: DEFAULT_POLICY.id, safetyPass: true, floorPass: true, qualityScore: 0.7, counterMetrics: CM };
const cand = (over: Partial<PolicyMetrics>): PolicyMetrics => ({ policyId: "cand", safetyPass: true, floorPass: true, qualityScore: 0.9, counterMetrics: { ...CM, returnRate: 0.06 }, ...over });
const P = (id: string): Policy => ({ id, label: id, styleDirective: `voice-${id}`, proactivityDefault: "balanced" });
const POWER = { minN: 100, minWindowMs: 86_400_000, minDelta: 0.05 };
const SHADOW_BOUNDS = { maxRegression: 0.05 };

const mkEngine = (candMetrics: PolicyMetrics) =>
  new EvolutionEngine({ champion: { policy: DEFAULT_POLICY, metrics: champMetrics }, grader: new MockGrader({ cand: candMetrics }) });

/** propose + evaluate a "cand" so it reaches awaiting_approval (gate pass), returning the engine. */
const readied = async (candMetrics: PolicyMetrics) => {
  const e = mkEngine(candMetrics);
  e.propose(P("cand"));
  await e.evaluate("cand");
  return e;
};

describe("engine auto-lane state machine (ADR-0014 inv #3: engine-enforced, no skippable stage)", () => {
  it("beginAutoOptimize demands gating===true POSITIVELY (refuses undefined AND false)", async () => {
    // gating true → allowed
    const eTrue = await readied(cand({ gating: true }));
    expect(eTrue.getCandidate("cand")?.status).toBe("awaiting_approval");
    eTrue.beginAutoOptimize("cand");
    expect(eTrue.getCandidate("cand")?.auto?.stage).toBe("eval-passed");

    // gating undefined → gate PASSES (awaiting_approval) but the auto lane refuses (not positively true)
    const eUndef = await readied(cand({ gating: undefined }));
    expect(eUndef.getCandidate("cand")?.status).toBe("awaiting_approval");
    expect(() => eUndef.beginAutoOptimize("cand")).toThrow(/gating/i);

    // gating false → gate BLOCKS; the auto lane refuses on status
    const eFalse = await readied(cand({ gating: false }));
    expect(eFalse.getCandidate("cand")?.status).toBe("blocked");
    expect(() => eFalse.beginAutoOptimize("cand")).toThrow();
  });

  it("recordShadow requires the eval-passed stage; recordCanary requires a PASSING shadow marker (order enforced)", async () => {
    const e = await readied(cand({ gating: true }));
    // shadow before begin → throws
    expect(() => e.recordShadow("cand", { n: 8, delta: 0.1, at: "t" }, SHADOW_BOUNDS)).toThrow(/eval-passed|stage/i);
    e.beginAutoOptimize("cand");
    // canary before shadow → throws
    expect(() => e.recordCanary("cand", { n: 200, delta: 0.1, elapsedMs: 90_000_000, at: "t" }, POWER)).toThrow(/shadow|stage/i);
    // a FAILING shadow (delta below -maxRegression) does NOT advance the stage → canary still throws
    e.recordShadow("cand", { n: 8, delta: -0.5, at: "t" }, SHADOW_BOUNDS);
    expect(e.getCandidate("cand")?.auto?.shadow?.pass).toBe(false);
    expect(e.getCandidate("cand")?.auto?.stage).toBe("eval-passed"); // not advanced
    expect(() => e.recordCanary("cand", { n: 200, delta: 0.1, elapsedMs: 90_000_000, at: "t" }, POWER)).toThrow(/shadow|stage/i);
  });

  it("pass is engine-DERIVED from raw numbers (a caller can't fabricate it); needs power AND delta≥minDelta", async () => {
    const e = await readied(cand({ gating: true }));
    e.beginAutoOptimize("cand");
    e.recordShadow("cand", { n: 8, delta: 0.1, at: "t" }, SHADOW_BOUNDS);
    expect(e.getCandidate("cand")?.auto?.stage).toBe("shadowed");
    // too few samples ⇒ canary.pass false, stage NOT advanced
    e.recordCanary("cand", { n: POWER.minN - 1, delta: 0.2, elapsedMs: POWER.minWindowMs, at: "t" }, POWER);
    expect(e.getCandidate("cand")?.auto?.canary?.pass).toBe(false);
    expect(e.getCandidate("cand")?.auto?.stage).toBe("shadowed");
    expect(e.autoPromotable("cand").ok).toBe(false);
  });

  it("autoPromotable.ok is true ONLY with gating + passing shadow + passing canary + awaiting_approval + not killed", async () => {
    const e = await readied(cand({ gating: true }));
    e.beginAutoOptimize("cand");
    expect(e.autoPromotable("cand").ok).toBe(false); // no shadow/canary yet
    e.recordShadow("cand", { n: 8, delta: 0.1, at: "t" }, SHADOW_BOUNDS);
    e.recordCanary("cand", { n: 200, delta: 0.2, elapsedMs: 90_000_000, at: "t" }, POWER);
    expect(e.getCandidate("cand")?.auto?.stage).toBe("canaried");
    expect(e.autoPromotable("cand").ok).toBe(true);
    // kill flips it closed
    e.kill("halt");
    expect(e.autoPromotable("cand").ok).toBe(false);
  });

  it("markAutoPromoted refuses unless autoPromotable, promotes to champion, and is attributed to auto-loop (never human)", async () => {
    const e = await readied(cand({ gating: true }));
    e.beginAutoOptimize("cand");
    e.recordShadow("cand", { n: 8, delta: 0.1, at: "t" }, SHADOW_BOUNDS);
    // before canary → refuses
    expect(() => e.markAutoPromoted("cand")).toThrow();
    e.recordCanary("cand", { n: 200, delta: 0.2, elapsedMs: 90_000_000, at: "t" }, POWER);
    const champ = e.markAutoPromoted("cand");
    expect(champ.policy.id).toBe("cand");
    expect(e.getChampion().policy.id).toBe("cand");
    expect(e.getPreviousChampion()?.policy.id).toBe(DEFAULT_POLICY.id); // depth-1 rollback target exists
    const promoteAudit = e.getAudit().find((a) => a.action === "auto_promote");
    expect(promoteAudit?.actor).toBe("auto-loop");
    expect(e.getAudit().some((a) => a.actor === "human")).toBe(false);
  });

  it("markAutoPromoted refuses when the kill switch is on (fail-closed)", async () => {
    const e = await readied(cand({ gating: true }));
    e.beginAutoOptimize("cand");
    e.recordShadow("cand", { n: 8, delta: 0.1, at: "t" }, SHADOW_BOUNDS);
    e.recordCanary("cand", { n: 200, delta: 0.2, elapsedMs: 90_000_000, at: "t" }, POWER);
    e.kill("halt");
    expect(() => e.markAutoPromoted("cand")).toThrow(/kill/i);
  });
});
