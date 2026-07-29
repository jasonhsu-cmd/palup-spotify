import pg from "pg";

// A minimal SQL executor the PostgresRuntimeStore depends on, so the SAME adapter runs on node-postgres
// (Cloud SQL / Spanner-pg / Yugabyte in prod) and on an in-process engine (pglite) in tests — the
// adapter never imports a concrete driver. `tx` runs fn in one SERIALIZABLE transaction: commit on
// success, rollback on throw. Isolation is SERIALIZABLE so concurrent same-tenant writes can't lose
// updates (a serialization failure surfaces as an error to retry, never silent corruption).

export interface Sql {
  query<R = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: R[] }>;
  tx<T>(fn: (t: Sql) => Promise<T>): Promise<T>;
}

/** Production executor over a node-postgres Pool. */
export class PgPoolSql implements Sql {
  constructor(private readonly pool: pg.Pool) {}

  async query<R = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<{ rows: R[] }> {
    const res = await this.pool.query(text, params as unknown[]);
    return { rows: res.rows as R[] };
  }

  async tx<T>(fn: (t: Sql) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    const scoped: Sql = {
      query: async <R = Record<string, unknown>>(t: string, p: unknown[] = []) => {
        const res = await client.query(t, p as unknown[]);
        return { rows: res.rows as R[] };
      },
      tx: () => {
        throw new Error("nested transactions are not supported");
      },
    };
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      const out = await fn(scoped);
      await client.query("COMMIT");
      return out;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }
}

/** Build a PgPoolSql from a connection string (e.g. Cloud SQL). Bounded so a hung/slow DB can't stall
 * the serving path — node-postgres has NO default query timeout, and /chat awaits a per-request store
 * read (incl. the kill-switch check), so an unbounded query would hang the request. */
export function pgPoolSqlFromUrl(connectionString: string): PgPoolSql {
  return new PgPoolSql(
    new pg.Pool({
      connectionString,
      max: Number(process.env.PG_POOL_MAX ?? 10),
      connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS ?? 5000),
      statement_timeout: Number(process.env.PG_STATEMENT_TIMEOUT_MS ?? 10000),
      query_timeout: Number(process.env.PG_QUERY_TIMEOUT_MS ?? 10000),
      idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS ?? 30000),
    }),
  );
}
