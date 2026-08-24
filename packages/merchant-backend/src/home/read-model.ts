import {
  computeIncrementalLift,
  deriveCostUsd,
  loadModelPrices,
  rollupEvents,
  EMPTY_ARM_AGG,
  type ArmAgg,
  type ModelPriceTable,
  type PrimaryGoal,
  type PrimaryGoalStore,
  type RuntimeStatePort,
  type TelemetryEvent,
} from "@palup/platform-ports";
import { listArmTallies, readOutcomeLedger } from "@palup/state-postgres";

// W2 Task 3 — the Revenue Home READ MODEL (spec §9 W2). Pure derivation over the canonical spine:
//   attributed  ← the outcome ledger (ADR-0007's billing base) — D2: ledger sum is the ONE number;
//                 live per-play lift (arm tallies → computeIncrementalLift) is informational only.
//   cost        ← D1: a minimal period-filtered rollup over the "telemetry" stream (no per-period
//                 TelemetryPort reader exists; the whole-window `query` would mis-bill history).
//                 Inherits trimStream retention — a bounded most-recent window, honest at staging
//                 scale, and unpriced models are FLAGGED (deriveCostUsd), never a fabricated $0.
//   net         ← D3: attributed − cost, withheld (null + reason) unless BOTH sides are honest.
// NO fee computation here — the performance fee is W6's separately-gated boundary (ADR-0007
// proposer≠fee-computer discipline carries over: this module never imports evolution/billing code).

/** "YYYY-MM" in UTC — byte-identical to widget-backend's holdoutPeriod() (holdout.ts:159) so the
 * summary joins the periods the widget plane writes, WITHOUT a service→service import (D5). */
