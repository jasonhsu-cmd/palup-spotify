import {
  ProposalNotFoundError,
  VersionConflictError,
  type Proposal,
  type ProposalListFilter,
  type ProposalListResult,
  type ProposalStore,
  type ProposalTransitionPatch,
  type RuntimeStateCtx,
} from "@palup/platform-ports";
import type { Sql } from "./sql.js";

// Postgres adapter for `ProposalStore` (E1 Task 8; docs/superpowers/plans/2026-08-23-E1-engine-core.md).
// `ProposalStore`/`Proposal`/etc. live in `@palup/platform-ports` (not `@palup/agent-runtime`, which
// re-exports them) — `state-postgres` importing from `agent-runtime` directly would form a package
// cycle, since `agent-runtime` already depends on `state-postgres` for the shared kill registry
// (`kill.ts`). The durable, staging-real twin of `InMemoryProposalStore`
// (`@palup/platform-ports/proposal-store.js`, Task 2), which is the behavioral ORACLE: both run
// `proposalStoreContract` (`@palup/platform-ports/contract/proposal-store`), so the engine loop
// (`agent-runtime/loop.ts`) stays swappable and never learns which adapter it got.
//
// PATTERN: mirrors `PostgresMerchantRegistry` — a DEDICATED table (not a KV row over
// `RuntimeStatePort`), because this adapter needs a real SQL-engine-enforced optimistic lock: the
// `version` column plus a CAS `UPDATE ... WHERE id=$ AND version=$expected` (0 rows affected ⇒ stale),
// which a JSONB blob under `rs_kv` cannot give for free. Tenant-scoped by `PRIMARY KEY (tenant_id, id)`
// — every statement below is predicated on `tenant_id`, so a lookup for another tenant's id returns
// null/not-found rather than leaking the row.
//
// AUDIT (NN#5): like `PostgresMerchantRegistry`, this adapter writes NO audit records itself.
// `loop.ts` (the only caller — `proposeOrExecute`/`executeApproved`/`rejectProposal`/
// `withdrawProposal`/`expireStale`) already calls `deps.state.audit(...)` around every one of this
// store's mutations, so an adapter-internal audit would be a silent duplicate of that trail, not a
// second layer of defense. (`InMemoryProposalStore.create/transition` DO audit internally — that is a
// registry-over-`RuntimeStatePort` convention (its own tx/audit are the same call); this adapter's
// dedicated table has no such tx to piggyback on, so it follows `PostgresMerchantRegistry`'s
// "adapter is silent, caller audits" convention instead. Neither leaves NN#5 unmet: `loop.ts` is the
// caller for both.)
//
// JSONB columns (`action`, `boundary_reasons`, `estimated_impact`, `reversal_plan`, `preconditions`,
// `execution_result`) are written as `JSON.stringify(...)` parameters against a plain `$n` placeholder
// — the same convention `postgres-runtime-store.ts` (`rs_kv.value`, `rs_stream.entry`) and
// `postgres-runtime-store.ts`'s audit `input`/`decision` columns already use; node-postgres/pglite
// parse a jsonb column back into a JS value automatically, no `JSON.parse` needed on read.
//
// SQL INJECTION: every value is a bound `$n` parameter; the only template-substituted text is the
// fixed `COLUMNS` constant defined in this file (never derived from input) — same discipline as
// `postgres-merchant-registry.ts`.

interface ProposalRow {
  tenant_id: string;
  id: string;
  agent_id: string;
  agent_type: string;
  action: Proposal["action"];
  category: string;
  rationale: string;
  boundary_reasons: Proposal["boundaryReasons"];
  estimated_impact: Proposal["estimatedImpact"] | null;
  reversal_plan: Proposal["reversalPlan"];
  preconditions: Proposal["preconditions"];
  status: string;
  version: number;
  created_at: string;
  expires_at: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  execution_id: string | null;
  executed_at: string | null;
  execution_result: Proposal["executionResult"] | null;
}

