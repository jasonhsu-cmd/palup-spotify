import { describe, it, expect } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { InMemoryRuntimeStore } from "@palup/platform-ports";
import { runRuntimeStatePortContract } from "@palup/platform-ports/contract/runtime-state";
import { PostgresRuntimeStore } from "../src/postgres-runtime-store.js";
import type { Sql } from "../src/sql.js";

// Verify the Postgres adapter against a REAL Postgres engine (pglite = Postgres compiled to WASM,
// in-process, no server/Docker). Same query dialect as Cloud SQL / Spanner-pg, so this genuinely
// exercises the SQL — not a mock. Each makeAdapter() gets a fresh in-memory database (test isolation).

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

async function makePgAdapter(): Promise<PostgresRuntimeStore> {
  const store = new PostgresRuntimeStore(pgliteSql(new PGlite()));
  await store.migrate();
  return store;
}

// The adapter must pass the SAME contract as the in-memory reference — behavior-equivalence (ADR-0001).
runRuntimeStatePortContract(makePgAdapter);

describe("PostgresRuntimeStore ↔ InMemoryRuntimeStore hash parity", () => {
  it("produces a byte-identical audit hash for the same record (chain portable across engines)", async () => {
    const pg = await makePgAdapter();
    const mem = new InMemoryRuntimeStore();
    const ctx = { tenantId: "t" };
    const entry = { actor: "operator", action: "kill.arm", input: { scope: "global" }, reversalPath: "unkill" };
    const at = "2026-01-01T00:00:00.000Z";
    const rPg = await pg.audit(ctx, entry, at);
    const rMem = await mem.audit(ctx, entry, at);
    expect(rPg.hash).toBe(rMem.hash); // identical hashing → a chain written by one engine verifies on the other
    expect(rPg.prevHash).toBe(rMem.prevHash);
    expect(rPg.seq).toBe(rMem.seq);
  });
});
