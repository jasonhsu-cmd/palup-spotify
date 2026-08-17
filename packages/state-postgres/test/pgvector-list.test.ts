import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PGVECTOR_AVAILABLE, startPgvectorContainer } from "./helpers/pgvector-container.js";
import type { Sql } from "../src/sql.js";
import { PgVectorStore, PgVectorTextQueryUnsupported } from "../src/pgvector-store.js";

// semantic-memory-v1 foundation, T1 — pgvector-container proof for `list` (bounded keyset enumerate).
// This is the CONCRETE motivation for adding `list` at all: `PgVectorStore.query` THROWS
// PgVectorTextQueryUnsupported on the text-modality "list everything for this subject" idiom
// widget-memory's erasure/retention/merge modules use today (`query(ns,{text:"",k:500})`) — pgvector has
// no lexical modality, so that idiom can never work on it. `list` is a plain namespace scan by id, no
// similarity ranking involved, which pgvector (or any adapter) CAN do. Mirrors the per-`it` container
// pattern of pgvector-store.query.test.ts's siblings, but with a shared beforeAll/afterAll container
// (pgvector-store.contract.test.ts's pattern) since this file also carries a 1200-row scale case.

const DIMENSION = 3;
// Content is irrelevant to `list` — every record needs SOME vector to satisfy PgVectorStore.upsert's
// dimension check; `list` never inspects it, only ids/metadata.
function vec(): number[] {
  return [1, 0, 0];
}

// TEMPORARY BRIDGE (see vector-port.contract.ts's own copy of this note) — `list` isn't on `VectorPort`
// (or `PgVectorStore`) yet; call it through this narrow widening so a missing implementation fails at
// RUNTIME, not at compile time.
interface Listable {
  list(namespace: string, opts: { limit: number; after?: string }): Promise<Array<{ id: string; metadata?: Record<string, unknown> }>>;
}
function listable(v: PgVectorStore): Listable {
  return v as unknown as Listable;
}

describe.skipIf(!PGVECTOR_AVAILABLE)("PgVectorStore.list — pgvector-container proof", () => {
  let sql: Sql;
  let stop: () => Promise<void>;

  beforeAll(async () => {
    ({ sql, stop } = await startPgvectorContainer());
    await new PgVectorStore(sql, { dimension: DIMENSION }).migrate();
  }, 120_000);

  afterAll(async () => {
    await stop?.();
  }, 120_000);

  it(
    "list returns all seeded rows in ascending id order and NEVER throws PgVectorTextQueryUnsupported " +
      "(contrast: query(ns,{text:''}) on the SAME store still throws — the fix is the new method, not a " +
      "change to query's own contract)",
    async () => {
      await sql.query("TRUNCATE vp_ann");
      const store = new PgVectorStore(sql, { dimension: DIMENSION });
      const ids = ["c", "a", "e", "b", "d"];
      await store.upsert(
        "t",
        ids.map((id) => ({ id, vector: vec(), metadata: { id } })),
      );

      const all = await listable(store).list("t", { limit: 100 });
      expect(all.map((r) => r.id)).toEqual(["a", "b", "c", "d", "e"]);
      expect(all.map((r) => r.metadata)).toEqual([{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }, { id: "e" }]);

      // Same store, same namespace — `query`'s text modality is still, correctly, unsupported.
      await expect(store.query("t", { text: "", k: 10 })).rejects.toBeInstanceOf(PgVectorTextQueryUnsupported);
    },
    120_000,
  );

  it(
    "keyset-paginates without overlap or gap, honoring `after` as an exclusive lower bound",
    async () => {
      await sql.query("TRUNCATE vp_ann");
      const store = new PgVectorStore(sql, { dimension: DIMENSION });
      const ids = Array.from({ length: 25 }, (_, i) => `row-${String(i).padStart(2, "0")}`);
      const shuffled = [...ids].sort(() => Math.random() - 0.5);
      await store.upsert(
        "t",
        shuffled.map((id) => ({ id, vector: vec() })),
      );

      const seen: string[] = [];
      let after: string | undefined;
      for (let guard = 0; guard < 10; guard++) {
        const page = await listable(store).list("t", { limit: 10, after });
        if (page.length === 0) break;
        seen.push(...page.map((r) => r.id));
        after = page[page.length - 1]!.id;
      }
      expect(seen).toEqual(ids); // exactly 25, in ascending order, no dup/gap
    },
    120_000,
  );

  it(
    "unknown namespace -> []; blank namespace rejected (no cross-tenant wildcard)",
    async () => {
      await sql.query("TRUNCATE vp_ann");
      const store = new PgVectorStore(sql, { dimension: DIMENSION });
      expect(await listable(store).list("never-seen", { limit: 10 })).toEqual([]);
      await expect(listable(store).list("", { limit: 10 })).rejects.toThrow(/namespace/i);
    },
    120_000,
  );

  it(
    "AT SCALE: 1000 rows in namespace A + 200 in namespace B — three list(A,{limit:500,after}) pages " +
      "return exactly A's 1000 ids in order, no overlap/gap, never a B row (proven against a REAL " +
      "pgvector engine, not the in-memory oracle)",
    async () => {
      await sql.query("TRUNCATE vp_ann");
      const store = new PgVectorStore(sql, { dimension: DIMENSION });
      const A = Array.from({ length: 1000 }, (_, i) => ({ id: `a-${String(i).padStart(4, "0")}`, vector: vec() }));
      const B = Array.from({ length: 200 }, (_, i) => ({ id: `b-${String(i).padStart(4, "0")}`, vector: vec() }));
      await store.upsert("scale-a", [...A].sort(() => Math.random() - 0.5));
      await store.upsert("scale-b", B);

      const seen: string[] = [];
      const pageSizes: number[] = [];
      let after: string | undefined;
      for (let guard = 0; guard < 10; guard++) {
        const page = await listable(store).list("scale-a", { limit: 500, after });
        pageSizes.push(page.length);
        if (page.length === 0) break;
        seen.push(...page.map((r) => r.id));
        after = page[page.length - 1]!.id;
      }
      expect(pageSizes).toEqual([500, 500, 0]);
      expect(seen).toEqual(A.map((r) => r.id));
      expect(seen.every((id) => id.startsWith("a-"))).toBe(true);
    },
    300_000,
  );
});