export function currentPeriod(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

export interface PlayMeasurement {
  play: string;
  /** computeIncrementalLift().incrementalLift — 0 (clamped) whenever underpowered. */
  incrementalLiftUsd: number;
  relativeLift: number;
  confidence: number;
  underpowered: boolean;
  method: string;
}

/** The signup→console handoff card (spec: Install & Onboarding). W2 defines the shape and READS it;
 * the WRITER is the onboarding block (D7) — absent ⇒ null ⇒ the console renders no card. Content is
 * merchant-plane copy about the merchant's own signup conversation, never customer data. */
export interface OnboardingHandoff {
  headline: string;
  items: Array<{ label: string; detail: string }>;
  sourceNote: string;
}

export const HANDOFF_COLLECTION = "onboarding_handoff";
export const HANDOFF_KEY = "card";

export interface HomeSummary {
  period: string;
  goal: PrimaryGoal | null;
  attributed: {
    /** Sum of the period's OutcomeLedgerEntry.attributedIncrementalRevenue — the CANONICAL number. */
    totalUsd: number;
    entryCount: number;
    /** Live, per-play measurement state — shown as "measuring", never summed into totalUsd (D2). */
    plays: PlayMeasurement[];
    /** True whenever the headline number can't be trusted as a real "measured" figure yet: the
     * canonical ledger sum is $0 (no billed entry this period — regardless of whether a live play
     * happens to be powered), OR every live play that DOES exist is underpowered. Review-mandated
     * fix: gating this on "zero ledger entries" alone let a POWERED live play with no ledger entry
     * report `underpowered: false` — a console could then pair a bare "$0.00" headline with that
     * play's row showing "Measured", which is exactly the honesty gap this flag exists to prevent.
     * The console's "still measuring" state. */
    underpowered: boolean;
  };
  cost: {
    /** False when the period has zero telemetry events — cost is then UNKNOWN, not $0. */
    metered: boolean;
    /** A LOWER BOUND whenever fullyPriced is false (unpriced models excluded, never guessed). */
    totalUsd: number;
    fullyPriced: boolean;
    unpricedModels: string[];
    events: number;
  };
  net: {
    /** attributed.totalUsd − cost.totalUsd, or null when either side can't honestly support it. A
     * negative value is returned as-is (net-negative shown honestly, spec §10). */
    value: number | null;
    reason: "ok" | "attribution_underpowered" | "cost_not_metered" | "cost_not_fully_priced";
  };
  handoff: OnboardingHandoff | null;
}

export interface HomeSummaryOpts {
  period?: string;
  /** Injectable for deterministic tests; defaults to the operator-provided table (PALUP_MODEL_PRICES
   * over PLACEHOLDER_MODEL_PRICES — telemetry-cost.ts). */
  prices?: ModelPriceTable;
}

const TELEMETRY_STREAM = "telemetry"; // the stream createStoreTelemetry writes (telemetry-port.ts:109)
const TELEMETRY_READ_LIMIT = 10_000; // control-plane's read-bound precedent (control-plane/src/server.ts:196)
const LEDGER_READ_LIMIT = 10_000;

export async function readHomeSummary(
  store: RuntimeStatePort,
  goalStore: PrimaryGoalStore,
  tenantId: string,
  opts: HomeSummaryOpts = {},
): Promise<HomeSummary> {
  const period = opts.period ?? currentPeriod();
  const prices = opts.prices ?? loadModelPrices();
  const ctx = { tenantId };

  const goal = await goalStore.get(ctx);

  // --- attributed: the canonical ledger sum (D2) ---
  const ledger = await readOutcomeLedger(store, tenantId, { limit: LEDGER_READ_LIMIT });
  const periodEntries = ledger.filter((e) => e.period === period);
  const totalUsd = periodEntries.reduce((sum, e) => sum + e.attributedIncrementalRevenue, 0);

  // --- live per-play measurement (informational; underpowered plays clamp to 0 fail-closed) ---
  const tallies = (await listArmTallies(store, tenantId)).filter((t) => t.period === period);
  const byPlay = new Map<string, { treated: ArmAgg; control: ArmAgg }>();
  for (const t of tallies) {
    const pair = byPlay.get(t.play) ?? { treated: EMPTY_ARM_AGG, control: EMPTY_ARM_AGG };
    pair[t.arm] = { exposures: t.exposures, orders: t.orders, revenue: t.revenue };
    byPlay.set(t.play, pair);
  }
  const plays: PlayMeasurement[] = Array.from(byPlay.entries()).map(([play, pair]) => {
    const lift = computeIncrementalLift(pair);
    return {
      play,
      incrementalLiftUsd: lift.incrementalLift,
      relativeLift: lift.relativeLift,
      confidence: lift.confidence,
      underpowered: lift.underpowered,
      method: lift.method,
    };
  });
  // Review-mandated honesty fix: the headline "still measuring" state is driven by whether the
  // CANONICAL number (totalUsd) is actually $0, not merely by "no ledger rows exist" ANDed with
  // "every live play is underpowered". A powered live play with zero ledger entries must still read
  // as "still measuring" — its lift is informational (D2) and is NEVER what backs the headline $.
  // `plays.length > 0 &&` guards the vacuous-truth case: `[].every(...)` is `true` for an EMPTY plays
  // array, which must NOT by itself declare "still measuring" when the ledger already has real money
  // (see the D2 sums-only-the-ledger test, where plays is empty and totalUsd is nonzero).
  const allPlaysUnderpowered = plays.length > 0 && plays.every((p) => p.underpowered);
  const underpowered = totalUsd === 0 || allPlaysUnderpowered;

  // --- cost: period-filtered rollup (D1) ---
  const events = await store.readStream<TelemetryEvent>(ctx, TELEMETRY_STREAM, { limit: TELEMETRY_READ_LIMIT });
  const periodPrefix = `${period}-`;
  const periodEvents = events.filter((e) => typeof e.at === "string" && e.at.startsWith(periodPrefix));
  const breakdown = deriveCostUsd(rollupEvents(tenantId, periodEvents), prices);
  const cost: HomeSummary["cost"] = {
    metered: periodEvents.length > 0,
    totalUsd: breakdown.totalUsd,
    fullyPriced: breakdown.fullyPriced,
    unpricedModels: breakdown.unpricedModels,
    events: periodEvents.length,
  };

  // --- net (D3): withheld unless both sides are honest; precedence attribution → metered → priced ---
  // Gated on the SAME `underpowered` flag as the headline (not the narrower `periodEntries.length ===
  // 0`) so net is never computed against an attributed number the console itself would call "still
  // measuring" — the same honesty fix applied consistently to both surfaces.
  let net: HomeSummary["net"];
  if (underpowered) net = { value: null, reason: "attribution_underpowered" };
  else if (!cost.metered) net = { value: null, reason: "cost_not_metered" };
  else if (!cost.fullyPriced) net = { value: null, reason: "cost_not_fully_priced" };
  else net = { value: totalUsd - cost.totalUsd, reason: "ok" };

  const handoff = await store.get<OnboardingHandoff>(ctx, HANDOFF_COLLECTION, HANDOFF_KEY);

  return {
    period,
    goal,
    attributed: { totalUsd, entryCount: periodEntries.length, plays, underpowered },
    cost,
    net,
    handoff,
  };
}
