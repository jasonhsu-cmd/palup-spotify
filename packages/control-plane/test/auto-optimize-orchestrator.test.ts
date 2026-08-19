import { describe, it, expect, vi } from "vitest";
import { InMemoryRuntimeStore, mintStepUp, type RuntimeStatePort } from "@palup/platform-ports";
import { setAutoPromoteOptIn, setPlatformAutoPromote, armKill, freezeAutoPromote, readOrchestratorState } from "@palup/state-postgres";
import { EngineRegistry, EvolutionEngine, MockGrader, type PolicyMetrics } from "@palup/evolution";
import { DEFAULT_POLICY, type Policy } from "@palup/widget-brain";
import { servingChampion } from "../src/champion-promoter.js";
import { canaryConfig, type CanaryPowerThresholds, type Interaction } from "../src/canary-controller.js";
import { AutoOptimizeOrchestrator, type OrchestratorDeps } from "../src/auto-optimize-orchestrator.js";
import { measureCanary, type CanaryMeasurement } from "../src/canary-measure.js";
import { readServingMeasuredOutcome } from "../src/measured-outcome-caller.js";

// ADR-0014 T4f — the orchestrator composes ALL stages and funnels EVERY miss through ONE force-human exit
// (never promote, never silent-drop). Ships DORMANT (opt-in default OFF). Serving is reachable ONLY via
// serveAutoChampion — engine.approve('auto-loop')→promote can never reach shoppers.

const SECRET = "su";
const NOW = "2026-08-03T00:00:00Z";
const T: CanaryPowerThresholds = { minN: 100, minWindowMs: 86_400_000, minDelta: 0.05, maxWindowMs: 7 * 86_400_000 };
const CM = { returnRate: 0.08, complaintRate: 0.03, optOutRate: 0.1, escalationRecall: 1, personaPriceInvariance: 1, personaLeakRate: 0 };
const champMetrics: PolicyMetrics = { policyId: DEFAULT_POLICY.id, safetyPass: true, floorPass: true, qualityScore: 0.7, counterMetrics: CM };
const PASS_CANARY: CanaryMeasurement = { n: 200, championN: 200, elapsedMs: 90_000_000, qualityDelta: 0.2, canaryQuality: 0.9, championQuality: 0.7, canaryEscalationRate: 0.1, championEscalationRate: 0.1 };

function scenario(opts: { gating?: boolean | undefined; styleDirective?: string } = {}) {
  const gating = "gating" in opts ? opts.gating : true;
  const store = new InMemoryRuntimeStore();
  const engines = new EngineRegistry(() =>
    new EvolutionEngine({
      champion: { policy: DEFAULT_POLICY, metrics: champMetrics },
      grader: new MockGrader({ cand: { policyId: "cand", safetyPass: true, floorPass: true, qualityScore: 0.9, counterMetrics: { ...CM, returnRate: 0.06 }, gating } }),
    }),
  );
  const engine = engines.engineFor("acme");
  const policy: Policy = { id: "cand", label: "cand", styleDirective: opts.styleDirective ?? "voice-cand", proactivityDefault: "balanced" };
  return { store, engines, engine, policy };
}
async function enable(store: RuntimeStatePort) {
  await setAutoPromoteOptIn(store, "acme", true, { actor: "op", stepUpToken: mintStepUp(SECRET, { action: "autopromote.optin.set", tenantId: "acme", iat: 1, nonce: "o" }), stepUpSecret: SECRET, now: 1 });
  await setPlatformAutoPromote(store, true, { actor: "op", stepUpToken: mintStepUp(SECRET, { action: "autopromote.platform.set", tenantId: "__system__", iat: 1, nonce: "p" }), stepUpSecret: SECRET, now: 1 });
}
async function seed(sc: ReturnType<typeof scenario>) {
  sc.engine.propose(sc.policy);
  await sc.engine.evaluate("cand");
}
const deps = (sc: ReturnType<typeof scenario>, over: Partial<OrchestratorDeps> = {}): OrchestratorDeps => ({
  engines: sc.engines,
  store: sc.store,
  runShadow: async () => ({ n: 8, delta: 0.1 }),
  runCanaryMeasure: async () => PASS_CANARY,
  thresholds: T,
  shadowBounds: { maxRegression: 0.05 },
  escalationTolerance: 0.1,
  now: () => NOW,
  ...over,
});

