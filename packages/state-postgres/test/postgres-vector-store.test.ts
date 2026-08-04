import { describe, it, expect } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { runVectorPortContract } from "@palup/platform-ports/contract/vector";
import { PostgresVectorStore } from "../src/postgres-vector-store.js";
import type { Sql } from "../src/sql.js";

// Durable, portable VectorPort adapter (ADR-0001 `vector` port; ADR-0015 durable cross-visit memory).
// Verified against a REAL Postgres engine (pglite = Postgres compiled to WASM, in-process, no
// server/Docker) — same SQL dialect as Cloud SQL / Spanner-pg (ADR-0004), so this genuinely exercises the
// SQL, not a mock. Mirrors postgres-runtime-store.test.ts's own pglite precedent.

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
      "instance over the SAME underlying db (proves erasure reached the durable engine itself, not just " +
      "an in-process cache — NOT a claim of surviving a process/instance restart, since pglite's db dies " +
      "with the object; the in-memory adapter, by contrast, COULD NOT pass this at all)", async () => {
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

// Security review, HIGH — "no tenant column / RLS not expressible". `tenant_id` is a REAL, adapter-
// populated column (derived from the opaque `${tenantId}::${anonId}` namespace, always a BOUND
// parameter) so a defense-in-depth RLS policy is expressible without a later migration.
describe("PostgresVectorStore — tenant_id column (RLS defense-in-depth)", () => {
  it("populates tenant_id from the namespace's tenantId component on upsert", async () => {
    const db = new PGlite();
    const store = new PostgresVectorStore(pgliteSql(db));
    await store.migrate();
    await store.upsert("acme-corp::guest-123", [{ id: "f1", text: "likes wool socks", metadata: {} }]);

    const { rows } = await db.query<{ tenant_id: string }>(
      "SELECT tenant_id FROM vp_records WHERE namespace=$1 AND id=$2",
      ["acme-corp::guest-123", "f1"],
    );
    expect(rows[0]?.tenant_id).toBe("acme-corp");
  });

  it("falls back to the whole namespace as tenant_id when it carries no '::' separator (generic " +
      "VectorPort callers outside widget-memory's Option B scheme)", async () => {
    const db = new PGlite();
    const store = new PostgresVectorStore(pgliteSql(db));
    await store.migrate();
    await store.upsert("plain-namespace", [{ id: "f1", text: "x", metadata: {} }]);

    const { rows } = await db.query<{ tenant_id: string }>(
      "SELECT tenant_id FROM vp_records WHERE namespace=$1 AND id=$2",
      ["plain-namespace", "f1"],
    );
    expect(rows[0]?.tenant_id).toBe("plain-namespace");
  });
});

// Security review, MEDIUM — "non-transactional batch upsert leaves partial, unaudited writes". A
// mid-batch failure (here: a NUL byte platform-ports' requireCleanText rejects) must leave EITHER every
// record in the batch persisted or NONE of them — never a partial set, which service.ts would never
// audit (it only audits AFTER upsert resolves).
describe("PostgresVectorStore — transactional batch upsert (all-or-nothing)", () => {
  it("a mid-batch failure persists NEITHER the earlier-nor-later records in the same upsert() call", async () => {
    const db = new PGlite();
    const store = new PostgresVectorStore(pgliteSql(db));
    await store.migrate();
    const nul = String.fromCharCode(0);

    await expect(
      store.upsert("subj", [
        { id: "good", text: "a fine fact", metadata: {} },
        { id: "bad", text: `contains${nul}a nul byte`, metadata: {} },
        { id: "third", text: "never reached", metadata: {} },
      ]),
    ).rejects.toThrow();

    const remaining = await store.query("subj", { text: "", k: 10 });
    expect(remaining).toEqual([]); // NEITHER "good" nor "third" landed — all-or-nothing
  });

  it("a fully-clean batch still commits every record together", async () => {
    const db = new PGlite();
    const store = new PostgresVectorStore(pgliteSql(db));
    await store.migrate();
    await store.upsert("subj", [
      { id: "a", text: "fact a", metadata: {} },
      { id: "b", text: "fact b", metadata: {} },
    ]);
    const remaining = await store.query("subj", { text: "", k: 10 });
    expect(remaining.map((h) => h.id).sort()).toEqual(["a", "b"]);
  });
});

// Security review, MEDIUM — "unbounded per-namespace SELECT ... sweepExpired has NO production caller".
// A hard SQL row cap bounds the worst case even if a namespace is never swept. Injected small here so the
// test doesn't need thousands of rows.
describe("PostgresVectorStore — bounded scan (query never does an unbounded per-namespace SELECT)", () => {
  it("truncates to at most `maxScanRows`, deterministically (stable id order)", async () => {
    const db = new PGlite();
    const store = new PostgresVectorStore(pgliteSql(db), /* maxScanRows */ 3);
    await store.migrate();
    await store.upsert("subj", [
      { id: "e", text: "", metadata: {} },
      { id: "c", text: "", metadata: {} },
      { id: "a", text: "", metadata: {} },
      { id: "d", text: "", metadata: {} },
      { id: "b", text: "", metadata: {} },
    ]);
    // k=10 asks for more than exist, but the SQL-level cap (3) is what actually bounds the scan.
    const hits = await store.query("subj", { text: "", k: 10 });
    expect(hits.map((h) => h.id)).toEqual(["a", "b", "c"]); // first 3 by id, not insertion order
  });
});
