import { describe, it, expect } from "vitest";
import { withPgvector, PGVECTOR_AVAILABLE } from "./helpers/pgvector-container.js";

describe.skipIf(!PGVECTOR_AVAILABLE)("pgvector testcontainer", () => {
  it("boots Postgres with the vector extension available", async () => {
    await withPgvector(async (sql) => {
      await sql.query("CREATE EXTENSION IF NOT EXISTS vector");
      const { rows } = await sql.query<{ ok: number }>("SELECT 1 AS ok");
      expect(rows[0]!.ok).toBe(1);
      const ext = await sql.query<{ extname: string }>(
        "SELECT extname FROM pg_extension WHERE extname = 'vector'",
      );
      expect(ext.rows.map((r) => r.extname)).toContain("vector");
    });
  }, 120_000);
});
