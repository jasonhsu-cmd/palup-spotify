import { describe } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { PostgresCatalogProductStore } from "../src/postgres-catalog-product-store.js";
import { runCatalogProductPortContract } from "@palup/platform-ports/contract/catalog-product";
import type { Sql } from "../src/sql.js";

function pgliteSql(db: PGlite): Sql {
  const wrap = (r: any) => ({
    query: async (text: string, params: unknown[] = []) => ({ rows: (await r.query(text, params)).rows }),
    tx: () => { throw new Error("nested tx unsupported"); },
  });
  return { query: (t, p) => wrap(db).query(t, p), tx: (fn: any) => db.transaction((c: any) => fn(wrap(c))) } as Sql;
}

describe("PostgresCatalogProductStore (pglite)", () => {
  runCatalogProductPortContract(async () => {
    const s = new PostgresCatalogProductStore(pgliteSql(new PGlite()));
    await s.migrate();
    return s;
  });
});
