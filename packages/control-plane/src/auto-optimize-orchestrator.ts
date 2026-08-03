import type { RuntimeStatePort } from "@palup/platform-ports";
import type { EngineRegistry, EvolutionEngine } from "@palup/evolution";
import type { Policy } from "@palup/widget-brain";
import {
  matchedKill,
  RUNTIME_AGENT_TYPE,
  readAutoPromoteEnabled,
  readOrchestratorState,
  rateLimitReason,
  recordAutoStage,
  readAutoStage,
} from "@palup/state-postgres";
import { screenChange } from "./change-class.js";
import { windowedVerdictFor, startCanary, stopCanary, MAX_CANARY_PCT, type CanaryPowerThresholds } from "./canary-controller.js";
import { applyCanaryVerdict } from "./canary-reaction.js";
import { escalationRegressed, type CanaryMeasurement } from "./canary-measure.js";
import { serveAutoChampion } from "./auto-champion-write.js";

// ADR-0014 T4f — the auto-optimize orchestrator. advance(tenantId, candidateId) ADVANCES AT MOST ONE
// stage per call, so a long-running canary (spanning real elapsed time) is driven across re-ticks. It
// composes ALL stages in order and funnels EVERY gate miss through ONE routeToHuman exit (leave the
// candidate awaiting_approval + audit; NEVER reject/silent-drop, NEVER promote). Serving is reachable
// ONLY via serveAutoChampion (marker+ledger gated); the orchestrator never calls
// engine.approve('auto-loop')→promote (the PR #125 path). Per-tenant via EngineRegistry.
//
// RESUME SCOPE (honest): within one process, re-ticks resume via the engine's in-memory auto markers +
// the durable stage ledger, and double-serve is prevented (a promoted candidate's autoPromotable() is
// false + the freq-cap stamp rate-limits). A FRESH process has no in-memory candidate, so advance() fails
// SAFE to routeToHuman('unknown-candidate') rather than resuming — true cross-process resume needs durable
// engine candidate state, which is enablement work. The durable ledger's job is the cross-process WRITE
// guard (serveAutoChampion refuses without it), not full engine-state rehydration.
//
// SHIPS DORMANT: serveAutoChampion fails closed on the default-OFF opt-in, and Stage 0's pre-flight
// short-circuits to routeToHuman on that same gate before any shadow/canary/serve — so running advance()
// against a real tenant changes nothing a shopper sees until a human enacts the ADR and flips both
// step-up-gated switches. The orchestrator entrypoint is operator-run / non-cron.
//
// The live measurements are INJECTED (runShadow / runCanaryMeasure) so the state machine is offline-
// testable; in prod the composition root wires shadowEvaluate + (readTrafficLog + measureCanary).

export type AutoOptimizeOutcome =
  | "began"
  | "shadow-passed"
  | "canary-observing"
  | "canary-passed"
  | "served"
  | "routed-to-human";

export interface AdvanceResult {
  outcome: AutoOptimizeOutcome;
  stage: string;
  reason?: string;
}

export interface OrchestratorDeps {
  engines: EngineRegistry;
  store: RuntimeStatePort;
  /** Shadow (0%) result for a candidate policy (wraps shadowEvaluate in prod). */
  runShadow: (tenantId: string, policy: Policy) => Promise<{ n: number; delta: number }>;
  /** Live canary-vs-champion measurement over the window (wraps readTrafficLog + measureCanary in prod). */
  runCanaryMeasure: (tenantId: string, canaryPolicyId: string, championPolicyId: string, window: { since: string; now: string }) => Promise<CanaryMeasurement>;
  thresholds: CanaryPowerThresholds;
  shadowBounds: { maxRegression: number; maxImprovement?: number };
  /** Escalation-recall drop tolerance for the canary counter-metric guard. */
  escalationTolerance: number;
  now: () => string;
}

export class AutoOptimizeOrchestrator {
  constructor(private readonly deps: OrchestratorDeps) {}

