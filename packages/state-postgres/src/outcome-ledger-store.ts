import type { ArmAgg, ArmTally, Arm, OutcomeLedgerEntry, Play, RuntimeStatePort } from "@palup/platform-ports";
import { EMPTY_ARM_AGG } from "@palup/platform-ports";

// Wave 2 / W2-A — the durable, per-tenant store for the outcome/usage LEDGER's `ArmTally` accumulator and
// `OutcomeLedgerEntry` append log. Realizes `docs/design/attribution-and-billing.md` §1–2 and
// `docs/adr/0007-attribution-and-metering.md`. SHIPS DARK — nothing calls into this file yet; it is the
// interface later increments (the business holdout — W2-B, the orders webhook — W2-C, and the
// evolution-gate seam — W2-D) will read/write.
//
// PATTERN: mirrors `cost-cap-registry.ts` (tenant-scoped KV rows on the shared RuntimeStatePort, no new
// port surface) and `auto-stage-ledger.ts` (per-key merge-on-write, audited inside the same tx as the
// data write, per NN #5). `ArmTally` rows live in one KV collection keyed by `(play, period, arm)`;
// `OutcomeLedgerEntry`s are appended to one per-merchant stream, matching the design doc's "append-only,
// reconciled per cycle" framing for the outcome ledger.
//
// PROPOSER≠FEE-COMPUTER (task item 4, mirrors `outcome-ledger.ts`'s header). This store persists the LIFT
// METRIC's inputs/outputs ONLY — no fee/billing/pricing computation. `packages/evolution/src/proposer.ts`
// never imports this file, and this file never imports the proposer or anything under `packages/evolution`.
//
// NO PII: `ArmTally` and `OutcomeLedgerEntry` carry only tenant/play/period ids and aggregate numbers —
// no shopper/customer identifiers — so nothing here needs redaction before it is written to the audit log.

const TALLY = "arm_tally"; // KV collection, per tenant, keyed by `${play}::${period}::${arm}`
const LEDGER_STREAM = "outcome_ledger"; // append-only stream, per tenant (= merchantId)

function tallyKey(play: Play, period: string, arm: Arm): string {
  return `${play}::${period}::${arm}`;
}

function toArmAgg(t: ArmTally): ArmAgg {
  return { exposures: t.exposures, orders: t.orders, revenue: t.revenue };
}

export interface AccumulateArmTallyInput {
  tenantId: string;
  play: Play;
  period: string;
  arm: Arm;
  /** Deltas to ADD onto the existing tally (never an overwrite) — default 0 so a caller can report just
   * the counters it actually observed (e.g. an exposure event need not also supply orders/revenue). */
  exposures?: number;
  orders?: number;
  revenue?: number;
}

/**
 * Accumulate (add, never overwrite) onto the `ArmTally` row for `(tenantId, play, period, arm)`. Read +
 * write + audit commit atomically (NN #5) so a mid-write failure can never leave the tally and its audit
 * trail out of sync. Returns the row's new totals.
 */
export async function accumulateArmTally(
  store: RuntimeStatePort,
  input: AccumulateArmTallyInput,
  at = new Date().toISOString(),
  actor = "outcome-ledger",
): Promise<ArmTally> {
  const { tenantId, play, period, arm } = input;
  const dExposures = input.exposures ?? 0;
  const dOrders = input.orders ?? 0;
  const dRevenue = input.revenue ?? 0;
  const key = tallyKey(play, period, arm);
  return store.tx({ tenantId }, async (t) => {
    const cur = (await t.get<ArmTally>(TALLY, key)) ?? { tenantId, play, period, arm, exposures: 0, orders: 0, revenue: 0 };
    const next: ArmTally = {
      tenantId,
      play,
      period,
      arm,
      exposures: cur.exposures + dExposures,
      orders: cur.orders + dOrders,
      revenue: cur.revenue + dRevenue,
    };
    await t.put(TALLY, key, next);
    await t.audit(
      {
        actor,
        action: "arm_tally.accumulate",
        input: { play, period, arm, dExposures, dOrders, dRevenue },
        decision: { exposures: next.exposures, orders: next.orders, revenue: next.revenue },
        reversalPath:
          "accumulate a compensating negative delta for the same (tenantId, play, period, arm) to correct " +
          "an over/under count — the tally is a running total and is never mutated in place",
      },
      at,
    );
    return next;
  });
}

/** The single `(play, period, arm)` row, or null if nothing has been accumulated yet. */
export async function readArmTally(
  store: RuntimeStatePort,
  tenantId: string,
  play: Play,
  period: string,
  arm: Arm,
): Promise<ArmTally | null> {
  return (await store.get<ArmTally>({ tenantId }, TALLY, tallyKey(play, period, arm))) ?? null;
}

/**
 * The treated+control aggregate pair for `(tenantId, play, period)`, ready to hand straight to
 * `computeIncrementalLift`. Missing rows default to `EMPTY_ARM_AGG` (honest zero, never fabricated).
 */
export async function readArmAggPair(
  store: RuntimeStatePort,
  tenantId: string,
  play: Play,
  period: string,
): Promise<{ treated: ArmAgg; control: ArmAgg }> {
  const [treated, control] = await Promise.all([
    readArmTally(store, tenantId, play, period, "treated"),
    readArmTally(store, tenantId, play, period, "control"),
  ]);
  return {
    treated: treated ? toArmAgg(treated) : EMPTY_ARM_AGG,
    control: control ? toArmAgg(control) : EMPTY_ARM_AGG,
  };
}

/** Every `ArmTally` row recorded for a tenant (across all plays/periods/arms) — an operator/debug view. */
export async function listArmTallies(store: RuntimeStatePort, tenantId: string): Promise<ArmTally[]> {
  return (await store.list<ArmTally>({ tenantId }, TALLY)).map((r) => r.value);
}

/**
 * Append one `OutcomeLedgerEntry` to the merchant's outcome ledger (append-only; entries are never
 * mutated retroactively). Scoped by `entry.merchantId` — the entry's own field is the single source of
 * truth for which tenant it belongs to, so there is no separate tenantId argument to drift from it.
 * Append + audit commit atomically (NN #5).
 */
export async function appendOutcomeLedgerEntry(
  store: RuntimeStatePort,
  entry: OutcomeLedgerEntry,
  at = new Date().toISOString(),
  actor = "outcome-ledger",
): Promise<number> {
  return store.tx({ tenantId: entry.merchantId }, async (t) => {
    const cursor = await t.append(LEDGER_STREAM, entry);
    await t.audit(
      {
        actor,
        action: "outcome_ledger.append",
        input: { period: entry.period, play: entry.play, controlRef: entry.controlRef, method: entry.method, confidence: entry.confidence },
        decision: { attributedIncrementalRevenue: entry.attributedIncrementalRevenue },
        reversalPath:
          "append a correcting entry for the same (period, play) — the outcome ledger is append-only " +
          "and is never mutated retroactively (ADR-0007 auditability)",
      },
      at,
    );
    return cursor;
  });
}

/** Read a merchant's outcome ledger oldest-first; `opts.limit` returns the most recent N. */
export async function readOutcomeLedger(
  store: RuntimeStatePort,
  tenantId: string,
  opts?: { limit?: number },
): Promise<OutcomeLedgerEntry[]> {
  return store.readStream<OutcomeLedgerEntry>({ tenantId }, LEDGER_STREAM, opts);
}
