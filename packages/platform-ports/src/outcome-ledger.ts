// Wave 2 / W2-A — the revenue-flywheel's outcome/usage LEDGER types + the treated-vs-holdout
// INCREMENTALITY math. Realizes `docs/design/attribution-and-billing.md` §1–2 (lines ~9-24, ~66-71) and
// `docs/adr/0007-attribution-and-metering.md`. SHIPS DARK: nothing in the serving path or the evolution
// gate imports this file yet. It defines the interface later increments (a business holdout — W2-B, an
// orders webhook — W2-C, and the evolution-gate seam — W2-D) will read/write.
//
// WHY PLATFORM-PORTS AND NOT STATE-POSTGRES. This file has zero infra/vendor dependency — no
// RuntimeStatePort, no Postgres, no SDK — mirroring `telemetry-cost.ts` (pure types + a pure cost
// derivation) rather than `metering.ts` (a port decorator). The durable store built ON TOP of these
// types lives in `packages/state-postgres/src/outcome-ledger-store.ts`, following the existing
// `cost-cap-registry.ts` / `runtime-consent-store.ts` registry pattern over `RuntimeStatePort`.
//
// PROPOSER≠FEE-COMPUTER (hard invariant, task item 4). This module computes the LIFT METRIC ONLY — it
// contains NO fee/billing/pricing computation (the performance fee is OFF; this is internal-metric-first,
// per `docs/design/attribution-and-billing.md` §1's "Governed & versioned" note and ADR-0007 §2: any
// change to the attribution/fee MODEL is a money/business-model boundary crossing that walks the full
// evolution pipeline with human approval — never auto-applied). It is a STANDALONE artifact:
// `packages/evolution/src/proposer.ts` never imports this file, and this file never imports the
// proposer. Keeping the lift metric and the (future, separately-gated) fee computation in disjoint
// modules makes that boundary a structural fact, not a code-review convention.
//
// NO LAST-TOUCH (hard invariant, ADR-0007 §2 / `docs/PRICING.md` §2). `computeIncrementalLift` takes only
// AGGREGATE per-arm counts (`ArmAgg`) — exposures/orders/revenue totals — never an order-id, click-id, or
// recommendation-id. There is structurally no join key here that could credit one order to one prior
// touch; incremental revenue is derived exclusively from the measured gap between the treated and
// control arms' revenue-per-exposure. See `packages/widget-backend/src/recommendation-telemetry.ts` for
// the parallel guardrail on the (unrelated) recommendation-telemetry field this module must never be
// wired to.

/** A merchant "play" (cart recovery, upsell, win-back, nurture, ...). Kept as a free-text id — the exact
 * slug vocabulary is owned by whichever increment first assigns plays to real merchant flows (W2-B/C),
 * not guessed here. */
export type Play = string;

/** Which side of the holdout an aggregate/tally belongs to. */
export type Arm = "treated" | "control";

/**
 * `docs/design/attribution-and-billing.md:12` — `outcome_ledger_entry`. One row per (merchant, period,
 * play): the attributed INCREMENTAL revenue for that play in that billing period, plus the method and
 * confidence that produced it (auditable — "you made me $X, you charged $Y").
 */
export interface OutcomeLedgerEntry {
  merchantId: string;
  period: string;
  play: Play;
  /** USD. Incremental revenue only (never organic/baseline) — never last-touch. */
  attributedIncrementalRevenue: number;
  /** Reference to the control/holdout group this entry was measured against (auditable). */
  controlRef: string;
  /** Versioned method string (e.g. `computeIncrementalLift`'s output `method`). */
  method: string;
  /** 0..1 statistical confidence in the measured lift. */
  confidence: number;
}

/**
 * `docs/design/attribution-and-billing.md:23` — `usage_ledger_entry`. TYPE ONLY in this increment;
 * population (deterministic credit metering per action) is a later increment. `billable` mirrors the
 * design doc's `billable|absorbed` tag: `true` = billed to the merchant (overage), `false` = absorbed
 * (metered for PalUp's own COGS only — background inference, agent tax, heartbeat, diagnostics,
 * segmentation, memory embeddings, rejected drafts).
 */
export interface UsageLedgerEntry {
  merchantId: string;
  action: string;
  credits: number;
  billable: boolean;
  costCogs: number;
  category: string;
  /** ISO-8601 timestamp. */
  ts: string;
}

/** Aggregate counts for one arm over one (tenant, play, period) — no order/click identifiers, so there is
 * nothing here a last-touch join could key off. This is the shape `computeIncrementalLift` consumes AND
 * the shape `ArmTally` reduces to for a read. */
export interface ArmAgg {
  exposures: number;
  orders: number;
  revenue: number;
}

/** The zero aggregate — the honest default for an arm with no recorded activity (never fabricated). */
export const EMPTY_ARM_AGG: Readonly<ArmAgg> = { exposures: 0, orders: 0, revenue: 0 };

/**
 * The per-arm aggregate ROW that the holdout (W2-B) and the orders webhook (W2-C) accumulate into, one
 * row per (tenantId, play, period, arm). This is the interface everything else in the revenue flywheel
 * writes to — see `packages/state-postgres/src/outcome-ledger-store.ts` for the durable accumulator.
 */
export interface ArmTally extends ArmAgg {
  tenantId: string;
  play: Play;
  period: string;
  arm: Arm;
}

export interface IncrementalLiftInput {
  treated: ArmAgg;
  control: ArmAgg;
}

