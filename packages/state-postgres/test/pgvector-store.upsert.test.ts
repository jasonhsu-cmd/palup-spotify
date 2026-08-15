import { describe, it, expect } from "vitest";
import { withPgvector, PGVECTOR_AVAILABLE } from "./helpers/pgvector-container.js";
import { PgVectorStore } from "../src/pgvector-store.js";

const migrated = async (sql: any, dimension = 4) => {
  const s = new PgVectorStore(sql, { dimension });
  await s.migrate();
  return s;
};

describe.skipIf(!PGVECTOR_AVAILABLE)("PgVectorStore.upsert", () => {
  it(
    "stores a dimension-D vector + metadata and overwrites on same id",
    async () => {
      await withPgvector(async (sql) => {
        const s = await migrated(sql);
        await s.upsert("t", [{ id: "a", vector: [1, 0, 0, 0], metadata: { rev: 1 } }]);
        await s.upsert("t", [{ id: "a", vector: [0, 1, 0, 0], metadata: { rev: 2 } }]);
        const { rows } = await sql.query("SELECT id, metadata FROM vp_ann WHERE namespace='t'");
        expect(rows).toHaveLength(1);
        expect(rows[0].metadata).toEqual({ rev: 2 });
      });
    },
    120_000,
  );

  it(
    "REJECTS a wrong-dimension or vectorless record (fail closed)",
    async () => {
      await withPgvector(async (sql) => {
        const s = await migrated(sql);
        await expect(s.upsert("t", [{ id: "b", vector: [1, 0, 0] }])).rejects.toThrow(/dimension/i);
        await expect(s.upsert("t", [{ id: "c", metadata: { x: 1 } }])).rejects.toThrow(/dimension/i);
        const { rows } = await sql.query("SELECT id FROM vp_ann WHERE namespace='t'");
        expect(rows).toHaveLength(0);
      });
    },
    120_000,
  );

  it(
    "rejects control-char text (shared requireCleanText) and blank namespace",
    async () => {
      await withPgvector(async (sql) => {
        const s = await migrated(sql);
        const NUL = String.fromCharCode(0);
        await expect(s.upsert("t", [{ id: "d", vector: [1, 0, 0, 0], text: `x${NUL}y` }])).rejects.toThrow(
          /control character|surrogate/i,
        );
        await expect(s.upsert("", [{ id: "e", vector: [1, 0, 0, 0] }])).rejects.toThrow(/namespace/i);
        const { rows } = await sql.query("SELECT id FROM vp_ann WHERE namespace='t'");
        expect(rows).toHaveLength(0);
      });
    },
    120_000,
  );

  it(
    "a wrong-dimension record ANYWHERE in a batch rolls back the WHOLE batch (all-or-nothing)",
    async () => {
      await withPgvector(async (sql) => {
        const s = await migrated(sql);
        await expect(
          s.upsert("t", [
            { id: "good", vector: [1, 0, 0, 0] },
            { id: "bad", vector: [1, 0, 0] },
          ]),
        ).rejects.toThrow(/dimension/i);
        const { rows } = await sql.query("SELECT id FROM vp_ann WHERE namespace='t'");
        expect(rows).toHaveLength(0);
      });
    },
    120_000,
  );
});
