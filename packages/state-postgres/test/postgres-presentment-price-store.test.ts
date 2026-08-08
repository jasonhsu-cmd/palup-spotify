import { describe, it, expect } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { runPresentmentPricePortContract } from "@palup/platform-ports/contract/presentment-price";
import { PostgresPresentmentPriceStore } from "../src/postgres-presentment-price-store.js";
import type { Sql } from "../src/sql.js";

// Durable, portable PresentmentPricePort adapter (ADR-0001; ADR-0020 B-T3). Verified against a REAL
// Postgres engine (pglite = Postgres compiled to WASM, in-process). Mirrors the ProductFacts pglite harness.
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

async function makePgAdapter(): Promise<PostgresPresentmentPriceStore> {
  const store = new PostgresPresentmentPriceStore(pgliteSql(new PGlite()));
  await store.migrate();
  return store;
}

// Must pass the SAME contract as the in-memory reference — behavior-equivalence (ADR-0001).
runPresentmentPricePortContract(makePgAdapter);

describe("PostgresPresentmentPriceStore — durability across instances", () => {
  it("prices written by one instance are readable by a SECOND over the same DB", async () => {
    const db = new PGlite();
    const s1 = new PostgresPresentmentPriceStore(pgliteSql(db));
    await s1.migrate();
    await s1.upsertMany("t", [{ productId: "p1", currency: "EUR", price: "€18" }]);
    const s2 = new PostgresPresentmentPriceStore(pgliteSql(db));
    expect(await s2.getMany("t", ["p1"], "EUR")).toEqual([{ productId: "p1", currency: "EUR", price: "€18" }]);
  });
});
