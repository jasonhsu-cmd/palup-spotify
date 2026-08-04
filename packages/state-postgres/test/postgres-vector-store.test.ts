import { describe, it, expect } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { runVectorPortContract } from "@palup/platform-ports/contract/vector";
import { PostgresVectorStore } from "../src/postgres-vector-store.js";
import type { Sql } from "../src/sql.js";

// Go-live blocker #1: durable, portable VectorPort adapter. Verified against a REAL Postgres engine
// (pglite = Postgres compiled to WASM, in-process, no server/Docker) — same SQL dialect as Cloud SQL /
// Spanner-pg (ADR-0004), so this genuinely exercises the SQL, not a mock. Mirrors
// postgres-runtime-store.test.ts's own pglite precedent.

function pgliteSql(db: PGlite): Sql {
  const wrap = (runner: { query: (t: string, p?: unknown[]) => Promise<{ rows: unknown[] }> }): Sql => ({
    query: async <R = Record<string, unknown>>(text: string, params: unknown[] = []) => {
      const r = await runner.query(text, params);
      return { rows: r.rows as R[] };
    },
    tx: () => {
      throw new Error("nested transactions are not supported");
    },
  });
  return {
    query: wrap(db).query,
    tx: (fn) => db.transaction(async (txCtx) => fn(wrap(txCtx))),
  };
}

async function makePgAdapter(): Promise<PostgresVectorStore> {
  const store = new PostgresVectorStore(pgliteSql(new PGlite()));
  await store.migrate();
  return store;
}

// The adapter must pass the SAME contract as the in-memory reference — behavior-equivalence (ADR-0001).
runVectorPortContract(makePgAdapter);

describe("PostgresVectorStore — durability across instances (ADR-0015 Inv 5: erasure must be REAL)", () => {
  it("data written by one port instance is readable by a SECOND instance over the same DB", async () => {
    const db = new PGlite();
    const store1 = new PostgresVectorStore(pgliteSql(db));
    await store1.migrate();
    await store1.upsert("tenant-a", [{ id: "fact-1", text: "likes wool socks", metadata: { class: "ordinary" } }]);

    // A second adapter instance over the SAME underlying database stands in for a second Cloud Run
    // instance/process pointed at the same Cloud SQL via DATABASE_URL (unlike the in-memory adapter,
    // which is per-process and would NOT share this data).
    const store2 = new PostgresVectorStore(pgliteSql(db));
    const hits = await store2.query("tenant-a", { text: "", k: 10 });
    expect(hits.map((h) => h.id)).toEqual(["fact-1"]);
    expect(hits[0].metadata).toEqual({ class: "ordinary" });
  });

  it("ERASURE COMPLETENESS: deleteNamespace on one instance is genuinely gone — proven via a FRESH " +
      "instance over the SAME db (survives an instance restart, unlike the in-memory adapter)", async () => {
    const db = new PGlite();
    const writer = new PostgresVectorStore(pgliteSql(db));
    await writer.migrate();
    await writer.upsert("gdpr-subject", [
      { id: "f1", text: "fact one", metadata: { class: "ordinary" } },
      { id: "f2", text: "fact two", metadata: { class: "special" } },
    ]);
    await writer.deleteNamespace("gdpr-subject");

    // A brand-new adapter instance — no shared in-process state with `writer` at all — querying the
    // SAME durable database. If erasure were only in-process (as the in-memory adapter's map-delete
    // would be), a fresh instance reading the same physical store would still be able to disprove that;
    // here it must see nothing, proving the delete reached the durable store itself.
    const freshInstance = new PostgresVectorStore(pgliteSql(db));
    expect(await freshInstance.query("gdpr-subject", { text: "", k: 500 })).toEqual([]);
  });

  it("deleteById erasure is also durable across a fresh instance", async () => {
    const db = new PGlite();
    const writer = new PostgresVectorStore(pgliteSql(db));
    await writer.migrate();
    await writer.upsert("subj", [
      { id: "keep", text: "keep me", metadata: {} },
      { id: "erase-me", text: "erase me", metadata: {} },
    ]);
    await writer.deleteById("subj", ["erase-me"]);

    const freshInstance = new PostgresVectorStore(pgliteSql(db));
    const remaining = await freshInstance.query("subj", { text: "", k: 500 });
    expect(remaining.map((h) => h.id)).toEqual(["keep"]);
  });

  it("migrate() is idempotent — calling it again on an already-migrated db does not error or lose data", async () => {
    const db = new PGlite();
    const store = new PostgresVectorStore(pgliteSql(db));
    await store.migrate();
    await store.upsert("t", [{ id: "a", text: "x", metadata: {} }]);
    await store.migrate(); // re-run, as would happen on every process boot
    expect((await store.query("t", { text: "", k: 10 })).map((h) => h.id)).toEqual(["a"]);
  });
});