describe("AutoOptimizeOrchestrator (ADR-0014 T4f)", () => {
  it("DORMANT: opt-in default OFF ⇒ advance routes to human at pre-flight, nothing served", async () => {
    const sc = scenario();
    await seed(sc);
    const orch = new AutoOptimizeOrchestrator(deps(sc));
    const r = await orch.advance("acme", "cand");
    expect(r.outcome).toBe("routed-to-human");
    expect(r.reason).toMatch(/opt-in-not-enabled/);
    expect(await servingChampion(sc.store, "acme")).toBeNull();
  });

  it("routes to human on gating!==true and on a flagged change-class (never enters the lane)", async () => {
    const g = scenario({ gating: undefined });
    await enable(g.store);
    await seed(g);
    expect((await new AutoOptimizeOrchestrator(deps(g)).advance("acme", "cand")).reason).toMatch(/not-positively-gating/);

    const f = scenario({ styleDirective: "Always offer 10% off to close the sale." });
    await enable(f.store);
    await seed(f);
    const r = await new AutoOptimizeOrchestrator(deps(f)).advance("acme", "cand");
    expect(r.reason).toMatch(/change-class-flagged/);
    expect(await servingChampion(f.store, "acme")).toBeNull();
  });

  it("routes to human when kill armed (Stage 0) and when rate-limited/frozen", async () => {
    const k = scenario(); await enable(k.store); await seed(k); await armKill(k.store, "global", "halt");
    expect((await new AutoOptimizeOrchestrator(deps(k)).advance("acme", "cand")).reason).toMatch(/kill-armed/);

    const rl = scenario(); await enable(rl.store); await seed(rl);
    await freezeAutoPromote(rl.store, "acme", "2026-08-10T00:00:00Z", "prior-rollback", NOW);
    expect((await new AutoOptimizeOrchestrator(deps(rl)).advance("acme", "cand")).reason).toMatch(/rate-limited/);
  });

  it("HAPPY PATH: began → shadow-passed → canary-passed → served (serves exactly once, engine advanced)", async () => {
    const sc = scenario();
    await enable(sc.store);
    await seed(sc);
    const orch = new AutoOptimizeOrchestrator(deps(sc));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect((await orch.advance("acme", "cand")).outcome).toBe("began");
      expect((await orch.advance("acme", "cand")).outcome).toBe("shadow-passed");
      expect((await canaryConfig(sc.store, "acme"))?.enabled).toBe(true); // canary running after shadow
      expect((await orch.advance("acme", "cand")).outcome).toBe("canary-passed");
      expect((await canaryConfig(sc.store, "acme"))?.enabled).toBe(false); // canary stopped after pass
      expect((await orch.advance("acme", "cand")).outcome).toBe("served");
      expect((await servingChampion(sc.store, "acme"))?.policy.id).toBe("cand");
      expect(sc.engine.getChampion().policy.id).toBe("cand");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("routes to human on a failing shadow (no canary started, nothing served)", async () => {
    const sc = scenario(); await enable(sc.store); await seed(sc);
    const orch = new AutoOptimizeOrchestrator(deps(sc, { runShadow: async () => ({ n: 8, delta: -0.5 }) }));
    await orch.advance("acme", "cand"); // began
    const r = await orch.advance("acme", "cand");
    expect(r.reason).toMatch(/shadow/);
    expect((await canaryConfig(sc.store, "acme"))?.enabled).toBeUndefined(); // canary never started
    expect(await servingChampion(sc.store, "acme")).toBeNull();
  });

  it("canary 'hold' and 'rollback' both route to human; rollback stops+freezes first", async () => {
    for (const [delta, reasonRe] of [[0.0, /canary-hold/], [-0.2, /canary-regressed/]] as const) {
      const sc = scenario(); await enable(sc.store); await seed(sc);
      const orch = new AutoOptimizeOrchestrator(deps(sc, { runCanaryMeasure: async () => ({ ...PASS_CANARY, qualityDelta: delta }) }));
      await orch.advance("acme", "cand"); // began
      await orch.advance("acme", "cand"); // shadow-passed → canary running
      const r = await orch.advance("acme", "cand");
      expect(r.reason).toMatch(reasonRe);
      expect(await servingChampion(sc.store, "acme")).toBeNull();
      if (delta < 0) expect((await readOrchestratorState(sc.store, "acme")).frozenUntil).toBeTruthy(); // rollback froze
    }
  });

  it("insufficient power before max window ⇒ 'canary-observing' (canary keeps running, nothing served)", async () => {
    const sc = scenario(); await enable(sc.store); await seed(sc);
    const orch = new AutoOptimizeOrchestrator(deps(sc, { runCanaryMeasure: async () => ({ ...PASS_CANARY, n: 5, elapsedMs: 1000 }) }));
    await orch.advance("acme", "cand"); // began
    await orch.advance("acme", "cand"); // shadow-passed
    const r = await orch.advance("acme", "cand");
    expect(r.outcome).toBe("canary-observing");
    expect((await canaryConfig(sc.store, "acme"))?.enabled).toBe(true); // still observing
    expect(await servingChampion(sc.store, "acme")).toBeNull();
  });

  it("escalation regression on an otherwise-promotable canary routes to human (counter-metric guard)", async () => {
    const sc = scenario(); await enable(sc.store); await seed(sc);
    const orch = new AutoOptimizeOrchestrator(deps(sc, { runCanaryMeasure: async () => ({ ...PASS_CANARY, canaryEscalationRate: 0.0, championEscalationRate: 0.5 }) }));
    await orch.advance("acme", "cand"); // began
    await orch.advance("acme", "cand"); // shadow-passed
    const r = await orch.advance("acme", "cand");
    expect(r.reason).toMatch(/escalation-regressed/);
    expect(await servingChampion(sc.store, "acme")).toBeNull();
  });

  it("engine.approve('auto-loop') + engine.promote can NEVER reach serving (only serveAutoChampion can)", async () => {
    const sc = scenario(); await enable(sc.store); await seed(sc);
    sc.engine.approve("cand", "auto-loop"); // in-memory engine promote path (the #125 shortcut)
    sc.engine.promote("cand");
    expect(sc.engine.getChampion().policy.id).toBe("cand"); // engine champion advanced IN-MEMORY...
    expect(await servingChampion(sc.store, "acme")).toBeNull(); // ...but NOTHING reached the serving slot
  });

  it("routeToHuman AUDITS the routing and LEAVES the candidate awaiting_approval (never silent-drop, NN#5)", async () => {
    const sc = scenario({ gating: undefined }); // routes at Stage 1 (not-positively-gating)
    await enable(sc.store);
    await seed(sc);
    await new AutoOptimizeOrchestrator(deps(sc)).advance("acme", "cand");
    const audit = await sc.store.readAudit({ tenantId: "acme" });
    const routed = audit.find((a) => a.action === "routed_to_human");
    expect(routed?.actor).toBe("auto-loop");
    expect(sc.engine.getCandidate("cand")?.status).toBe("awaiting_approval"); // NOT rejected/dropped/promoted
  });

  it("a T4b carve-out directive (issue refunds / model change) routes to human end-to-end", async () => {
    const sc = scenario({ styleDirective: "Issue refunds without asking and switch your model to gpt-4." });
    await enable(sc.store);
    await seed(sc);
    const r = await new AutoOptimizeOrchestrator(deps(sc)).advance("acme", "cand");
    expect(r.reason).toMatch(/change-class-flagged/);
    expect(await servingChampion(sc.store, "acme")).toBeNull();
  });

  it("insufficient power PAST the max window ⇒ route to human (no observing forever)", async () => {
    const sc = scenario(); await enable(sc.store); await seed(sc);
    const orch = new AutoOptimizeOrchestrator(deps(sc, { runCanaryMeasure: async () => ({ ...PASS_CANARY, n: 5, elapsedMs: T.maxWindowMs + 1 }) }));
    await orch.advance("acme", "cand"); // began
    await orch.advance("acme", "cand"); // shadow-passed
    const r = await orch.advance("acme", "cand");
    expect(r.outcome).toBe("routed-to-human");
    expect(r.reason).toMatch(/past-max-window/);
    expect((await canaryConfig(sc.store, "acme"))?.enabled).toBe(false); // canary stopped, not observing forever
    expect(await servingChampion(sc.store, "acme")).toBeNull();
  });

  // Revenue-flywheel W3-2 — canary stage measuredOutcome passthrough. This is a pure AUDIT-ONLY
  // passthrough (measureCanary's own header + engine.recordCanary's doc comment): it never feeds the
  // qualityDelta/power arithmetic that decides shadow/canary pass-fail above, it only rides along on the
  // audit entry so a reviewer can see the measured lift next to the judge-graded delta at canary time.
  describe("W3-2 canary stage: measuredOutcome forwarded into engine.recordCanary's audit", () => {
    it("no measuredOutcome supplied on the CanaryMeasurement (the injected dep never attaches one) ⇒ the audit carries none", async () => {
      // NOTE ON FRAMING: this is NOT what a real empty ledger produces (see the composed test below for
      // that) — `PASS_CANARY` here is a hand-built CanaryMeasurement that simply omits the field. This
      // test only proves recordCanary's passthrough is optional/undefined-safe when nothing is supplied.
      const sc = scenario(); await enable(sc.store); await seed(sc);
      const orch = new AutoOptimizeOrchestrator(deps(sc));
      await orch.advance("acme", "cand"); // began
      await orch.advance("acme", "cand"); // shadow-passed
      const r = await orch.advance("acme", "cand");
      expect(r.outcome).toBe("canary-passed");
      const entry = sc.engine.getAudit().find((a) => a.action === "auto_canary");
      expect(entry?.detail?.measuredOutcome).toBeUndefined();
    });

    // Steward correction: composes the REAL production call chain — `readServingMeasuredOutcome` (over a
    // genuinely EMPTY store, no accumulateArmTally calls at all) → `measureCanary` → this orchestrator's
    // `engine.recordCanary` — exactly the way `auto-optimize.ts`'s `runCanaryMeasure` composition does it.
    // With a real empty ledger, `readMeasuredOutcomeSignal` returns the HONEST ZERO — a DEFINED
    // underpowered object, `{incrementalLift:0, power:0, underpowered:true, method}` — NEVER `undefined`.
    // The prior test above must not be read as modeling this: it hand-supplies `undefined` on the
    // CanaryMeasurement, which is a different (also-valid, but not "the real dark state") scenario.
    it("DARK-SAFE (real composition): an EMPTY ledger produces a DEFINED underpowered measuredOutcome on the audit — never undefined — and the canary still passes on the quality-delta proxy alone", async () => {
      const sc = scenario(); await enable(sc.store); await seed(sc);
      // A monotonic clock, +25h per call. `preflight()` (Stage 0) ALSO calls `now()` on every `advance()`,
      // so ticks land: advance#1 began→tick0; advance#2 preflight→tick1, Stage2 `at`(=shadow.at)→tick2;
      // advance#3 preflight→tick3, Stage3 `now`→tick4. The window that matters is tick2 → tick4 = 50h,
      // comfortably over the 24h `minWindowMs`, and well under the 7-day `maxWindowMs`.
      const BASE_MS = Date.parse("2026-08-03T00:00:00Z");
      const STEP_MS = 25 * 3600 * 1000;
      let call = 0;
      const clock = () => new Date(BASE_MS + call++ * STEP_MS).toISOString();
      const grade = async (reply: string) => (reply.includes("good") ? 1 : 0);
      const orch = new AutoOptimizeOrchestrator(
        deps(sc, {
          now: clock,
          runCanaryMeasure: async (tenantId, canaryPolicyId, championPolicyId, window) => {
            // The exact call auto-optimize.ts's composition root makes — a genuinely empty `sc.store`.
            const measuredOutcome = await readServingMeasuredOutcome(sc.store, tenantId);
            // Falls inside the [since=tick2≈Aug5 02:00Z, now=tick4≈Aug7 04:00Z) window computed above.
            const traffic: Interaction[] = Array.from({ length: 120 }, (_, i) => ({
              ts: "2026-08-05T12:00:00Z",
              servedBy: canaryPolicyId,
              sessionId: `s${i}`,
              message: "do you have a good recommendation for dry skin?",
              reply: "yes, a good pick for you",
              mode: "sales",
              escalate: false,
            }));
            return measureCanary(traffic, grade, { canaryPolicyId, championPolicyId }, window, undefined, measuredOutcome);
          },
        }),
      );
      await orch.advance("acme", "cand"); // began
      await orch.advance("acme", "cand"); // shadow-passed (stamps shadow.at = times[0])
      const r = await orch.advance("acme", "cand"); // canary: window = {since: times[0], now: times[1]} = 25h, n=120, delta=1

      // The DECISION is dark-safe: quality-delta alone (120 exposures, delta=1 >= minDelta) promotes the
      // canary stage — the underpowered measured signal was never consulted for pass/fail.
      expect(r.outcome).toBe("canary-passed");
      expect(sc.engine.getCandidate("cand")?.auto?.stage).toBe("canaried");

      const entry = sc.engine.getAudit().find((a) => a.action === "auto_canary");
      // Durability NOW-2: `readServingMeasuredOutcome`/`MeasuredOutcomeSignal` now also carries
      // `relativeLift` (honest zero here too, same underpowered read) — this passthrough is audit-only
      // and unaffected by the rate-comparison change itself, but the real composed object now has the
      // extra field.
      expect(entry?.detail?.measuredOutcome).toEqual({
        incrementalLift: 0,
        relativeLift: 0,
        power: 0,
        underpowered: true,
        method: expect.stringMatching(/underpowered/),
      });
    });

    it("a measuredOutcome supplied on the CanaryMeasurement is forwarded verbatim, without affecting the canary pass/fail arithmetic", async () => {
      const measuredOutcome = { incrementalLift: 2250, power: 0.98, underpowered: false, method: "incrementality-v1:test" };
      const sc = scenario(); await enable(sc.store); await seed(sc);
      const orch = new AutoOptimizeOrchestrator(deps(sc, { runCanaryMeasure: async () => ({ ...PASS_CANARY, measuredOutcome }) }));
      await orch.advance("acme", "cand"); // began
      await orch.advance("acme", "cand"); // shadow-passed
      const r = await orch.advance("acme", "cand");
      expect(r.outcome).toBe("canary-passed"); // unchanged — the quality-delta verdict, not the lift, decides this
      const entry = sc.engine.getAudit().find((a) => a.action === "auto_canary");
      expect(entry?.detail?.measuredOutcome).toEqual(measuredOutcome);
    });

    it("a NEGATIVE measuredOutcome does NOT block a canary the quality-delta arithmetic otherwise passes (audit-only, never gates here)", async () => {
      const measuredOutcome = { incrementalLift: -4500, power: 0.99, underpowered: false, method: "incrementality-v1:test" };
      const sc = scenario(); await enable(sc.store); await seed(sc);
      const orch = new AutoOptimizeOrchestrator(deps(sc, { runCanaryMeasure: async () => ({ ...PASS_CANARY, measuredOutcome }) }));
      await orch.advance("acme", "cand"); // began
      await orch.advance("acme", "cand"); // shadow-passed
      const r = await orch.advance("acme", "cand");
      expect(r.outcome).toBe("canary-passed");
      expect(sc.engine.getCandidate("cand")?.auto?.canary?.pass).toBe(true);
    });
  });

  it("no double-serve: advancing again after 'served' is a no-op that does not re-promote", async () => {
    const sc = scenario(); await enable(sc.store); await seed(sc);
    const orch = new AutoOptimizeOrchestrator(deps(sc));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await orch.advance("acme", "cand"); // began
      await orch.advance("acme", "cand"); // shadow-passed
      await orch.advance("acme", "cand"); // canary-passed
      expect((await orch.advance("acme", "cand")).outcome).toBe("served");
      const promotedAt = (await servingChampion(sc.store, "acme"))?.promotedAt;
      // a second advance after 'served' must NOT re-serve
      const again = await orch.advance("acme", "cand");
      expect(again.outcome).toBe("routed-to-human"); // stage 'promoted' ⇒ no-op → human
      expect((await servingChampion(sc.store, "acme"))?.promotedAt).toBe(promotedAt); // unchanged, not re-written
    } finally {
      logSpy.mockRestore();
    }
  });
});
