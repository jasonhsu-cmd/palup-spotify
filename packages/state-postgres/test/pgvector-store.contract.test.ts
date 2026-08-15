import { describe, beforeAll, afterAll } from "vitest";
import { runVectorPortAnnContract } from "@palup/platform-ports/contract/vector-ann";
import { PGVECTOR_AVAILABLE, startPgvectorContainer } from "./helpers/pgvector-container.js";
import type { Sql } from "../src/sql.js";
import { PgVectorStore } from "../src/pgvector-store.js";

// Sibling to postgres-vector-store.test.ts's runVectorPortContract wiring, but for the pgvector-HNSW
// ANN adapter (vector-query-only — task 6). Booting a real Postgres+pgvector container per `it` (as
// pgvector-store.query/erasure/upsert.test.ts's `withPgvector` does) would be prohibitively slow for a
// contract with ~15 `it`s plus a 5k-row recall spot-check, so ONE container is booted for the whole
// file (beforeAll/afterAll) and `makeAdapter` returns a freshly-migrated, TRUNCATEd table each call —
// cheapest correct way to give every `it` a namespace-empty adapter over a shared container.

const DIMENSION = 8;

describe.skipIf(!PGVECTOR_AVAILABLE)("PgVectorStore — ANN contract", () => {
  let sql: Sql;
  let stop: () => Promise<void>;

  beforeAll(async () => {
    ({ sql, stop } = await startPgvectorContainer());
    // Migrate once up front so per-`it` makeAdapter calls only need a cheap TRUNCATE.
    const bootstrap = new PgVectorStore(sql, { dimension: DIMENSION, efSearch: 200 });
    await bootstrap.migrate();
  }, 120_000);

  afterAll(async () => {
    await stop?.();
  }, 120_000);

  runVectorPortAnnContract(async () => {
    await sql.query("TRUNCATE vp_ann");
    // efSearch high relative to the small corpora these behavioral tests use, so HNSW's approximation
    // never masks exact-ordering assertions (ef_search is only load-bearing in the recall spot-check).
    return new PgVectorStore(sql, { dimension: DIMENSION, efSearch: 200 });
  }, DIMENSION);
});