export interface IncrementalLiftResult {
  /** USD. (treated revenue-per-exposure − control revenue-per-exposure) × treated exposures. Clamped to
   * 0 whenever `underpowered` — NEVER a positive number the measurement can't support. */
  incrementalLift: number;
  /** (treated rate − control rate) / control rate. 0 when underpowered, or when the control rate is
   * exactly 0 (division has no finite answer — see the comment at its computation). */
  relativeLift: number;
  /** 0..1. `1 - (two-sided p-value)` of a two-proportion z-test on order rate. Forced to 0 whenever
   * `underpowered` — a confidence number is not meaningful without enough data to compute one. */
  confidence: number;
  /** Versioned, human-readable method string. Always includes WHY when underpowered, so the reason is
   * auditable even though the numeric result is clamped away. */
  method: string;
  /** true whenever the inputs cannot support a trustworthy lift measurement: below the min-exposure
   * floor, a zero/absent control, or non-finite/invalid inputs. Fail-closed. */
  underpowered: boolean;
}

/** Minimum exposures REQUIRED IN EACH ARM before a two-proportion test is trusted. Chosen so the normal
 * approximation the z-test relies on holds even at a low single-digit-percent order rate (the standard
 * rule of thumb wants `n·p·(1−p) ≳ 5` per arm; at a 5% rate that is `n ≳ 100`, so 200 leaves headroom).
 * This is an engineering default, not a vendor/world fact, and later increments (W2-B's holdout sizing)
 * may want it configurable — flagged here rather than silently assumed. */
export const MIN_EXPOSURES_PER_ARM = 200;

const METHOD_BASE = "incrementality-v1:two-arm-holdout-lift+two-proportion-z";

function isValidArmAgg(agg: ArmAgg): boolean {
  const vals = [agg.exposures, agg.orders, agg.revenue];
  // Fail-closed net wider than the letter of "non-finite": a negative count cannot occur for a real
  // exposure/order/revenue total, so treating a negative as invalid too is a strengthening of the same
  // honesty requirement, not a different rule. Documented rather than silently assumed.
  return vals.every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0);
}

/** Abramowitz & Stegun 7.1.26 approximation of erf, max absolute error 1.5e-7 — dependency-free and
 * accurate enough for a confidence estimate (no vendor stats library needed). */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1 / (1 + p * ax);
  const y = 1 - (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t) * Math.exp(-ax * ax);
  return sign * y;
}

function normalCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

/** Two-proportion z-statistic on order rate (orders/exposures), pooled-variance form. Returns 0 when the
 * pooled variance is 0 (e.g. both arms show a 0% or 100% rate) — there is no signal to test, not an
 * infinite one. */
function twoProportionZ(treated: ArmAgg, control: ArmAgg): number {
  const n1 = treated.exposures;
  const n2 = control.exposures;
  const p1 = treated.orders / n1;
  const p2 = control.orders / n2;
  const pPooled = (treated.orders + control.orders) / (n1 + n2);
  const se = Math.sqrt(pPooled * (1 - pPooled) * (1 / n1 + 1 / n2));
  if (!Number.isFinite(se) || se === 0) return 0;
  return (p1 - p2) / se;
}

function underpowered(method: string): IncrementalLiftResult {
  return { incrementalLift: 0, relativeLift: 0, confidence: 0, method, underpowered: true };
}

/**
 * THE CRUX. Incrementality against a holdout/control — never last-touch (ADR-0007 §2 / PRICING.md §2).
 *
 *   incrementalLift = (treated revenue-per-exposure − control revenue-per-exposure) × treated exposures
 *
 * Fail-closed: below `MIN_EXPOSURES_PER_ARM`, a zero/absent control, or non-finite/invalid inputs all
 * return `underpowered: true`, `confidence: 0`, and `incrementalLift` CLAMPED TO 0 — never a positive
 * attributed-revenue figure the measurement can't support, even if the raw (untrusted) numbers would
 * suggest one.
 */
export function computeIncrementalLift(input: IncrementalLiftInput): IncrementalLiftResult {
  const { treated, control } = input;

  if (!isValidArmAgg(treated) || !isValidArmAgg(control)) {
    return underpowered(`${METHOD_BASE}:underpowered-invalid-input`);
  }
  if (control.exposures <= 0) {
    return underpowered(`${METHOD_BASE}:underpowered-zero-control`);
  }
  if (treated.exposures < MIN_EXPOSURES_PER_ARM || control.exposures < MIN_EXPOSURES_PER_ARM) {
    return underpowered(`${METHOD_BASE}:underpowered-min-exposure-floor`);
  }

  const treatedRate = treated.revenue / treated.exposures;
  const controlRate = control.revenue / control.exposures;
  const incrementalLift = (treatedRate - controlRate) * treated.exposures;
  // Guard division-by-zero: a control arm with real exposures but zero revenue/orders is a legitimate,
  // well-powered outcome (e.g. the control genuinely converted nobody) — NOT the same as "zero/absent
  // control" above (which is zero EXPOSURES). Falling back to 0 rather than an infinite ratio keeps the
  // output finite without fabricating a number; the absolute `incrementalLift` above still carries the
  // real signal.
  const relativeLift = controlRate !== 0 ? (treatedRate - controlRate) / controlRate : 0;

  const z = twoProportionZ(treated, control);
  const confidence = Math.min(1, Math.max(0, 2 * normalCdf(Math.abs(z)) - 1));

  return { incrementalLift, relativeLift, confidence, method: METHOD_BASE, underpowered: false };
}
