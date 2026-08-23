import {
  isBigJump,
  mergeOverDefaults,
  type CategoryRuleEnvelope,
  type MerchantRuleSet,
  type MerchantRulesStore,
  type ProposalCategory,
  type RuleProvenance,
  type RuleSetChangeResult,
  type RuntimeStateCtx,
  type RuntimeStatePort,
} from "@palup/platform-ports";
import type { Sql } from "./sql.js";

// Postgres adapter for `MerchantRulesStore` (W4-min task 5;
// docs/superpowers/plans/2026-08-23-W4min-automation-rules.md). `MerchantRulesStore`/`MerchantRuleSet`/
// `CONSERVATIVE_DEFAULTS`/`isBigJump`/`mergeOverDefaults` live in `@palup/platform-ports` (NOT
// `@palup/agent-runtime`, which re-exports them) — `state-postgres` importing from `agent-runtime`
// directly would form a package cycle, since `agent-runtime` already depends on `state-postgres` for
// the shared kill registry (`kill.ts`). The durable, staging-real twin of `InMemoryMerchantRulesStore`
// (`@palup/platform-ports/merchant-rules-store.js`, task 2), which is the behavioral ORACLE: both run
// `merchantRulesContract` (`@palup/platform-ports/contract/merchant-rules`), so `createRulesProvider`
// (agent-runtime) and a future `merchant-backend` `GET/PUT /rules` route stay swappable and never learn
// which adapter they got.
//
// WHY A DEDICATED TABLE AND NOT `rs_kv` (unlike `runtime-consent-store.ts`/`cost-cap-registry.ts`,
// which ARE thin registries over `RuntimeStatePort`'s existing KV + audit): the brief for this adapter
// asks for `provenance`/`updated_by` as first-class, independently queryable COLUMNS (an operator can
// answer "which merchants have an `agent_proposed` change pending review" with a plain `SELECT`,
// without replaying the audit log) — not just fields buried inside one JSONB audit-log `input`. So this
// mirrors `PostgresProposalStore`/`PostgresMerchantRegistry`'s "own narrow table" pattern instead.
//
// AUDIT (NN#5), AND WHY THIS ADAPTER IS *NOT* SILENT (a deliberate divergence from
// `PostgresProposalStore`/`PostgresMerchantRegistry`, which write no audit records and leave that to
// their caller): `MerchantRulesStore.set`'s OWN CONTRACT documents that every implementer audits
// internally (`merchant-rules-store.ts`'s interface doc, `platform-ports`) — there is no single
// engine-loop call site (like `loop.ts` for `ProposalStore`) that owns auditing a rules change, so the
// obligation is the adapter's. This constructor therefore takes a SECOND port, `state:
// RuntimeStatePort`, purely to call its `.audit()` — normally the SAME logical Postgres database as
// `sql` (a `PostgresRuntimeStore` built over the same pool/`DATABASE_URL`), so the audit chain this
// writes lands in the SAME `rs_audit` table every other governed mutation in this deployment uses,
// instead of a second, adapter-private audit mechanism that could drift from the canonical hash-chain
// implementation in `postgres-runtime-store.ts`.
//
// HONEST LIMIT ON ATOMICITY, AND WHY `set()` MUTATES BEFORE IT AUDITS (fixed post-review — the
// original revision audited FIRST from a non-locking pre-read, which could commit an audit record
// describing a state the table never actually held, or one that raced ahead of what the SERIALIZABLE
// tx below really applied; and a thrown mutation left no audit trail at all — the exact "silent
// action" NN#5 forbids). This now follows the same MUTATE-THEN-AUDIT convention `loop.ts`'s
// `executeApproved` uses for `ProposalStore` transitions: the table write happens FIRST, inside
// `sql.tx()` (SERIALIZABLE — sql.ts:5-7 — so a racing writer gets a serialization failure to retry,
// never a lost update), and the values captured are the ACTUAL before/after the tx really read and
// wrote — never a value computed outside it. The audit record is written AFTER the tx commits, from
// those actual values, so `rs_audit` can only ever describe a state that genuinely existed. On a
// mutation error, the `catch` writes a `rules.change_failed` audit record (mirroring
// `executeApproved`'s `proposal.execution_failed` pattern) before rethrowing — so even a FAILED
// attempt leaves a trace, never a silent one.
//
// The dedicated-table write and the `rs_audit` write are still TWO separate commits, not one atomic
// unit (`RuntimeStatePort.audit` does not accept an externally-supplied transaction handle, and true
// cross-mechanism atomicity would need either a two-phase commit or reaching into
// `PostgresRuntimeStore`'s private hash-chain internals from here — both worse than the gap). The
// residual, honestly-stated gap: if the process crashes AFTER the tx commits but BEFORE the audit
// write lands, the state changed with (temporarily) no audit record for it — the mirror image of the
// old bug, but strictly smaller in blast radius (a missing audit for a real, correct change, never a
// present audit for a change that never happened or that describes the wrong before/after). A future
// op job (e.g. reconciling `pl_merchant_rules.updated_at` against `rs_audit`'s last `rules.changed`
// entry per tenant) could close this; not built here because nothing calls this adapter yet (see
// `state-postgres/src/index.ts`'s export comment).
//
// SQL INJECTION: every value is a bound `$n` parameter; the only template-substituted text is the
// fixed `COLUMNS` constant defined in this file (never derived from input) — same discipline as
// `postgres-merchant-registry.ts`/`proposal-store.ts`.

