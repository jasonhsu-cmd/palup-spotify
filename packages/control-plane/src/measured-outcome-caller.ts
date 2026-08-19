import type { RuntimeStatePort } from "@palup/platform-ports";
import { HOLDOUT_PLAY, holdoutPeriod } from "@palup/widget-backend/src/holdout.js";
import { readMeasuredOutcomeSignal, type MeasuredOutcomeSignal } from "./measured-outcome-signal.js";

// Revenue-flywheel W3-2 — THE KEYSTONE WIRING MODULE. `measured-outcome-signal.ts` deliberately deferred
// the (tenantId, play, period) contract ("a business decision... which play/period a given evaluation
// round should read is a business question this module does not guess"). This is that decision, made
// ONCE, for every caller (canary / monitor / gate) to share — never re-derived per call site.
//
// THE ANSWER:
//   • play = HOLDOUT_PLAY ("agent", `widget-backend/src/holdout.ts`) — the only play the v1 business
//     holdout covers. There is no per-play vocabulary yet (cart_recovery/upsell/win-back/...; that's
//     explicitly future work per `outcome-ledger.ts`'s own `Play` doc comment), so "the serving policy's
//     measured lift" and "the 'agent' play's measured lift" are, today, the SAME question.
//   • period = holdoutPeriod(now) — the SAME UTC `YYYY-MM` bucket `assignHoldoutArm` and the W2-C
//     orders/refunds webhook worker already write `ArmTally` rows against. This module does not invent a
//     NEW bucketing scheme; it reads the one the ledger WRITERS already use, so a read here is guaranteed
//     to line up with what was actually written for the period that just closed / is still open.
//   • tenantId is the CALLER's own tenant scope (RUNTIME_TENANT / PROMOTE_TENANT today — single "demo"
//     tenant; per-tenant once multi-tenancy is real, ADR-0014 #4) — never guessed here.
//
// WHY THIS LIVES IN CONTROL-PLANE, NOT EVOLUTION: `packages/evolution/src/engine.ts` must stay
// store-free (CLAUDE.md §3 layering — evolution is upstream of control-plane, so the dependency can only
// run this direction) and never imports `RuntimeStatePort` or any store adapter. This module is the ONE
// place a `RuntimeStatePort` and a live clock reduce to the `{incrementalLift, power}` shape the engine's
// `PolicyMetrics.measuredOutcome` / `regressionVerdict` / `recordCanary` seams already accept.
//
// NEW DEPENDENCY EDGE: control-plane -> widget-backend (for `HOLDOUT_PLAY`/`holdoutPeriod` only — a
// design decision, flagged). Precedented by `packages/eval`, which already deep-imports
// `@palup/widget-backend/src/*.js` for the same reason (no barrel/index export on that package, so a
// deep subpath import is the established pattern — see `guard-classifier.js`/`retrieval-eval.js`).
// widget-backend does NOT depend on control-plane, so this introduces no cycle. The alternative (mirroring
// the play/period computation locally, the way `champion-promoter.ts` mirrors the CHAMPION/ACTIVE_KEY
// collection name) was rejected: a re-derived period format could silently drift from the one the holdout
// module actually writes, and there is nothing here it would save beyond one workspace dependency edge.

/**
 * Read the CURRENT serving measured-outcome signal for `tenantId` — the treated-vs-control incremental
 * lift over the (tenantId, HOLDOUT_PLAY, holdoutPeriod(now)) `ArmTally` pair. Never fabricates: with no
 * holdout/orders activity yet, `readMeasuredOutcomeSignal` returns the honest zero
 * (`underpowered: true, incrementalLift: 0, power: 0`) — DARK-SAFE by construction, since every consumer
 * (`engine.gate`, `regressionVerdict`, `recordCanary`) already treats an underpowered/absent signal as a
 * no-op fallback to the quality proxy.
 */
export async function readServingMeasuredOutcome(
  store: RuntimeStatePort,
  tenantId: string,
  now: Date = new Date(),
): Promise<MeasuredOutcomeSignal> {
  return readMeasuredOutcomeSignal(store, tenantId, HOLDOUT_PLAY, holdoutPeriod(now));
}
