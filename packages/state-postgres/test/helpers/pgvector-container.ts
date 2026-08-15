import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { pgPoolSqlFromUrl, type PgPoolSql, type Sql } from "../../src/sql.js";

// Docker reachability: the merge-gate sets PGVECTOR_TESTCONTAINER unset (⇒ required);
// a dev without Docker may set PGVECTOR_TESTCONTAINER=off to skip locally.
export const PGVECTOR_AVAILABLE = process.env.PGVECTOR_TESTCONTAINER !== "off";

// Reusable started-container helper: the ONE place that boots pgvector/pgvector:pg16 with the
// readiness wait strategy. Both `withPgvector` (per-`it` container) and any test that needs a
// single shared container across multiple `it`s (e.g. pgvector-store.contract.test.ts's
// beforeAll/afterAll) should go through this, so the readiness fix can't be duplicated —
// and drift — into an unguarded inline boot again.
export async function startPgvectorContainer(): Promise<{ sql: Sql; stop: () => Promise<void> }> {
  const container: StartedTestContainer = await new GenericContainer("pgvector/pgvector:pg16")
    .withEnvironment({ POSTGRES_PASSWORD: "test", POSTGRES_DB: "palup" })
    .withExposedPorts(5432)
    // The container reports "started" before Postgres accepts connections, causing an
    // intermittent "the database system is starting up" error. The pg image logs
    // "database system is ready to accept connections" TWICE on a fresh init: once for the
    // initdb bootstrap server (which then shuts down and restarts), once for the final
    // server. Waiting for the 2nd occurrence avoids racing the init-then-restart cycle.
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
  const url = `postgres://postgres:test@${container.getHost()}:${container.getMappedPort(5432)}/palup`;
  const sql: PgPoolSql = pgPoolSqlFromUrl(url);
  const stop = async () => {
    // End the pool BEFORE stopping the container: otherwise the container's shutdown kills
    // still-open (idle) pool connections server-side, and node-postgres's pg.Pool has no
    // built-in "error" listener on those idle clients — the resulting "terminating connection
    // due to administrator command" surfaces as an unhandled rejection that fails the whole
    // vitest run (verified: exit code 1 despite the test itself passing). Closing here first
    // lets the pool shut down its clients gracefully while Postgres is still up.
    await (sql as unknown as { pool: { end(): Promise<void> } }).pool.end().catch(() => {});
    await container.stop();
  };
  return { sql, stop };
}

export async function withPgvector(fn: (sql: Sql) => Promise<void>): Promise<void> {
  const { sql, stop } = await startPgvectorContainer();
  try {
    await fn(sql);
  } finally {
    await stop();
  }
}
