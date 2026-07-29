import {
  AUDIT_GENESIS_HASH,
  hashAuditBase,
  type AuditInput,
  type AuditRecord,
  type PutOpts,
  type RuntimeStateCtx,
  type RuntimeStatePort,
  type RuntimeStateTx,
} from "@palup/platform-ports";
import type { Sql } from "./sql.js";

// Postgres adapter for RuntimeStatePort (ADR-0004: Cloud SQL now; Spanner-pg / YugabyteDB at scale —
// all reached through the standard Postgres dialect behind this port). Tenant isolation is enforced by
// a `tenant_id` predicate on EVERY statement (production SHOULD additionally enable row-level security
// as defense-in-depth — see migrate()). The Audit Log is INSERT-only: this adapter issues no UPDATE or
// DELETE against rs_audit, and the audit hash is computed with the shared hashAuditBase so a chain is
// byte-identical to the in-memory adapter's and verifiable across engines.

function requireTenant(tenantId: string): string {
  if (!tenantId || !tenantId.trim())
    throw new Error("RuntimeStatePort: a non-blank tenantId is required (tenant isolation)");
  return tenantId;
}

/** Reconstruct the exact base object that was hashed (SQL NULL → undefined so canonicalization matches). */
function baseFromRow(r: Record<string, unknown>): Omit<AuditRecord, "hash"> {
  return {
    seq: Number(r.seq),
    at: String(r.at),
    actor: String(r.actor),
    action: String(r.action),
    input: r.input == null ? undefined : r.input,
    decision: r.decision == null ? undefined : r.decision,
    reversalPath: r.reversal_path == null ? undefined : String(r.reversal_path),
    prevHash: String(r.prev_hash),
  };
}

export class PostgresRuntimeStore implements RuntimeStatePort {
  constructor(private readonly sql: Sql) {}

  /** Create tables if absent. Idempotent; run at startup / in a migration step. */
  async migrate(): Promise<void> {
    // One statement per call so it works on both node-postgres and the in-process test engine.
    await this.sql.query(
      `CREATE TABLE IF NOT EXISTS rs_kv (
         tenant_id text NOT NULL, collection text NOT NULL, key text NOT NULL, value jsonb NOT NULL,
         PRIMARY KEY (tenant_id, collection, key))`,
    );
    // TTL support (F4) — additive, so it upgrades an already-created rs_kv on redeploy.
    await this.sql.query("ALTER TABLE rs_kv ADD COLUMN IF NOT EXISTS expires_at timestamptz");
    await this.sql.query("CREATE INDEX IF NOT EXISTS rs_kv_expires ON rs_kv (expires_at) WHERE expires_at IS NOT NULL");
    await this.sql.query(
      `CREATE TABLE IF NOT EXISTS rs_stream (
         seq bigserial PRIMARY KEY, tenant_id text NOT NULL, stream text NOT NULL, entry jsonb NOT NULL)`,
    );
    await this.sql.query("CREATE INDEX IF NOT EXISTS rs_stream_ord ON rs_stream (tenant_id, stream, seq)");
    await this.sql.query(
      `CREATE TABLE IF NOT EXISTS rs_audit (
         tenant_id text NOT NULL, seq bigint NOT NULL, at text NOT NULL, actor text NOT NULL,
         action text NOT NULL, input jsonb, decision jsonb, reversal_path text,
         prev_hash text NOT NULL, hash text NOT NULL, PRIMARY KEY (tenant_id, seq))`,
    );
    // NN #5 immutability: the app role must have INSERT/SELECT on rs_audit but NO UPDATE/DELETE.
    // That GRANT is an infra/migration concern (documented in the port trust assumption), enforced at
    // deploy — this adapter itself never issues UPDATE/DELETE against rs_audit.
  }

  async get<T>(ctx: RuntimeStateCtx, collection: string, key: string): Promise<T | null> {
    const t = requireTenant(ctx.tenantId);
    const { rows } = await this.sql.query<{ value: T }>(
      "SELECT value FROM rs_kv WHERE tenant_id=$1 AND collection=$2 AND key=$3 AND (expires_at IS NULL OR expires_at > now())",
      [t, collection, key],
    );
    return rows.length ? rows[0].value : null;
  }

  async put<T>(ctx: RuntimeStateCtx, collection: string, key: string, value: T, opts?: PutOpts): Promise<void> {
    await this.putVia(this.sql, requireTenant(ctx.tenantId), collection, key, value, opts);
  }

