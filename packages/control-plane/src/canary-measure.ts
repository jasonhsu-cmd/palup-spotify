import type { Interaction } from "./canary-controller.js";

// ADR-0014 T4e — the REAL canary-stage measurement. Over the observation window, compare the LIVE canary
// arm (1-5% of shoppers) against the champion arm on:
//   • QUALITY — a cross-family judge re-grades each arm's ACTUAL logged replies (the `grade` fn is
//     injected: the Anthropic gating judge in prod, deterministic in tests). qualityDelta = canaryQ −
//     championQ is what feeds windowedVerdictFor / engine.recordCanary.
//   • ESCALATION rate — from the logged escalate flags (escalation recall is higher-is-better; a canary
//     that escalates meaningfully LESS may be dropping required escalations).
//   • n (for statistical power) — the FULL canary-served count in the window (quality is a sampled
//     re-grade; power must use the true traffic volume).
//
// HONEST LIMITATION (flagged for enablement): return / complaint / opt-out are POST-PURCHASE signals that
// surface days-to-weeks later and are NOT present in the in-window traffic stream. They are the
// DELAYED-signal domain handled AFTER promotion by T3's delayedRollbackToBaseline, not measurable here.
// Wiring an order/return/complaint event source into the canary window is enablement work.
//
// Revenue-flywheel Wave-2 (D): `measureCanary`'s optional `measuredOutcome` param (below) is a pure
// PASSTHROUGH — a pre-computed `MeasuredOutcomeSignal` (`measured-outcome-signal.ts`, over the W2-A
// outcome ledger) the CALLER already read, carried onto the returned `CanaryMeasurement` for the
// orchestrator's audit trail. It does NOT feed `qualityDelta`/`n`/escalation above: those are calibrated
// for the judge-graded quality-score comparison, and a USD/fractional incremental-lift number is a
// different unit that must never be substituted into that arithmetic. Omitted (every caller today) ⇒ the
// field is absent on the result — byte-identical to before this seam existed.

export interface CanaryMeasurement {
  /** Full canary-served count in the window — the statistical-power input. */
  n: number;
  championN: number;
  /** Observation window elapsed (now − since), ms; 0 if either timestamp is unreadable. */
  elapsedMs: number;
  qualityDelta: number;
  canaryQuality: number;
  championQuality: number;
  canaryEscalationRate: number;
  championEscalationRate: number;
  /** Revenue-flywheel Wave-2 (D) — see the header comment above. Absent unless the caller supplied one. */
  measuredOutcome?: { incrementalLift: number; power: number; underpowered: boolean; method: string };
}

export async function measureCanary(
  interactions: Interaction[],
  grade: (reply: string, message: string) => Promise<number>,
  arms: { canaryPolicyId: string; championPolicyId: string },
  window: { since: string; now: string },
  sampleN = 20,
  /** Revenue-flywheel Wave-2 (D) — OPTIONAL pre-computed measured-outcome signal, passed straight
   * through onto the result (see the header comment). Dormant when omitted. */
  measuredOutcome?: { incrementalLift: number; power: number; underpowered: boolean; method: string },
): Promise<CanaryMeasurement> {
  const sinceMs = Date.parse(window.since);
  const nowMs = Date.parse(window.now);
  const inWindow = interactions.filter((e) => {
    const t = Date.parse(e.ts);
    return Number.isFinite(t) && Number.isFinite(sinceMs) && t >= sinceMs && e.message.trim().length > 2;
  });
  const canaryAll = inWindow.filter((e) => e.servedBy === arms.canaryPolicyId);
  const champAll = inWindow.filter((e) => e.servedBy === arms.championPolicyId);
  const meanQuality = async (arm: Interaction[]): Promise<number> => {
    if (arm.length === 0) return 0;
    const scores = await Promise.all(arm.slice(-sampleN).map((e) => grade(e.reply, e.message)));
    return scores.reduce((a, b) => a + b, 0) / scores.length;
  };
  const escRate = (arm: Interaction[]): number => (arm.length ? arm.filter((e) => e.escalate).length / arm.length : 0);
  const canaryQuality = await meanQuality(canaryAll);
  const championQuality = await meanQuality(champAll);
  return {
    n: canaryAll.length,
    championN: champAll.length,
    elapsedMs: Number.isFinite(nowMs) && Number.isFinite(sinceMs) ? nowMs - sinceMs : 0,
    qualityDelta: canaryQuality - championQuality,
    canaryQuality,
    championQuality,
    canaryEscalationRate: escRate(canaryAll),
    championEscalationRate: escRate(champAll),
    ...(measuredOutcome !== undefined ? { measuredOutcome } : {}),
  };
}

/** True if the canary escalates MEANINGFULLY less than the champion (escalation recall dropped beyond
 * `tolerance`) — a counter-metric regression the orchestrator routes to a human, never auto-promotes. */
export function escalationRegressed(m: Pick<CanaryMeasurement, "canaryEscalationRate" | "championEscalationRate">, tolerance: number): boolean {
  return m.championEscalationRate - m.canaryEscalationRate > tolerance;
}
