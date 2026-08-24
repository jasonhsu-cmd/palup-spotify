import {
  LearnedInsightNotFoundError,
  type LearnedInsight,
  type LearnedListFilter,
  type LearnedStore,
  type RuntimeStateCtx,
  type RuntimeStatePort,
} from "@palup/platform-ports";
import type { Sql } from "./sql.js";

// Postgres adapter for `LearnedStore` (W3 Task 3;
// docs/superpowers/plans/2026-08-24-W3-learned-memory-voice.md). `LearnedStore`/`LearnedInsight`/
// `LearnedListFilter`/`LearnedInsightNotFoundError` live in `@palup/platform-ports` (Task 1) — the
// durable, staging-real twin of `InMemoryLearnedStore` (`@palup/platform-ports/learned-store.js`,
// Task 1), which is the behavioral ORACLE: both run `learnedStoreContract`
// (`@palup/platform-ports/contract/learned-store`), so any future caller stays swappable and never
// learns which adapter it got. Mirrors `PostgresMerchantRulesStore` (`merchant-rules-store.ts`)
// EXACTLY: own dedicated table (not `rs_kv`), constructor `(sql, state, opts?)`, idempotent
// `migrate()`, mutate-then-audit into the shared `rs_audit` chain via the injected `RuntimeStatePort`,
// tenant-scoped, parameterized SQL only.
//
// WHY A DEDICATED TABLE AND NOT `rs_kv`: same reasoning as `pl_merchant_rules` — `category`/`tier`/
// `origin`/`grounding.confidence`/`pinned` are first-class, independently queryable columns (an
// operator can answer "which merchants have a `merchant_taught` voice insight" with a plain `SELECT`),
// not fields buried inside a JSONB blob.
//
// AUDIT (NN#5): `LearnedStore`'s own interface doc (`learned-store.ts`, `platform-ports`) documents
// that every implementer audits internally — there is no single engine-loop call site that owns
// auditing a learned-insight change, so the obligation is the adapter's, same as
// `PostgresMerchantRulesStore`. The constructor takes a SECOND port, `state: RuntimeStatePort`, purely
// to call its `.audit()` — normally the SAME logical Postgres database as `sql` (a
// `PostgresRuntimeStore` built over the same pool/`DATABASE_URL`), so the audit chain this writes
// lands in the SAME `rs_audit` table every other governed mutation in this deployment uses.
//
// MUTATE-THEN-AUDIT: every mutation writes the table FIRST (inside `sql.tx()` where a prior read is
// needed — `setPinned`/`remove` — SERIALIZABLE per `sql.ts`), then audits from the values that
// mutation actually applied — never a value computed outside the transaction. `rs_audit` can only ever
// describe a state that genuinely existed. The `record()` path (an upsert with no pre-read needed for
// its own correctness) still writes the row before auditing, for the same reason.
//
// SQL INJECTION: every value is a bound `$n` parameter; the only template-substituted text is the
// fixed `COLUMNS` constant defined in this file (never derived from input) — same discipline as
// `merchant-rules-store.ts`/`proposal-store.ts`.
//
// CHECK-guards restate the union literals (`category`/`tier`/`origin`/`confidence`, never interpolated
// from the module-private TS unions in `@palup/platform-ports`) so a stray writer can't smuggle an
// un-vetted value past the type system — same discipline as `pl_merchant_rules.provenance`.
//
// Build DARK per CLAUDE.md §3: this is a storage adapter only. Nothing in any `server.ts` imports it
// yet — see `state-postgres/src/index.ts`'s export comment.

interface Row {
  tenant_id: string;
  id: string;
  category: string;
  tier: string;
  origin: string;
  text: string;
  source: string;
  sample_size: number;
  confidence: string;
  pinned: boolean;
  created_at: string;
  updated_at: string;
}

const COLUMNS =
  "tenant_id, id, category, tier, origin, text, source, sample_size, confidence, pinned, created_at, updated_at";

function requireTenant(tenantId: string): string {
  if (!tenantId || !tenantId.trim())
    throw new Error("LearnedStore: a non-blank tenantId is required (tenant isolation)");
  return tenantId;
}