const COLUMNS =
  "tenant_id, id, agent_id, agent_type, action, category, rationale, boundary_reasons, estimated_impact, " +
  "reversal_plan, preconditions, status, version, created_at, expires_at, decided_by, decided_at, " +
  "decision_note, execution_id, executed_at, execution_result";

/** NULL columns become ABSENT keys, not `null` — matches the in-memory oracle's shape under
 *  `toStrictEqual` (JS objects built from a literal never carry an unset optional key). */
function toProposal(row: ProposalRow): Proposal {
  const p: Proposal = {
    id: row.id,
    tenantId: row.tenant_id,
    agentId: row.agent_id,
    agentType: row.agent_type,
    action: row.action,
    category: row.category as Proposal["category"],
    rationale: row.rationale,
    boundaryReasons: row.boundary_reasons,
    reversalPlan: row.reversal_plan,
    preconditions: row.preconditions,
    status: row.status as Proposal["status"],
    version: row.version,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
  if (row.estimated_impact !== null) p.estimatedImpact = row.estimated_impact;
  if (row.decided_by !== null) p.decidedBy = row.decided_by;
  if (row.decided_at !== null) p.decidedAt = row.decided_at;
  if (row.decision_note !== null) p.decisionNote = row.decision_note;
  if (row.execution_id !== null) p.executionId = row.execution_id;
  if (row.executed_at !== null) p.executedAt = row.executed_at;
  if (row.execution_result !== null) p.executionResult = row.execution_result;
  return p;
}

function requireTenant(tenantId: string): string {
  if (!tenantId || !tenantId.trim())
    throw new Error("ProposalStore: a non-blank tenantId is required (tenant isolation)");
  return tenantId;
}

/** The 21 bound values for an INSERT/full-row-UPDATE, in `COLUMNS` order. */
function rowParams(p: Proposal): unknown[] {
  return [
    p.tenantId,
    p.id,
    p.agentId,
    p.agentType,
    JSON.stringify(p.action),
    p.category,
    p.rationale,
    JSON.stringify(p.boundaryReasons),
    p.estimatedImpact === undefined ? null : JSON.stringify(p.estimatedImpact),
    JSON.stringify(p.reversalPlan),
    JSON.stringify(p.preconditions),
    p.status,
    p.version,
    p.createdAt,
    p.expiresAt,
    p.decidedBy ?? null,
    p.decidedAt ?? null,
    p.decisionNote ?? null,
    p.executionId ?? null,
    p.executedAt ?? null,
    p.executionResult === undefined ? null : JSON.stringify(p.executionResult),
  ];
}

export class PostgresProposalStore implements ProposalStore {
  constructor(private readonly sql: Sql) {}

  /** Create the table + its indexes if absent. Idempotent; run at startup / in a migration step,
   *  like `PostgresRuntimeStore.migrate()` / `PostgresMerchantRegistry.migrate()`. */
  async migrate(): Promise<void> {
    await this.sql.query(
      `CREATE TABLE IF NOT EXISTS pl_proposal (
         tenant_id text NOT NULL CHECK (btrim(tenant_id) <> ''),
         id text NOT NULL CHECK (btrim(id) <> ''),
         agent_id text NOT NULL,
         agent_type text NOT NULL,
         action jsonb NOT NULL,
         category text NOT NULL CHECK (category IN
           ('discount','ad_spend','refund','campaign','autonomy_scope','subscription')),
         rationale text NOT NULL,
         boundary_reasons jsonb NOT NULL,
         estimated_impact jsonb,
         reversal_plan jsonb NOT NULL,
         preconditions jsonb NOT NULL,
         status text NOT NULL CHECK (status IN
           ('pending','approved','executing','executed','execution_failed','rejected','expired','withdrawn','killed')),
         version integer NOT NULL,
         created_at text NOT NULL,
         expires_at text NOT NULL,
         decided_by text,
         decided_at text,
         decision_note text,
         execution_id text,
         executed_at text,
         execution_result jsonb,
         PRIMARY KEY (tenant_id, id))`,
    );
    await this.sql.query("CREATE INDEX IF NOT EXISTS pl_proposal_status ON pl_proposal (tenant_id, status)");
    await this.sql.query("CREATE INDEX IF NOT EXISTS pl_proposal_category ON pl_proposal (tenant_id, category)");
  }

  async create(proposal: Proposal): Promise<Proposal> {
    requireTenant(proposal.tenantId);
    await this.sql.query(
      `INSERT INTO pl_proposal (${COLUMNS}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
      rowParams(proposal),
    );
    return { ...proposal }; // a copy — callers cannot mutate stored state by reference
  }

  async get(ctx: RuntimeStateCtx, id: string): Promise<Proposal | null> {
    const tenantId = requireTenant(ctx.tenantId);
    const row = await this.selectOne(this.sql, tenantId, id);
    return row ? toProposal(row) : null;
  }

  async list(ctx: RuntimeStateCtx, filter?: ProposalListFilter): Promise<ProposalListResult> {
    const tenantId = requireTenant(ctx.tenantId);
    const params: unknown[] = [tenantId];
    let text = `SELECT ${COLUMNS} FROM pl_proposal WHERE tenant_id = $1`;
    if (filter?.status) {
      params.push(filter.status);
      text += ` AND status = $${params.length}`;
    }
    if (filter?.category) {
      params.push(filter.category);
      text += ` AND category = $${params.length}`;
    }
    text += " ORDER BY created_at ASC, id ASC";
    const { rows } = await this.sql.query<ProposalRow>(text, params);
    return { items: rows.map(toProposal) };
  }

  async transition(
    ctx: RuntimeStateCtx,
    id: string,
    expectedVersion: number,
    patch: ProposalTransitionPatch,
  ): Promise<Proposal> {
    const tenantId = requireTenant(ctx.tenantId);
    return this.sql.tx(async (tx) => {
      const current = await this.selectOne(tx, tenantId, id);
      if (!current) throw new ProposalNotFoundError(id);
      const next: Proposal = { ...toProposal(current), ...patch, id, tenantId, version: current.version + 1 };

      // The CAS: the WHERE clause gates on the CALLER's `expectedVersion`, not the value the SELECT
      // above happened to read — so a writer that raced us between the SELECT and this UPDATE still
      // gets caught here (0 rows affected), not silently overwritten.
      const { rows: updated } = await tx.query<ProposalRow>(
        `UPDATE pl_proposal SET agent_id=$3, agent_type=$4, action=$5, category=$6, rationale=$7,
                boundary_reasons=$8, estimated_impact=$9, reversal_plan=$10, preconditions=$11, status=$12,
                version=$13, created_at=$14, expires_at=$15, decided_by=$16, decided_at=$17,
                decision_note=$18, execution_id=$19, executed_at=$20, execution_result=$21
           WHERE tenant_id=$1 AND id=$2 AND version=$22
           RETURNING ${COLUMNS}`,
        [...rowParams(next).slice(0, 21), expectedVersion],
      );
      const row = updated[0];
      if (!row) {
        // 0 rows affected: either the row moved on since our SELECT (a genuine race), or the caller
        // passed a stale `expectedVersion`. Either way, report the ACTUAL current version so the
        // caller can re-read and retry rather than guessing.
        const latest = await this.selectOne(tx, tenantId, id);
        if (!latest) throw new ProposalNotFoundError(id);
        throw new VersionConflictError(id, expectedVersion, latest.version);
      }
      return toProposal(row);
    });
  }

  private async selectOne(sql: Sql, tenantId: string, id: string): Promise<ProposalRow | null> {
    const { rows } = await sql.query<ProposalRow>(
      `SELECT ${COLUMNS} FROM pl_proposal WHERE tenant_id=$1 AND id=$2`,
      [tenantId, id],
    );
    return rows[0] ?? null;
  }
}
