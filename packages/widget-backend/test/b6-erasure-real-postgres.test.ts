import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { pgPoolSqlFromUrl, PgPoolSql, PostgresVectorStore, PostgresRuntimeStore } from "@palup/state-postgres";
import { eraseSubject, subjectNamespace } from "@palup/widget-memory";

// B6 (docs/MEMORY-GO-LIVE-CHECKLIST.md §B) — "Erasure completeness re-confirmed against the real adapter.
// Inv 5 is adapter-dependent; only the in-memory oracle and pglite are proven today."
//
// WHY PGLITE WAS NOT ENOUGH, stated precisely rather than as a vibe. `postgres-vector-store.test.ts`
// argues pglite "genuinely exercises the SQL, not a mock", and that is true — it IS Postgres compiled to
// WASM. What it does NOT exercise is everything between this code and a Postgres SERVER: the `pg` driver,
// the wire protocol, connection POOLING, and server-side transaction/visibility behaviour. Production
// erasure runs through `pgPoolSqlFromUrl` (vector-factory.ts) — a `pg.Pool` over TCP. pglite bypasses that
// entire layer by running in-process. So an erasure that "works" under pglite could still, in principle,
// fail or partially apply against a pooled server. This file closes that gap by running the SAME erasure
// path through the SAME production constructor against a real Postgres 16 server.
//
// WHAT IT PROVES BEYOND "the port says it's empty": it queries `vp_records` DIRECTLY, so a logical hide
// (soft-delete, a filtered read path) cannot pass. Erasure must be PHYSICAL — that is what Inv 5 means and
// what a GDPR erasure request actually requires.
//
// HOW TO RUN. This is skipped unless `B6_DATABASE_URL` is set, so CI stays deterministic and needs no
// database service. To reproduce:
//   docker run -d --name palup-b6-pg -e POSTGRES_PASSWORD=b6proof -e POSTGRES_DB=b6 -p 55432:5432 postgres:16
//   B6_DATABASE_URL='postgres://postgres:b6proof@127.0.0.1:55432/b6' npx vitest run \
//     packages/widget-backend/test/b6-erasure-real-postgres.test.ts
// Cloud SQL `palup-staging` is POSTGRES_16, the same major version.

const URL = process.env.B6_DATABASE_URL;
const TENANT = "b6-tenant";
const SUBJECT = "b6-subject-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BYSTANDER = "b6-subject-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

// `describe.skipIf` rather than a silent early return: a proof that quietly does nothing is the failure
// mode this whole checklist exists to catch.
describe.skipIf(!URL)("B6 — erasure is PHYSICAL against a real Postgres server, not just pglite", () => {
  let sql: PgPoolSql;
  let vector: PostgresVectorStore;
  let audit: PostgresRuntimeStore;

  beforeAll(async () => {
    sql = pgPoolSqlFromUrl(URL as string); // the production constructor, pg.Pool over TCP
    vector = new PostgresVectorStore(sql);
    audit = new PostgresRuntimeStore(sql);
    await vector.migrate();
    await audit.migrate();
    // Start from a known-clean namespace so a previous run cannot make this pass.
    await vector.deleteNamespace(subjectNamespace(TENANT, SUBJECT));
    await vector.deleteNamespace(subjectNamespace(TENANT, BYSTANDER));
  });

  afterAll(async () => {
    await vector.deleteNamespace(subjectNamespace(TENANT, SUBJECT));
    await vector.deleteNamespace(subjectNamespace(TENANT, BYSTANDER));
    // PgPoolSql exposes only query/tx — no end(); the pool closes with the process.
  });

  /** Rows physically present for a namespace, read straight from the table the adapter writes. */
  const rawCount = async (ns: string): Promise<number> => {
    const r = await sql.query<{ n: string }>("SELECT count(*)::text AS n FROM vp_records WHERE namespace=$1", [ns]);
    return Number(r.rows[0]?.n ?? "-1");
  };

  it("the fixture is real: facts land physically in vp_records over the wire", async () => {
    const ns = subjectNamespace(TENANT, SUBJECT);
    await vector.upsert(ns, [
      { id: "f1", text: "prefers fragrance-free", metadata: { class: "ordinary" } },
      { id: "f2", text: "sensitive skin", metadata: { class: "special" } },
    ]);
    await vector.upsert(subjectNamespace(TENANT, BYSTANDER), [
      { id: "f1", text: "likes the barrier cream", metadata: { class: "ordinary" } },
    ]);
    // If this is 0 the rest of the file would pass vacuously — an erasure of nothing.
    expect(await rawCount(ns), "no rows were written, so erasing them proves nothing").toBe(2);
  });

  it("eraseSubject removes every row PHYSICALLY — checked in the table, not through the port", async () => {
    const ns = subjectNamespace(TENANT, SUBJECT);
    await eraseSubject({ vector, audit, hmacKey: "b6-proof-key" }, { tenantId: TENANT, anonId: SUBJECT });
    expect(await rawCount(ns), "rows survive in vp_records — this is a logical hide, not an erasure").toBe(0);
    expect(await vector.query(ns, { vector: [], k: 50 })).toEqual([]);
  });

  it("a SECOND adapter instance over the same server also sees nothing (erasure is durable, not per-process)", async () => {
    const other = new PostgresVectorStore(pgPoolSqlFromUrl(URL as string));
    try {
      expect(await other.query(subjectNamespace(TENANT, SUBJECT), { vector: [], k: 50 })).toEqual([]);
    } finally {
      // no-op: the pool is closed with the process; asserting is the point
    }
  });

  it("erasure is SCOPED — a bystander subject in the same tenant is untouched", async () => {
    expect(await rawCount(subjectNamespace(TENANT, BYSTANDER))).toBe(1);
  });

  it("the erase.subject audit row is durably recorded on the real server", async () => {
    const entries = await audit.readAudit({ tenantId: TENANT }, { limit: 50 });
    const erasures = entries.filter((e) => (e as { action?: string }).action === "erase.subject");
    expect(erasures.length, "no erase.subject audit landed — a destructive action must never be invisible").toBeGreaterThan(0);
  });
});