interface MerchantRulesRow {
  tenant_id: string;
  envelope: MerchantRuleSet;
  provenance: string;
  updated_by: string;
  updated_at: string;
}

const COLUMNS = "tenant_id, envelope, provenance, updated_by, updated_at";

function requireTenant(tenantId: string): string {
  if (!tenantId || !tenantId.trim())
    throw new Error("MerchantRulesStore: a non-blank tenantId is required (tenant isolation)");
  return tenantId;
}

export interface PostgresMerchantRulesStoreOpts {
  /** Injectable clock (ISO-8601), same knob `PostgresMerchantRegistry`/`PostgresProposalStore`'s callers
   * use, so tests are exact and deterministic (no `Date.now()` in pure code, CLAUDE.md convention). */
  now?: () => string;
}

export class PostgresMerchantRulesStore implements MerchantRulesStore {
  private readonly now: () => string;

  constructor(
    private readonly sql: Sql,
    private readonly state: RuntimeStatePort,
    opts: PostgresMerchantRulesStoreOpts = {},
  ) {
    this.now = opts.now ?? (() => new Date().toISOString());
  }

  /** Create the table if absent. Idempotent; run at startup / in a migration step, like every other
   *  `state-postgres` adapter's `migrate()`. `provenance`'s CHECK mirrors `pl_proposal`'s
   *  `category`/`status` CHECK-guards (`proposal-store.ts`) — restated literally (never interpolated
   *  from the `RuleProvenance` union, which is module-private to `@palup/platform-ports`) so a row
   *  written by anything other than this adapter (a hand-edited row, a future stray writer) cannot
   *  silently smuggle an un-vetted provenance value into an operator's "which merchants have an
   *  `agent_proposed` change pending review" query. */
  async migrate(): Promise<void> {
    await this.sql.query(
      `CREATE TABLE IF NOT EXISTS pl_merchant_rules (
         tenant_id text PRIMARY KEY CHECK (btrim(tenant_id) <> ''),
         envelope jsonb NOT NULL,
         provenance text NOT NULL CHECK (provenance IN ('merchant_set','agent_proposed')),
         updated_by text NOT NULL,
         updated_at text NOT NULL)`,
    );
  }

  async get(ctx: RuntimeStateCtx): Promise<MerchantRuleSet> {
    const tenantId = requireTenant(ctx.tenantId);
    const stored = await this.selectStored(this.sql, tenantId);
    return mergeOverDefaults(stored);
  }

