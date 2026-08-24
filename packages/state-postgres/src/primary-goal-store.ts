import type {
  PrimaryGoal,
  PrimaryGoalKind,
  PrimaryGoalSetInput,
  PrimaryGoalStore,
  RuntimeStateCtx,
  RuntimeStatePort,
} from "@palup/platform-ports";
import type { Sql } from "./sql.js";

// W2 Task 2 — Postgres adapter for `PrimaryGoalStore` (port + oracle in `@palup/platform-ports/
// primary-goal-store.ts`). Mirrors `PostgresMerchantRulesStore` exactly: own narrow table
// (`pl_primary_goal`, one row per tenant), MUTATE-THEN-AUDIT into the SHARED `rs_audit` chain via
// the second `state: RuntimeStatePort` constructor arg (see merchant-rules-store.ts's file header
// for the full atomicity argument — two commits, honestly-stated crash gap, failed mutations still
// audited via `goal.change_failed`), and a literal CHECK restating the `PrimaryGoalKind` union so a
// hand-edited row can't smuggle an un-vetted kind. SQL injection: every value is a bound `$n`
// parameter; the only template-substituted text is the fixed `COLUMNS` constant.

interface PrimaryGoalRow {
  tenant_id: string;
  kind: string;
  note: string | null;
  set_by: string;
  set_at: string;
}

const COLUMNS = "tenant_id, kind, note, set_by, set_at";

function requireTenant(tenantId: string): string {
  if (!tenantId || !tenantId.trim())
    throw new Error("PrimaryGoalStore: a non-blank tenantId is required (tenant isolation)");
  return tenantId;
}

function rowToGoal(row: PrimaryGoalRow): PrimaryGoal {
  const goal: PrimaryGoal = { kind: row.kind as PrimaryGoalKind, setBy: row.set_by, setAt: row.set_at };
  if (row.note !== null) goal.note = row.note;
  return goal;
}

export interface PostgresPrimaryGoalStoreOpts {
  /** Injectable clock (ISO-8601) — same determinism knob as PostgresMerchantRulesStore. */
  now?: () => string;
}

export class PostgresPrimaryGoalStore implements PrimaryGoalStore {
  private readonly now: () => string;

  constructor(
    private readonly sql: Sql,
    private readonly state: RuntimeStatePort,
    opts: PostgresPrimaryGoalStoreOpts = {},
  ) {
    this.now = opts.now ?? (() => new Date().toISOString());
  }

  /** Idempotent; run at startup like every other state-postgres adapter's migrate(). The kind CHECK
   *  restates the `PrimaryGoalKind` union LITERALLY (never interpolated) — same discipline as
   *  pl_merchant_rules's provenance CHECK. */
  async migrate(): Promise<void> {
    await this.sql.query(
      `CREATE TABLE IF NOT EXISTS pl_primary_goal (
         tenant_id text PRIMARY KEY CHECK (btrim(tenant_id) <> ''),
         kind text NOT NULL CHECK (kind IN ('recover_carts','close_more_chat_sales','grow_repeat_purchases','increase_aov','win_back_lapsed')),
         note text,
         set_by text NOT NULL,
         set_at text NOT NULL)`,
    );
  }

  async get(ctx: RuntimeStateCtx): Promise<PrimaryGoal | null> {
    const tenantId = requireTenant(ctx.tenantId);
    const { rows } = await this.sql.query<PrimaryGoalRow>(
      `SELECT ${COLUMNS} FROM pl_primary_goal WHERE tenant_id = $1`,
      [tenantId],
    );
    const row = rows[0];
    return row ? rowToGoal(row) : null;
  }

  async set(ctx: RuntimeStateCtx, input: PrimaryGoalSetInput, by: string): Promise<PrimaryGoal> {
    const tenantId = requireTenant(ctx.tenantId);
    const setAt = this.now();
    const next: PrimaryGoal = { kind: input.kind, setBy: by, setAt };
    if (input.note !== undefined) next.note = input.note;

    // MUTATE FIRST inside one SERIALIZABLE tx; the `before` captured is what the tx actually read.
    let before: PrimaryGoal | null;
    try {
      before = await this.sql.tx(async (tx) => {
        const { rows } = await tx.query<PrimaryGoalRow>(
          `SELECT ${COLUMNS} FROM pl_primary_goal WHERE tenant_id = $1`,
          [tenantId],
        );
        await tx.query(
          `INSERT INTO pl_primary_goal (${COLUMNS}) VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (tenant_id) DO UPDATE
             SET kind = EXCLUDED.kind, note = EXCLUDED.note,
                 set_by = EXCLUDED.set_by, set_at = EXCLUDED.set_at`,
          [tenantId, next.kind, next.note ?? null, by, setAt],
        );
        const prev = rows[0];
        return prev ? rowToGoal(prev) : null;
      });
    } catch (e) {
      // No silent failure (NN#5) — mirror `rules.change_failed`.
      await this.state.audit(
        { tenantId },
        {
          actor: by,
          action: "goal.change_failed",
          input: { kind: input.kind },
          decision: { error: e instanceof Error ? e.message : String(e) },
          reversalPath: "no state changed — the mutation was rolled back; retry set() with the same input",
        },
        setAt,
      );
      throw e;
    }

    await this.state.audit(
      { tenantId },
      {
        actor: by,
        action: "goal.changed",
        input: { kind: input.kind },
        decision: { before, after: next },
        reversalPath: before
          ? `PrimaryGoalStore.set(ctx, { kind: "${before.kind}" }, "<operator>") restores the prior goal`
          : "first-ever set — a corrected goal can be written via PrimaryGoalStore.set; the audit trail preserves history",
      },
      setAt,
    );

    return next;
  }
}
