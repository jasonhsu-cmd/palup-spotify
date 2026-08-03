import { describe, it, expect } from "vitest";
import { DEFAULT_POLICY, type Policy } from "@palup/widget-brain";
import { EvolutionEngine, MockGrader, type PolicyMetrics } from "@palup/evolution";
import { windowedVerdictFor, type CanaryPowerThresholds } from "../src/canary-controller.js";

// ADR-0014 T4a parity — the engine (recordCanary) and control-plane (windowedVerdictFor) each derive the
// canary "promote" decision from raw {n, delta, elapsedMs}. They are two arithmetic copies; this test
// threads the SAME thresholds object into both and asserts they AGREE on boundary values, so they can
// never drift (a drift would let the engine mark a candidate promotable that the orchestrator's verdict
// would not promote, or vice-versa).

const CM = { returnRate: 0.08, complaintRate: 0.03, optOutRate: 0.1, escalationRecall: 1 };
const champMetrics: PolicyMetrics = { policyId: DEFAULT_POLICY.id, safetyPass: true, floorPass: true, qualityScore: 0.7, counterMetrics: CM };
const candMetrics: PolicyMetrics = { policyId: "cand", safetyPass: true, floorPass: true, qualityScore: 0.9, counterMetrics: { ...CM, returnRate: 0.06 }, gating: true };
const P = (id: string): Policy => ({ id, label: id, styleDirective: `voice-${id}`, proactivityDefault: "balanced" });
const T: CanaryPowerThresholds = { minN: 100, minWindowMs: 86_400_000, minDelta: 0.05, maxWindowMs: 7 * 86_400_000 };

/** A fresh engine with "cand" driven to the "shadowed" stage (so recordCanary is legal). */
async function shadowed(): Promise<EvolutionEngine> {
  const e = new EvolutionEngine({ champion: { policy: DEFAULT_POLICY, metrics: champMetrics }, grader: new MockGrader({ cand: candMetrics }) });
  e.propose(P("cand"));
  await e.evaluate("cand");
  e.beginAutoOptimize("cand");
  e.recordShadow("cand", { n: 8, delta: 0.1, at: "t" }, { maxRegression: 0.05 });
  return e;
}

describe("canary power parity: engine.recordCanary pass === (windowedVerdictFor === 'promote')", () => {
  const cases = [
    { name: "at all floors", n: T.minN, delta: T.minDelta, elapsedMs: T.minWindowMs },
    { name: "too few samples", n: T.minN - 1, delta: T.minDelta, elapsedMs: T.minWindowMs },
    { name: "delta just below minDelta", n: T.minN, delta: T.minDelta - 0.001, elapsedMs: T.minWindowMs },
    { name: "window just too short", n: T.minN, delta: T.minDelta, elapsedMs: T.minWindowMs - 1 },
    { name: "clearly promotable", n: 500, delta: 0.3, elapsedMs: T.minWindowMs * 2 },
    { name: "negative delta", n: 500, delta: -0.2, elapsedMs: T.minWindowMs * 2 },
  ];

  for (const c of cases) {
    it(`agrees — ${c.name}`, async () => {
      const e = await shadowed();
      e.recordCanary("cand", { n: c.n, delta: c.delta, elapsedMs: c.elapsedMs, at: "t" }, T);
      const enginePass = e.getCandidate("cand")?.auto?.canary?.pass === true;
      const verdictPromote = windowedVerdictFor(c.n, c.delta, c.elapsedMs, T) === "promote";
      expect(enginePass).toBe(verdictPromote);
    });
  }
});
