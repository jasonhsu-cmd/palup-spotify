import { describe, it, expect } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { runStoreProfilePortContract } from "@palup/platform-ports/contract/store-profile";
import { PostgresStoreProfileStore } from "../src/postgres-store-profile-store.js";
import type { Sql } from "../src/sql.js";

// Durable, portable StoreProfilePort adapter (ADR-0001; credential-enrollment-unification Task 2).
// Verified against a REAL Postgres engine (pglite = Postgres compiled to WASM, in-process) — same SQL
// dialect as Cloud SQL / Spanner-pg (ADR-0004). Mirrors postgres-product-facts-store.test.ts's pglite
// harness.
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

async function makePgAdapter(): Promise<PostgresStoreProfileStore> {
  const store = new PostgresStoreProfileStore(pgliteSql(new PGlite()));
  await store.migrate();
  return store;
}

// Must pass the SAME contract as the in-memory reference — behavior-equivalence (ADR-0001).
runStoreProfilePortContract(makePgAdapter);

describe("PostgresStoreProfileStore — durability across instances", () => {
  it("a profile written by one instance is readable by a SECOND over the same DB", async () => {
    const db = new PGlite();
    const s1 = new PostgresStoreProfileStore(pgliteSql(db));
    await s1.migrate();
    await s1.put("t", { brandName: "Acme", policy: { returns: "30-day", shipping: "2-3 days" } });
    const s2 = new PostgresStoreProfileStore(pgliteSql(db));
    expect(await s2.get("t")).toEqual({ brandName: "Acme", policy: { returns: "30-day", shipping: "2-3 days" } });
  });

  it("migrate() is idempotent — calling it twice does not error", async () => {
    const store = new PostgresStoreProfileStore(pgliteSql(new PGlite()));
    await store.migrate();
    await expect(store.migrate()).resolves.toBeUndefined();
  });
});
