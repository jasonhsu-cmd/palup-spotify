import { describe, it, expect } from "vitest";
import { withPgvector, PGVECTOR_AVAILABLE } from "./helpers/pgvector-container.js";
import { PgVectorStore, PgVectorTextQueryUnsupported } from "../src/pgvector-store.js";

describe.skipIf(!PGVECTOR_AVAILABLE)("PgVectorStore.query", () => {
  it(
    "returns nearest-first by cosine, honors k, round-trips metadata",
    async () => {
      await withPgvector(async (sql) => {
        const s = new PgVectorStore(sql, { dimension: 3, efSearch: 100 });
        await s.migrate();
        await s.upsert("t", [
          { id: "r3", vector: [0, 1, 0], metadata: { t: "far" } },
          { id: "r1", vector: [1, 0, 0], metadata: { t: "exact" } },
          { id: "r2", vector: [0.8, 0.6, 0], metadata: { t: "near" } },
        ]);
        const hits = await s.query("t", { vector: [1, 0, 0], k: 3 });
        expect(hits.map((h) => h.id)).toEqual(["r1", "r2", "r3"]); // ef_search=100 >> 3 ⇒ exact
        expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
        expect(hits[0]!.metadata).toEqual({ t: "exact" });
        expect((await s.query("t", { vector: [1, 0, 0], k: 2 })).map((h) => h.id)).toEqual(["r1", "r2"]);
      });
    },
    120_000,
  );

  it(
    "throws PgVectorTextQueryUnsupported for a text-only query; unknown namespace ⇒ []",
    async () => {
      await withPgvector(async (sql) => {
        const s = new PgVectorStore(sql, { dimension: 3 });
        await s.migrate();
        await expect(s.query("t", { text: "hi", k: 3 })).rejects.toBeInstanceOf(PgVectorTextQueryUnsupported);
        expect(await s.query("never-seen", { vector: [1, 0, 0], k: 5 })).toEqual([]);
      });
    },
    120_000,
  );
});