  async set(
    ctx: RuntimeStateCtx,
    patch: MerchantRuleSet,
    by: string,
    provenance: RuleProvenance,
  ): Promise<RuleSetChangeResult> {
    const tenantId = requireTenant(ctx.tenantId);
    const at = this.now();

    // MUTATE FIRST (see the file-header note for why this order changed post-review): the ACTUAL
    // before/after/bigJump come from what this transaction itself read and wrote — never from a
    // separate, non-locking read that could disagree with what actually got committed. SERIALIZABLE
    // (sql.tx's isolation — sql.ts:5-7) makes the mutation concurrency-safe: a racing writer gets a
    // serialization failure to retry, never a lost update.
    let applied: { before: MerchantRuleSet; after: MerchantRuleSet; bigJump: boolean };
    try {
      applied = await this.sql.tx(async (tx) => {
        const current = await this.selectStored(tx, tenantId);
        const before = mergeOverDefaults(current);
        const { storedAfter, bigJump } = applyPatch(current, before, patch);
        const after = mergeOverDefaults(storedAfter);
        await tx.query(
          `INSERT INTO pl_merchant_rules (${COLUMNS}) VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (tenant_id) DO UPDATE
             SET envelope = EXCLUDED.envelope, provenance = EXCLUDED.provenance,
                 updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
          [tenantId, JSON.stringify(storedAfter), provenance, by, at],
        );
        return { before, after, bigJump };
      });
    } catch (e) {
      // No silent failure (NN#5): a rejected/failed mutation still leaves a trace, mirroring
      // `executeApproved`'s `proposal.execution_failed` audit-on-catch pattern (`loop.ts`). Nothing is
      // persisted to `pl_merchant_rules` on this path (the tx rolled back), so there is no "after" to
      // report — only the attempt and why it did not apply.
      await this.state.audit(
        { tenantId },
        {
          actor: by,
          action: "rules.change_failed",
          input: { patch, provenance },
          decision: { error: e instanceof Error ? e.message : String(e) },
          reversalPath: "no state changed — the mutation was rolled back; retry set() with the same patch",
        },
        at,
      );
      throw e;
    }

    // Audited AFTER the tx commits, from the values the tx ACTUALLY applied — `rs_audit` can only ever
    // describe a state that genuinely existed (or, on the catch path above, an attempt that did not).
    await this.state.audit(
      { tenantId },
      {
        actor: by,
        action: "rules.changed",
        input: { patch, provenance },
        decision: { before: applied.before, after: applied.after, bigJump: applied.bigJump },
        reversalPath: `MerchantRulesStore.set(ctx, <before-envelope>, "${by}", "reversal") restores the prior envelope for tenant ${tenantId}`,
      },
      at,
    );

    return { envelope: applied.after, bigJump: applied.bigJump };
  }

  private async selectStored(sql: Sql, tenantId: string): Promise<MerchantRuleSet> {
    const { rows } = await sql.query<MerchantRulesRow>(
      `SELECT ${COLUMNS} FROM pl_merchant_rules WHERE tenant_id = $1`,
      [tenantId],
    );
    return rows[0]?.envelope ?? {};
  }
}

/** Shared patch-application logic (mirrors `InMemoryMerchantRulesStore.set`'s loop exactly, over
 *  `isBigJump`/`CONSERVATIVE_DEFAULTS`, the single source of truth both adapters share): apply a
 *  PARTIAL `patch` on top of `stored`, returning the new stored (unmerged) rule set and whether ANY
 *  touched category looks like a big jump. */
function applyPatch(
  stored: MerchantRuleSet,
  before: MerchantRuleSet,
  patch: MerchantRuleSet,
): { storedAfter: MerchantRuleSet; bigJump: boolean } {
  const storedAfter: MerchantRuleSet = { ...stored };
  let bigJump = false;
  for (const [key, envPatch] of Object.entries(patch)) {
    if (!envPatch) continue;
    const cat = key as ProposalCategory;
    const beforeCat: CategoryRuleEnvelope = before[cat] ?? { allowedAuto: false };
    const afterCat: CategoryRuleEnvelope = { ...beforeCat, ...envPatch };
    storedAfter[cat] = afterCat;
    if (isBigJump(beforeCat, afterCat)) bigJump = true;
  }
  return { storedAfter, bigJump };
}