function toInsight(r: Row): LearnedInsight {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    category: r.category as LearnedInsight["category"],
    tier: r.tier as LearnedInsight["tier"],
    origin: r.origin as LearnedInsight["origin"],
    text: r.text,
    grounding: {
      source: r.source,
      sampleSize: r.sample_size,
      confidence: r.confidence as LearnedInsight["grounding"]["confidence"],
    },
    pinned: r.pinned,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export interface PostgresLearnedStoreOpts {
  /** Injectable clock (ISO-8601), same knob every other `state-postgres` adapter's callers use, so
   * tests are exact and deterministic (no `Date.now()` in pure code, CLAUDE.md convention). Unused by
   * this adapter today (every mutating method already takes its own `at`/`by`), kept for parity with
   * `PostgresMerchantRulesStore`'s constructor shape and in case a future method needs it. */
  now?: () => string;
}

export class PostgresLearnedStore implements LearnedStore {
  private readonly now: () => string;

  constructor(
    private readonly sql: Sql,
    private readonly state: RuntimeStatePort,
    opts: PostgresLearnedStoreOpts = {},
  ) {
    this.now = opts.now ?? (() => new Date().toISOString());
  }

  /** Create the table if absent. Idempotent; run at startup / in a migration step, like every other
   *  `state-postgres` adapter's `migrate()`. */
  async migrate(): Promise<void> {
    await this.sql.query(
      `CREATE TABLE IF NOT EXISTS pl_learned_insight (
         tenant_id text NOT NULL CHECK (btrim(tenant_id) <> ''),
         id text NOT NULL,
         category text NOT NULL CHECK (category IN ('customers','products','voice','policies')),
         tier text NOT NULL CHECK (tier IN ('private','aggregate')),
         origin text NOT NULL CHECK (origin IN ('synthesized','merchant_taught')),
         text text NOT NULL,
         source text NOT NULL,
         sample_size integer NOT NULL,
         confidence text NOT NULL CHECK (confidence IN ('medium','high')),
         pinned boolean NOT NULL,
         created_at text NOT NULL,
         updated_at text NOT NULL,
         PRIMARY KEY (tenant_id, id))`,
    );
  }

  async list(ctx: RuntimeStateCtx, filter?: LearnedListFilter): Promise<LearnedInsight[]> {
    // The private store NEVER serves the aggregate tier — a hard wall, mirroring
    // `InMemoryLearnedStore.list` exactly (the behavioral oracle both adapters share).
    if ((filter?.tier ?? "private") !== "private") return [];
    const tenantId = requireTenant(ctx.tenantId);
    const params: unknown[] = [tenantId];
    let where = "tenant_id = $1";
    if (filter?.category) {
      params.push(filter.category);
      where += ` AND category = $${params.length}`;
    }
    const { rows } = await this.sql.query<Row>(
      `SELECT ${COLUMNS} FROM pl_learned_insight WHERE ${where} ORDER BY created_at DESC`,
      params,
    );
    return rows.map(toInsight);
  }

  async get(ctx: RuntimeStateCtx, id: string): Promise<LearnedInsight | null> {
    const tenantId = requireTenant(ctx.tenantId);
    const { rows } = await this.sql.query<Row>(
      `SELECT ${COLUMNS} FROM pl_learned_insight WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id],
    );
    return rows[0] ? toInsight(rows[0]) : null;
  }

  async record(ctx: RuntimeStateCtx, insight: LearnedInsight, by: string): Promise<LearnedInsight> {
    const tenantId = requireTenant(ctx.tenantId);
    await this.sql.query(
      `INSERT INTO pl_learned_insight (${COLUMNS}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (tenant_id, id) DO UPDATE SET category=EXCLUDED.category, tier=EXCLUDED.tier, origin=EXCLUDED.origin,
         text=EXCLUDED.text, source=EXCLUDED.source, sample_size=EXCLUDED.sample_size, confidence=EXCLUDED.confidence,
         pinned=EXCLUDED.pinned, updated_at=EXCLUDED.updated_at`,
      [
        tenantId,
        insight.id,
        insight.category,
        insight.tier,
        insight.origin,
        insight.text,
        insight.grounding.source,
        insight.grounding.sampleSize,
        insight.grounding.confidence,
        insight.pinned,
        insight.createdAt,
        insight.updatedAt,
      ],
    );
    await this.state.audit(
      { tenantId },
      {
        actor: by,
        action: "learned.recorded",
        input: { id: insight.id, category: insight.category, origin: insight.origin, source: insight.grounding.source },
        decision: { confidence: insight.grounding.confidence, sampleSize: insight.grounding.sampleSize, tier: insight.tier },
        reversalPath: `LearnedStore.remove(ctx, "${insight.id}", by, at) deletes this insight for tenant ${tenantId}`,
      },
      insight.updatedAt,
    );
    return insight;
  }

  async setPinned(ctx: RuntimeStateCtx, id: string, pinned: boolean, by: string, at: string): Promise<LearnedInsight> {
    const tenantId = requireTenant(ctx.tenantId);
    const updated = await this.sql.tx(async (tx) => {
      const { rows } = await tx.query<Row>(
        `SELECT ${COLUMNS} FROM pl_learned_insight WHERE tenant_id = $1 AND id = $2`,
        [tenantId, id],
      );
      if (!rows[0]) throw new LearnedInsightNotFoundError(id);
      await tx.query(`UPDATE pl_learned_insight SET pinned = $3, updated_at = $4 WHERE tenant_id = $1 AND id = $2`, [
        tenantId,
        id,
        pinned,
        at,
      ]);
      return { was: rows[0].pinned, next: { ...toInsight(rows[0]), pinned, updatedAt: at } };
    });
    await this.state.audit(
      { tenantId },
      {
        actor: by,
        action: "learned.pinned",
        input: { id, pinned },
        decision: { was: updated.was },
        reversalPath: `LearnedStore.setPinned(ctx, "${id}", ${updated.was}, by, at) restores the prior pin state`,
      },
      at,
    );
    return updated.next;
  }

  async remove(ctx: RuntimeStateCtx, id: string, by: string, at: string): Promise<void> {
    const tenantId = requireTenant(ctx.tenantId);
    const prior = await this.sql.tx(async (tx) => {
      const { rows } = await tx.query<Row>(
        `SELECT ${COLUMNS} FROM pl_learned_insight WHERE tenant_id = $1 AND id = $2`,
        [tenantId, id],
      );
      if (!rows[0]) throw new LearnedInsightNotFoundError(id);
      await tx.query(`DELETE FROM pl_learned_insight WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
      return rows[0];
    });
    await this.state.audit(
      { tenantId },
      {
        actor: by,
        action: "learned.removed",
        input: { id, category: prior.category, origin: prior.origin },
        decision: { removed: true },
        reversalPath: `irreversible delete — re-teach via LearnedStore.record to restore it for tenant ${tenantId}`,
      },
      at,
    );
  }
}