  private async putVia<T>(sql: Sql, tenantId: string, collection: string, key: string, value: T, opts?: PutOpts): Promise<void> {
    // expires_at computed on the DB clock (avoids app/db skew); NULL = never expires.
    await sql.query(
      `INSERT INTO rs_kv (tenant_id, collection, key, value, expires_at)
       VALUES ($1,$2,$3,$4, CASE WHEN $5::int IS NULL THEN NULL ELSE now() + ($5::int * interval '1 second') END)
       ON CONFLICT (tenant_id, collection, key) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at`,
      [tenantId, collection, key, JSON.stringify(value), opts?.ttlSeconds ?? null],
    );
  }

  async delete(ctx: RuntimeStateCtx, collection: string, key: string): Promise<void> {
    const t = requireTenant(ctx.tenantId);
    await this.sql.query("DELETE FROM rs_kv WHERE tenant_id=$1 AND collection=$2 AND key=$3", [t, collection, key]);
  }

  async list<T>(ctx: RuntimeStateCtx, collection: string): Promise<Array<{ key: string; value: T }>> {
    const t = requireTenant(ctx.tenantId);
    const { rows } = await this.sql.query<{ key: string; value: T }>(
      "SELECT key, value FROM rs_kv WHERE tenant_id=$1 AND collection=$2 AND (expires_at IS NULL OR expires_at > now()) ORDER BY key",
      [t, collection],
    );
    return rows.map((r) => ({ key: r.key, value: r.value }));
  }

  async sweepExpired(): Promise<number> {
    const { rows } = await this.sql.query<{ n: string }>(
      "WITH d AS (DELETE FROM rs_kv WHERE expires_at IS NOT NULL AND expires_at <= now() RETURNING 1) SELECT count(*)::text AS n FROM d",
    );
    return Number(rows[0].n);
  }

  async trimStream(ctx: RuntimeStateCtx, stream: string, keepLast: number): Promise<number> {
    const t = requireTenant(ctx.tenantId);
    const { rows } = await this.sql.query<{ n: string }>(
      `WITH keep AS (SELECT seq FROM rs_stream WHERE tenant_id=$1 AND stream=$2 ORDER BY seq DESC LIMIT $3),
            d AS (DELETE FROM rs_stream WHERE tenant_id=$1 AND stream=$2 AND seq NOT IN (SELECT seq FROM keep) RETURNING 1)
       SELECT count(*)::text AS n FROM d`,
      [t, stream, Math.max(0, keepLast)],
    );
    return Number(rows[0].n);
  }

  private async appendVia<T>(sql: Sql, tenantId: string, stream: string, entry: T): Promise<number> {
    // O(1): return the row's global bigserial `seq` (a monotonic cursor) via RETURNING — NOT a
    // count(*) over the whole stream per append (which was O(n) on the hot traffic path, F5). The
    // returned value is a strictly-increasing cursor, not a stable per-stream length.
    const { rows } = await sql.query<{ seq: string }>(
      "INSERT INTO rs_stream (tenant_id, stream, entry) VALUES ($1,$2,$3) RETURNING seq",
      [tenantId, stream, JSON.stringify(entry)],
    );
    return Number(rows[0].seq);
  }

  async append<T>(ctx: RuntimeStateCtx, stream: string, entry: T): Promise<number> {
    return this.appendVia(this.sql, requireTenant(ctx.tenantId), stream, entry);
  }

  async readStream<T>(ctx: RuntimeStateCtx, stream: string, opts?: { limit?: number }): Promise<T[]> {
    const t = requireTenant(ctx.tenantId);
    if (opts?.limit != null) {
      const { rows } = await this.sql.query<{ entry: T }>(
        "SELECT entry FROM rs_stream WHERE tenant_id=$1 AND stream=$2 ORDER BY seq DESC LIMIT $3",
        [t, stream, opts.limit],
      );
      return rows.map((r) => r.entry).reverse();
    }
    const { rows } = await this.sql.query<{ entry: T }>(
      "SELECT entry FROM rs_stream WHERE tenant_id=$1 AND stream=$2 ORDER BY seq ASC",
      [t, stream],
    );
    return rows.map((r) => r.entry);
  }

