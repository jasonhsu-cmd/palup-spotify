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

const TALLY = "arm_tally"; // KV collection, per tenant, keyed by `${play}::${period}::${arm}::${shardId}`
const LEDGER_STREAM = "outcome_ledger"; // append-only stream, per tenant (= merchantId)

// Durability NOW-1 (sharded counters): a single `(play, period, arm)` row was a write-contention
// hotspot — every concurrent shopper turn in the same merchant/arm/period did a SERIALIZABLE
// read-modify-write against that ONE row, so concurrent writers on the Postgres adapter collide and
// retry under real load (fails on concurrency, not volume). Each logical tally is now spread across
// `armTallyShardCount()` physical shard rows keyed `(play, period, arm, shardId)`; a write picks ONE
// random shard and only reads/writes that row (never all N — reading every shard inside the write tx
// would reintroduce the same contention via SERIALIZABLE's read-write conflict detection), so
// concurrent writers land on different rows most of the time (~N× less per-row contention). Reads
// (`readArmTally`, `readArmAggPair`) transparently SUM across all N shards, so every OTHER caller sees
// exactly the same value as before sharding — the public value is unchanged, only its storage is split.
//
// SHARD COUNT IS A DEPLOY-TIME CONSTANT, NOT A LIVE KNOB. Changing `ARM_TALLY_SHARD_COUNT` after data
// has already been written under the old count silently truncates the sum for any shardId >= the new
// count (old high-numbered shards become invisible to the read-side loop) — on a money ledger that is
// a silent under-count, not a crash. Treat any shard-count change as a migration (drain/resum under
// the old count first), never a hot config flip.
const DEFAULT_ARM_TALLY_SHARD_COUNT = 16;

function armTallyShardCount(): number {
  const raw = process.env.ARM_TALLY_SHARD_COUNT;
  const n = raw !== undefined ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_ARM_TALLY_SHARD_COUNT;
}

function tallyKey(play: Play, period: string, arm: Arm, shardId: number): string {
  return `${play}::${period}::${arm}::${shardId}`;
}

function toArmAgg(t: ArmAgg): ArmAgg {
  return { exposures: t.exposures, orders: t.orders, revenue: t.revenue };
}

/** Sum a list of same-key `ArmTally` shard rows into the one logical `ArmAgg` they represent. */
function sumShards(rows: ArmTally[]): ArmAgg {
  return rows.reduce<ArmAgg>(
    (acc, r) => ({ exposures: acc.exposures + r.exposures, orders: acc.orders + r.orders, revenue: acc.revenue + r.revenue }),
    { exposures: 0, orders: 0, revenue: 0 },
  );
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
 * Accumulate (add, never overwrite) onto the `ArmTally` for `(tenantId, play, period, arm)`. Read +
 * write + audit commit atomically (NN #5) so a mid-write failure can never leave the tally and its audit
 * trail out of sync. The logical tally is sharded (see header): this call writes ONE randomly-chosen
 * shard row only — never all N — so it never reads/writes rows other callers are concurrently touching.
 * Returns THAT SHARD'S new subtotal (not the tenant-wide total across all shards — deliberately, so
 * this call never has to read every shard); callers needing the true cumulative value must use
 * `readArmTally`/`readArmAggPair`, which sum across all shards. No caller today reads this return value.
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
  const shardId = Math.floor(Math.random() * armTallyShardCount());
  const key = tallyKey(play, period, arm, shardId);
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
        input: { play, period, arm, shardId, dExposures, dOrders, dRevenue },
        decision: { shardId, exposures: next.exposures, orders: next.orders, revenue: next.revenue },
        reversalPath:
          "accumulate a compensating negative delta for the same (tenantId, play, period, arm) to correct " +
          "an over/under count — the shard it lands on need not match this write's shardId (shards are " +
          "an internal storage detail; readArmTally/readArmAggPair sum across all of them), and the " +
          "tally is a running total that is never mutated in place",
      },
      at,
    );
    return next;
  });
}

/** The logical `(play, period, arm)` tally, summed across every shard row, or null if nothing has been
 *  accumulated yet in ANY shard. This is the value every caller outside this file should use — it is
 *  exactly what a single unsharded row would have held (sharding only changes storage, never the sum). */
export async function readArmTally(
  store: RuntimeStatePort,
  tenantId: string,
  play: Play,
  period: string,
  arm: Arm,
): Promise<ArmTally | null> {
  const rows = await readArmTallyShards(store, tenantId, play, period, arm);
  if (rows.length === 0) return null;
  return { tenantId, play, period, arm, ...sumShards(rows) };
}

/** Debug/operator view: every PHYSICAL shard row for `(tenantId, play, period, arm)`, unsummed (absent
 *  shards omitted — never a fabricated zero row). NOT the value to feed `computeIncrementalLift` or any
 *  billing/attribution decision — use `readArmTally`/`readArmAggPair` for that. Exists so an operator or
 *  a test can observe how writes distributed across `ARM_TALLY_SHARD_COUNT` shards. */
export async function readArmTallyShards(
  store: RuntimeStatePort,
  tenantId: string,
  play: Play,
  period: string,
  arm: Arm,
): Promise<ArmTally[]> {
  const keys = Array.from({ length: armTallyShardCount() }, (_, shardId) => tallyKey(play, period, arm, shardId));
  const rows = await Promise.all(keys.map((key) => store.get<ArmTally>({ tenantId }, TALLY, key)));
  return rows.filter((r): r is ArmTally => r !== null);
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

/** Every logical `(play, period, arm)` tally recorded for a tenant, ONE row per triple with its shards
 *  already summed (across all plays/periods/arms) — an operator/debug view. Pre-sharding this returned
 *  the raw KV rows 1:1; now that a triple can be backed by multiple physical shard rows, this groups
 *  and sums them so the shape callers see is unchanged (still exactly one `ArmTally` per triple). */
export async function listArmTallies(store: RuntimeStatePort, tenantId: string): Promise<ArmTally[]> {
  const shardRows = (await store.list<ArmTally>({ tenantId }, TALLY)).map((r) => r.value);
  const byTriple = new Map<string, ArmTally>();
  for (const r of shardRows) {
    const k = `${r.play}::${r.period}::${r.arm}`;
    const existing = byTriple.get(k);
    const merged: ArmTally = existing
      ? { ...existing, ...sumShards([existing, r]) }
      : { tenantId: r.tenantId, play: r.play, period: r.period, arm: r.arm, ...toArmAgg(r) };
    byTriple.set(k, merged);
  }
  return Array.from(byTriple.values());
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
