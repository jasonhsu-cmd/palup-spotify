import { describe, it, expect, afterEach } from "vitest";
import { createVectorStore } from "../src/vector-factory.js";
import { withPgvector, PGVECTOR_AVAILABLE } from "./helpers/pgvector-container.js";

// VECTOR_ANN selection (ADR-0020 D3 / A2, ships dark): createVectorStore must select the pgvector-HNSW
// adapter (kind "ann") ONLY when BOTH DATABASE_URL is set AND VECTOR_ANN==="true" — never on flag alone
// (a durable url is required; ann is not a substitute for the DATABASE_URL fail-fast semantics above it).
// Everything else (brute-force postgres branch, PALUP_REQUIRE_DATABASE_URL fail-fast, in-memory default)
// stays byte-identical — proven here by the flag having NO effect when DATABASE_URL is unset.

const reset = () => {
  delete process.env.DATABASE_URL;
  delete process.env.VECTOR_ANN;
  delete process.env.PALUP_REQUIRE_DATABASE_URL;
  delete process.env.PALUP_EMBED_DIMENSION;
  delete process.env.HNSW_EF_SEARCH;
};
afterEach(reset);

describe("createVectorStore VECTOR_ANN selection (dark)", () => {
  it("flag OFF with no DATABASE_URL ⇒ in-memory (unchanged)", async () => {
    reset();
    expect((await createVectorStore()).kind).toBe("memory");
  });

  it("flag ON but no DATABASE_URL ⇒ still NOT ann (ann requires a durable url)", async () => {
    reset();
    process.env.VECTOR_ANN = "true";
    expect((await createVectorStore()).kind).toBe("memory");
  });

  describe.skipIf(!PGVECTOR_AVAILABLE)("container-backed", () => {
    it(
      "DATABASE_URL set + VECTOR_ANN=true ⇒ selects the pgvector adapter (kind \"ann\") and it round-trips",
      async () => {
        await withPgvector(async (sql) => {
          reset();
          process.env.DATABASE_URL = "postgres://ignored-shared-sql-is-used-instead/palup";
          process.env.VECTOR_ANN = "true";
          process.env.PALUP_EMBED_DIMENSION = "3";
          try {
            const { store, kind } = await createVectorStore(sql);
            expect(kind).toBe("ann");
            await store.upsert("t", [{ id: "a", vector: [1, 0, 0], metadata: { t: "exact" } }]);
            const hits = await store.query("t", { vector: [1, 0, 0], k: 1 });
            expect(hits.map((h) => h.id)).toEqual(["a"]);
            expect(hits[0]!.metadata).toEqual({ t: "exact" });
          } finally {
            reset();
          }
        });
      },
      120_000,
    );
  });
});
