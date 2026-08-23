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
// HONEST LIMIT ON ATOMICITY (documented rather than papered over — the style this codebase already
// uses for `merchant-credential-store.ts`'s "HONEST LIMIT" notes): the dedicated-table write (this
// file's own SQL transaction) and the `rs_audit` write (`state.audit()`, ITS OWN separate transaction,
// since `RuntimeStatePort.audit` does not accept an externally-supplied transaction handle) are TWO
// separate commits, not one atomic unit — true cross-mechanism atomicity would require either a
// two-phase commit or reaching into `PostgresRuntimeStore`'s private hash-chain internals from here,
// both worse than the gap. `set()` therefore audits FIRST, computed from a plain (non-locking) read of
// the current row, and only then performs the actual mutation inside `sql.tx()` (SERIALIZABLE, so the
// mutation itself is concurrency-safe — a losing concurrent writer gets a serialization failure to
// retry, never a lost update). Ordering it this way means the failure mode of a crash between the two
// steps is "an audit row describes a change that was never actually applied" rather than "a change took
// effect with no audit trail at all" — the direction NN#5 (no SILENT autonomous action) actually cares
// about. Under normal (non-crashing, non-concurrent) operation the two agree exactly, and the contract
// suite (`merchantRulesContract`) does not exercise the crash/race window — it is called out here as a
// known gap for a future op job (e.g. reconciling `rs_audit`'s last `rules.changed` entry per tenant
// against `pl_merchant_rules`'s row) rather than silently assumed away.
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
   *  `state-postgres` adapter's `migrate()`. */
  async migrate(): Promise<void> {
    await this.sql.query(
      `CREATE TABLE IF NOT EXISTS pl_merchant_rules (
         tenant_id text PRIMARY KEY CHECK (btrim(tenant_id) <> ''),
         envelope jsonb NOT NULL,
         provenance text NOT NULL,
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

    // Best-effort read for the audit payload (see the file-header "HONEST LIMIT" note) — NOT inside
    // the mutation's own transaction, so its before/after may in the rare concurrent-write race not be
    // byte-identical to what the mutation below actually persists. The mutation's own correctness does
    // not depend on this read.
    const preRead = await this.selectStored(this.sql, tenantId);
    const before = mergeOverDefaults(preRead);
    const { storedAfter, bigJump } = applyPatch(preRead, before, patch);
    const after = mergeOverDefaults(storedAfter);

    await this.state.audit(
      { tenantId },
      {
        actor: by,
        action: "rules.changed",
        input: { patch, provenance },
        decision: { before, after, bigJump },
        reversalPath: `MerchantRulesStore.set(ctx, <before-envelope>, "${by}", "reversal") restores the prior envelope for tenant ${tenantId}`,
      },
      at,
    );

    // The actual mutation: SERIALIZABLE (sql.tx's isolation — sql.ts:5-7) re-reads and re-applies the
    // SAME patch against whatever is CURRENTLY stored, so a writer that raced the pre-read above still
    // lands correctly (or gets a serialization failure to retry) — this is what makes the STATE change
    // itself concurrency-safe, independent of the best-effort audit payload above.
    return this.sql.tx(async (tx) => {
      const current = await this.selectStored(tx, tenantId);
      const currentBefore = mergeOverDefaults(current);
      const { storedAfter: finalStoredAfter, bigJump: finalBigJump } = applyPatch(current, currentBefore, patch);
      const finalAfter = mergeOverDefaults(finalStoredAfter);
      await tx.query(
        `INSERT INTO pl_merchant_rules (${COLUMNS}) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (tenant_id) DO UPDATE
           SET envelope = EXCLUDED.envelope, provenance = EXCLUDED.provenance,
               updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
        [tenantId, JSON.stringify(finalStoredAfter), provenance, by, at],
      );
      return { envelope: finalAfter, bigJump: finalBigJump };
    });
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