  /** Compute seq + prevHash + hash and INSERT one audit record. MUST run inside a transaction. */
  private async commitAudit(sql: Sql, tenantId: string, entry: AuditInput, at: string): Promise<AuditRecord> {
    const { rows } = await sql.query<{ seq: string; hash: string }>(
      "SELECT seq, hash FROM rs_audit WHERE tenant_id=$1 ORDER BY seq DESC LIMIT 1",
      [tenantId],
    );
    const prevHash = rows.length ? rows[0].hash : AUDIT_GENESIS_HASH;
    const seq = (rows.length ? Number(rows[0].seq) : 0) + 1;
    const base: Omit<AuditRecord, "hash"> = {
      seq,
      at,
      actor: entry.actor,
      action: entry.action,
      input: entry.input,
      decision: entry.decision,
      reversalPath: entry.reversalPath,
      prevHash,
    };
    const hash = hashAuditBase(base);
    await sql.query(
      `INSERT INTO rs_audit (tenant_id, seq, at, actor, action, input, decision, reversal_path, prev_hash, hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        tenantId,
        seq,
        at,
        entry.actor,
        entry.action,
        entry.input === undefined ? null : JSON.stringify(entry.input),
        entry.decision === undefined ? null : JSON.stringify(entry.decision),
        entry.reversalPath ?? null,
        prevHash,
        hash,
      ],
    );
    return { ...base, hash };
  }

  async audit(ctx: RuntimeStateCtx, entry: AuditInput, at = new Date().toISOString()): Promise<AuditRecord> {
    const t = requireTenant(ctx.tenantId);
    return this.sql.tx((tx) => this.commitAudit(tx, t, entry, at));
  }

  async readAudit(ctx: RuntimeStateCtx, opts?: { limit?: number }): Promise<AuditRecord[]> {
    const t = requireTenant(ctx.tenantId);
    const base = "SELECT * FROM rs_audit WHERE tenant_id=$1 ORDER BY seq";
    const { rows } =
      opts?.limit != null
        ? await this.sql.query<Record<string, unknown>>(`${base} DESC LIMIT $2`, [t, opts.limit])
        : await this.sql.query<Record<string, unknown>>(`${base} ASC`, [t]);
    const recs = rows.map((r) => ({ ...baseFromRow(r), hash: String(r.hash) }));
    return opts?.limit != null ? recs.reverse() : recs;
  }

  async verifyAudit(
    ctx: RuntimeStateCtx,
    opts?: { expectedHead?: { seq: number; hash: string } },
  ): Promise<{ ok: boolean; brokenAt?: number }> {
    const t = requireTenant(ctx.tenantId);
    const { rows } = await this.sql.query<Record<string, unknown>>(
      "SELECT * FROM rs_audit WHERE tenant_id=$1 ORDER BY seq ASC",
      [t],
    );
    let prev = AUDIT_GENESIS_HASH;
    for (const r of rows) {
      const base = baseFromRow(r);
      if (base.prevHash !== prev || hashAuditBase(base) !== String(r.hash))
        return { ok: false, brokenAt: base.seq };
      prev = String(r.hash);
    }
    if (opts?.expectedHead) {
      const head = rows[rows.length - 1];
      if (!head || Number(head.seq) !== opts.expectedHead.seq || String(head.hash) !== opts.expectedHead.hash)
        return { ok: false, brokenAt: opts.expectedHead.seq };
    }
    return { ok: true };
  }

  async tx<T>(ctx: RuntimeStateCtx, fn: (t: RuntimeStateTx) => Promise<T>): Promise<T> {
    const t = requireTenant(ctx.tenantId);
    return this.sql.tx(async (txSql) => {
      const handle: RuntimeStateTx = {
        get: async <T2>(collection: string, key: string) => {
          const { rows } = await txSql.query<{ value: T2 }>(
            "SELECT value FROM rs_kv WHERE tenant_id=$1 AND collection=$2 AND key=$3",
            [t, collection, key],
          );
          return rows.length ? rows[0].value : null;
        },
        put: (collection, key, value, opts) => this.putVia(txSql, t, collection, key, value, opts),
        delete: async (collection, key) => {
          await txSql.query("DELETE FROM rs_kv WHERE tenant_id=$1 AND collection=$2 AND key=$3", [t, collection, key]);
        },
        append: (stream, entry) => this.appendVia(txSql, t, stream, entry),
        audit: (entry, at = new Date().toISOString()) => this.commitAudit(txSql, t, entry, at),
      };
      return fn(handle);
    });
  }
}
