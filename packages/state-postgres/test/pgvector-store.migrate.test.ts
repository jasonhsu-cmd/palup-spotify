import { describe, it, expect } from "vitest";
import { withPgvector, PGVECTOR_AVAILABLE } from "./helpers/pgvector-container.js";
import { PgVectorStore } from "../src/pgvector-store.js";

describe.skipIf(!PGVECTOR_AVAILABLE)("PgVectorStore.migrate", () => {
  it("creates the extension, vp_ann(vector(D)), and an HNSW cosine index — idempotently", async () => {
    await withPgvector(async (sql) => {
      const store = new PgVectorStore(sql, { dimension: 4 });
      await store.migrate();
      await store.migrate(); // idempotent — second run must not throw

      const cols = await sql.query<{ udt: string }>(
        "SELECT udt_name AS udt FROM information_schema.columns WHERE table_name='vp_ann' AND column_name='embedding'",
      );
      expect(cols.rows[0]!.udt).toBe("vector");
      const idx = await sql.query<{ indexdef: string }>(
        "SELECT indexdef FROM pg_indexes WHERE tablename='vp_ann'",
      );
      const defs = idx.rows.map((r) => r.indexdef).join("\n");
      expect(defs).toMatch(/USING hnsw/i);
      expect(defs).toMatch(/vector_cosine_ops/i);
    });
  }, 120_000);
});
