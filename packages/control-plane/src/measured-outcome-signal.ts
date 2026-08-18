import type { Play, RuntimeStatePort } from "@palup/platform-ports";
import { computeIncrementalLift } from "@palup/platform-ports";
import { readArmAggPair } from "@palup/state-postgres";

// Wave 2 / W2-D — the READ-SIDE adapter between the W2-A outcome ledger (durable per-tenant ArmTally
// accumulator, `state-postgres/outcome-ledger-store.ts`) and the evolution GATE's
// `PolicyMetrics.measuredOutcome` seam (`evolution/types.ts`, `evolution/engine.ts`). Lives in
// control-plane — NOT in `evolution` — because `evolution/engine.ts` stays store-free/pure (CLAUDE.md
// §3 layering: evolution is upstream of control-plane, so the dependency can only run this direction).
//
// PROPOSER≠FEE-COMPUTER (task item 5, mirrors `outcome-ledger.ts`'s header). This is the LEARNING READ
// PATH ONLY: it reads aggregate arm counts and derives a lift/confidence number for the gate to reason
// about. It contains NO fee/billing/pricing computation, is never imported by
// `packages/evolution/src/proposer.ts`, and never imports the proposer.
//
// SHIPS DARK: nothing calls this file yet. Wiring a caller (the auto-optimize orchestrator, or a
// control-plane route) to a specific (tenantId, play, period) is a separate, later decision — which
// play/period a given evaluation round should read is a business question this module does not guess.

export interface MeasuredOutcomeSignal {
  /** USD (or whatever unit the ledger's revenue field carries) — see `computeIncrementalLift`. */
  incrementalLift: number;
  /** 0..1 — `computeIncrementalLift`'s `confidence`, carried through as `PolicyMetrics.measuredOutcome
   * .power`. Forced to 0 whenever `underpowered` (see `computeIncrementalLift`), so a low/zero `power`
   * here already implies `underpowered` — no separate flag is needed for the gate's power-floor check
   * to fire correctly, but `underpowered` is still returned for direct observability/audit. */
  power: number;
  /** true whenever the inputs cannot support a trustworthy lift measurement (below the minimum
   * per-arm exposure floor, a zero/absent control, or non-finite/invalid ArmAgg inputs). Fail-closed —
   * mirrors `IncrementalLiftResult.underpowered` exactly. */
  underpowered: boolean;
  /** Versioned, human-readable method string from `computeIncrementalLift` (auditable). */
  method: string;
}

/**
 * Read the treated-vs-control `ArmAgg` pair for `(tenantId, play, period)` from the durable outcome
 * ledger and derive the incrementality lift signal — ready to hand to `toMeasuredOutcome` for the gate,
 * or to a monitor caller for `monitorServing`'s `observed.measuredOutcome`. Missing rows read as the
 * honest zero aggregate (`readArmAggPair`'s `EMPTY_ARM_AGG` default) — never fabricated — which
 * `computeIncrementalLift` will correctly report as `underpowered` (zero-control / below the exposure
 * floor), not as a spurious lift.
 */
export async function readMeasuredOutcomeSignal(
  store: RuntimeStatePort,
  tenantId: string,
  play: Play,
  period: string,
): Promise<MeasuredOutcomeSignal> {
  const { treated, control } = await readArmAggPair(store, tenantId, play, period);
  const result = computeIncrementalLift({ treated, control });
  return {
    incrementalLift: result.incrementalLift,
    power: result.confidence,
    underpowered: result.underpowered,
    method: result.method,
  };
}

/**
 * Shape a `MeasuredOutcomeSignal` into the exact `PolicyMetrics.measuredOutcome` the evolution gate
 * reads (`evolution/types.ts`). A pure projection — drops `underpowered`/`method` (audit-only fields the
 * gate doesn't need: the gate re-derives its own power-floor verdict from `power` alone, per
 * `MEASURED_OUTCOME_POWER_FLOOR`/`powerAdequate` in `evolution/engine.ts`).
 */
export function toGateMeasuredOutcome(signal: MeasuredOutcomeSignal): { incrementalLift: number; power: number } {
  return { incrementalLift: signal.incrementalLift, power: signal.power };
}
