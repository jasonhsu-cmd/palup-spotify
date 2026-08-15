import { describe, it, expect } from "vitest";
import { withPgvector, PGVECTOR_AVAILABLE } from "./helpers/pgvector-container.js";
import { PgVectorStore } from "../src/pgvector-store.js";

describe.skipIf(!PGVECTOR_AVAILABLE)("PgVectorStore erasure + isolation", () => {
  it("deleteById removes only given ids; deleteNamespace erases the tenant; namespaces isolated", async () => {
    await withPgvector(async (sql) => {
      const s = new PgVectorStore(sql, { dimension: 2, efSearch: 100 });
      await s.migrate();
      await s.upsert("A", [{ id: "a", vector: [1, 0] }, { id: "b", vector: [0, 1] }]);
      await s.upsert("B", [{ id: "b-only", vector: [1, 0] }]);
      await s.deleteById("A", ["a", "missing"]);
      expect((await s.query("A", { vector: [1, 0], k: 9 })).map((h) => h.id)).toEqual(["b"]);
      await s.deleteNamespace("A");
      expect(await s.query("A", { vector: [1, 0], k: 9 })).toEqual([]);
      expect((await s.query("B", { vector: [1, 0], k: 9 })).map((h) => h.id)).toEqual(["b-only"]);
    }, 120_000);
  });
});