  /** Advance one stage for a candidate (already proposed + gate-evaluated on the tenant's engine). */
  async advance(tenantId: string, candidateId: string): Promise<AdvanceResult> {
    const engine = this.deps.engines.engineFor(tenantId);
    const rec = engine.getCandidate(candidateId);
    if (!rec) return this.routeToHuman(engine, tenantId, candidateId, "unknown-candidate");

    // Stage 0 — pre-flight, every tick, fail-closed (opt-in + rate-limit/freeze + kill).
    const halt = await this.preflight(tenantId);
    if (halt) return this.routeToHuman(engine, tenantId, candidateId, halt);

    const stage = rec.auto?.stage;

    // Stage 1 — select + gate: require a POSITIVE gating grade + a voice-only change-class, then enter.
    if (!stage) {
      if (rec.gate?.pass !== true) return this.routeToHuman(engine, tenantId, candidateId, "gate-not-passed");
      if (rec.metrics?.gating !== true) return this.routeToHuman(engine, tenantId, candidateId, "not-positively-gating");
      const screen = screenChange(rec.policy);
      if (screen.changeClass !== "voice") return this.routeToHuman(engine, tenantId, candidateId, `change-class-flagged:${screen.reasons.join(",")}`);
      engine.beginAutoOptimize(candidateId);
      return { outcome: "began", stage: "eval-passed" };
    }

    // Stage 2 — shadow (0%). No shopper is served (replay grading).
    if (stage === "eval-passed") {
      const s = await this.deps.runShadow(tenantId, rec.policy);
      const at = this.deps.now();
      engine.recordShadow(candidateId, { n: s.n, delta: s.delta, at }, this.deps.shadowBounds);
      const marker = engine.getCandidate(candidateId)!.auto!.shadow!;
      await recordAutoStage(this.deps.store, tenantId, candidateId, "shadow", { n: marker.n, delta: marker.delta, at: marker.at, pass: marker.pass }, at);
      if (!marker.pass) return this.routeToHuman(engine, tenantId, candidateId, "shadow-diff-out-of-bounds");
      // Shadow passed → start the 1-5% canary; the window opens now.
      await startCanary(this.deps.store, tenantId, rec.policy, MAX_CANARY_PCT);
      return { outcome: "shadow-passed", stage: "shadowed" };
    }

    // Stage 3 — canary (1-5%), measured over the window across re-ticks.
    if (stage === "shadowed") {
      const ledger = await readAutoStage(this.deps.store, tenantId, candidateId);
      const since = ledger?.shadow?.at ?? this.deps.now(); // window opened when shadow completed / canary started
      const now = this.deps.now();
      const m = await this.deps.runCanaryMeasure(tenantId, rec.policy.id, engine.getChampion().policy.id, { since, now });
      const verdict = windowedVerdictFor(m.n, m.qualityDelta, m.elapsedMs, this.deps.thresholds);
      if (verdict === "insufficient-power") {
        // Not enough traffic/time yet. Keep observing UNLESS we've blown past the max window ⇒ human.
        if (m.elapsedMs >= this.deps.thresholds.maxWindowMs) {
          await stopCanary(this.deps.store, tenantId);
          return this.routeToHuman(engine, tenantId, candidateId, "canary-insufficient-power-past-max-window");
        }
        return { outcome: "canary-observing", stage: "shadowed", reason: `n=${m.n} elapsedMs=${m.elapsedMs}` };
      }
      if (verdict === "rollback") {
        await applyCanaryVerdict(this.deps.store, tenantId, "rollback", now); // stop + freeze
        return this.routeToHuman(engine, tenantId, candidateId, "canary-regressed");
      }
      if (verdict === "hold") {
        await stopCanary(this.deps.store, tenantId);
        return this.routeToHuman(engine, tenantId, candidateId, "canary-hold");
      }
      // verdict === "promote" — also guard the counter-metric (escalation recall must not drop).
      if (escalationRegressed(m, this.deps.escalationTolerance)) {
        await applyCanaryVerdict(this.deps.store, tenantId, "rollback", now);
        return this.routeToHuman(engine, tenantId, candidateId, "canary-escalation-regressed");
      }
      engine.recordCanary(candidateId, { n: m.n, delta: m.qualityDelta, elapsedMs: m.elapsedMs, at: now }, this.deps.thresholds);
      const marker = engine.getCandidate(candidateId)!.auto!.canary!;
      await recordAutoStage(this.deps.store, tenantId, candidateId, "canary", { n: marker.n, delta: marker.delta, elapsedMs: marker.elapsedMs, at: marker.at, pass: marker.pass }, now);
      await stopCanary(this.deps.store, tenantId);
      return { outcome: "canary-passed", stage: "canaried" };
    }

    // Stage 4 + 5 — atomic pre-write re-check, then the single gated serving write.
    if (stage === "canaried") {
      const halt2 = await this.preflight(tenantId);
      if (halt2) return this.routeToHuman(engine, tenantId, candidateId, halt2);
      await serveAutoChampion(engine, candidateId, this.deps.store, tenantId, { at: this.deps.now() });
      return { outcome: "served", stage: "promoted" };
    }

    // Already promoted (or an unexpected stage) — nothing to advance.
    return this.routeToHuman(engine, tenantId, candidateId, `no-op-stage-${stage}`);
  }

  /** Pre-flight: the fail-closed gates checked every tick. Returns a halt reason, or null to proceed. */
  private async preflight(tenantId: string): Promise<string | null> {
    const gate = await readAutoPromoteEnabled(this.deps.store, tenantId);
    if (!gate.enabled) return `opt-in-not-enabled:${gate.reason}`;
    const rl = rateLimitReason(await readOrchestratorState(this.deps.store, tenantId), this.deps.now());
    if (rl) return `rate-limited:${rl}`;
    const kill = await matchedKill(this.deps.store, { tenantId, agentType: RUNTIME_AGENT_TYPE });
    if (kill) return `kill-armed:${kill.scope}`;
    return null;
  }

  /** The single force-human exit: leave the candidate awaiting_approval (the human Approval-Center
   * surface), audit the routing with the reason. NEVER reject/silent-drop, NEVER promote. */
  private async routeToHuman(engine: EvolutionEngine, tenantId: string, candidateId: string, reason: string): Promise<AdvanceResult> {
    const at = this.deps.now();
    await this.deps.store.tx({ tenantId }, async (t) => {
      await t.audit(
        {
          actor: "auto-loop",
          action: "routed_to_human",
          input: { tenantId, candidateId, reason },
          decision: `routed ${candidateId} to the Approval Center (${reason}) — human review required`,
          reversalPath: "human approve/reject via the Approval Center",
        },
        at,
      );
    });
    return { outcome: "routed-to-human", stage: engine.getCandidate(candidateId)?.auto?.stage ?? "none", reason };
  }
}
