import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { pgPoolSqlFromUrl, type PgPoolSql, type Sql } from "../../src/sql.js";

// Docker reachability: the merge-gate sets PGVECTOR_TESTCONTAINER unset (⇒ required);
// a dev without Docker may set PGVECTOR_TESTCONTAINER=off to skip locally.
export const PGVECTOR_AVAILABLE = process.env.PGVECTOR_TESTCONTAINER !== "off";

export async function withPgvector(fn: (sql: Sql) => Promise<void>): Promise<void> {
  let container: StartedTestContainer | undefined;
  let sql: PgPoolSql | undefined;
  try {
    container = await new GenericContainer("pgvector/pgvector:pg16")
      .withEnvironment({ POSTGRES_PASSWORD: "test", POSTGRES_DB: "palup" })
      .withExposedPorts(5432)
      .start();
    const url = `postgres://postgres:test@${container.getHost()}:${container.getMappedPort(5432)}/palup`;
    sql = pgPoolSqlFromUrl(url);
    await fn(sql);
  } finally {
    // End the pool BEFORE stopping the container: otherwise the container's shutdown kills
    // still-open (idle) pool connections server-side, and node-postgres's pg.Pool has no
    // built-in "error" listener on those idle clients — the resulting "terminating connection
    // due to administrator command" surfaces as an unhandled rejection that fails the whole
    // vitest run (verified: exit code 1 despite the test itself passing). Closing here first
    // lets the pool shut down its clients gracefully while Postgres is still up.
    await (sql as unknown as { pool: { end(): Promise<void> } } | undefined)?.pool
      .end()
      .catch(() => {});
    await container?.stop();
  }
}
