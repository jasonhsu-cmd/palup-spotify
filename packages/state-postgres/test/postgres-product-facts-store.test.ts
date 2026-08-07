import { describe, it, expect } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { runProductFactsPortContract } from "@palup/platform-ports/contract/product-facts";
import { PostgresProductFactsStore } from "../src/postgres-product-facts-store.js";
import type { Sql } from "../src/sql.js";

// Durable, portable ProductFactsPort adapter (ADR-0001; ADR-0020 D2). Verified against a REAL Postgres
// engine (pglite = Postgres compiled to WASM, in-process) — same SQL dialect as Cloud SQL / Spanner-pg
// (ADR-0004). Mirrors postgres-vector-store.test.ts's pglite harness.
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

async function makePgAdapter(): Promise<PostgresProductFactsStore> {
  const store = new PostgresProductFactsStore(pgliteSql(new PGlite()));
  await store.migrate();
  return store;
}

// Must pass the SAME contract as the in-memory reference — behavior-equivalence (ADR-0001).
runProductFactsPortContract(makePgAdapter);

describe("PostgresProductFactsStore — durability across instances", () => {
  it("facts written by one instance are readable by a SECOND over the same DB", async () => {
    const db = new PGlite();
    const s1 = new PostgresProductFactsStore(pgliteSql(db));
    await s1.migrate();
    await s1.upsertMany("t", [{ productId: "p1", price: "$18", availableForSale: true }]);
    const s2 = new PostgresProductFactsStore(pgliteSql(db));
    expect(await s2.getMany("t", ["p1"])).toEqual([{ productId: "p1", price: "$18", availableForSale: true }]);
  });
});
