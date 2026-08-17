import { describe, it, expect } from "vitest";
import type { VectorPort } from "../vector-port.js";

// Sibling contract to vector-port.contract.ts's `runVectorPortContract`, for a VECTOR-ONLY ANN adapter
// (pgvector/HNSW today). The existing contract mixes 2-/3-dim vector fixtures with a whole lexical-text
// modality (Jaccard) that a `vector(D)` column can never accept — reusing it here would force a fixed-
// dimension adapter to reject half the contract's own fixtures. This sibling mirrors the SPIRIT of every
// modality-agnostic assertion (ns-guard, unknown-ns→[], isolation, deleteById, deleteNamespace,
// overwrite, metadata round-trip, metadata independence, __proto__/constructor ids) rewritten to use
// VECTOR queries at a caller-supplied `dimension`, adds an ANN-specific "text query is rejected"
// assertion (an ANN adapter is vector-query-only, unlike the brute-force in-memory/Postgres ones), and a
// recall spot-check at a realistic corpus size (~5k rows) — the one behavior no small-fixture assertion
// above can exercise, since HNSW's approximate-nearest-neighbor search only diverges from exact brute
// force at scale.
//
// `makeAdapter` must return a FRESH, namespace-empty adapter each call (same contract as
// runVectorPortContract) — for a real Postgres/pgvector adapter this typically means truncating the
// backing table against one shared container (see pgvector-store.contract.test.ts's wiring).
// TEMPORARY BRIDGE (semantic-memory-v1 foundation, T1) — see vector-port.contract.ts's own copy of this
// note (kept here too rather than shared, since these are two independent contract files): `VectorPort`
// doesn't yet declare `list`; contract tests reach it through this narrow widening so a not-yet-updated
// adapter fails at RUNTIME ("adapter.list is not a function"), not a repo-wide compile break. Delete once
// `VectorPort` gains `list` for real.
export interface VectorPortListItem {
  id: string;
  metadata?: Record<string, unknown>;
}
export interface VectorPortWithList extends VectorPort {
  list(namespace: string, opts: { limit: number; after?: string }): Promise<VectorPortListItem[]>;
}
function listable(v: VectorPort): VectorPortWithList {
  return v as unknown as VectorPortWithList;
}

export function runVectorPortAnnContract(
  makeAdapter: () => VectorPort | Promise<VectorPort>,
  dimension: number,
): void {
  /** One-hot unit vector: 1 at index i, 0 elsewhere — cheap, exactly-orthogonal fixtures at `dimension`. */
  function e(i: number): number[] {
    if (i < 0 || i >= dimension) throw new Error(`e(${i}): out of range for dimension ${dimension}`);
    const v = new Array<number>(dimension).fill(0);
    v[i] = 1;
    return v;
  }

  describe("VectorPort ANN contract", () => {
    it("upsert OVERWRITES an existing id (same id twice -> one record, latest wins)", async () => {
      const v = await makeAdapter();
      await v.upsert("t", [{ id: "a", vector: e(0), metadata: { rev: 1 } }]);
      await v.upsert("t", [{ id: "a", vector: e(1), metadata: { rev: 2 } }]);
      const hits = await v.query("t", { vector: e(1), k: 10 });
      expect(hits).toHaveLength(1); // not two rows for the same id
      expect(hits[0]!.id).toBe("a");
      expect(hits[0]!.metadata).toEqual({ rev: 2 });
    }, 120_000);

    it("deleteById removes only the given ids (missing ids are ignored)", async () => {
      const v = await makeAdapter();
      await v.upsert("t", [
        { id: "a", vector: e(0) },
        { id: "b", vector: e(1) },
      ]);
      await v.deleteById("t", ["a", "does-not-exist"]);
      const hits = await v.query("t", { vector: e(0), k: 10 });
      expect(hits.map((h) => h.id)).toEqual(["b"]);
    }, 120_000);

    it("deleteNamespace erases the whole tenant (right-to-erasure)", async () => {
      const v = await makeAdapter();
      await v.upsert("gdpr-tenant", [
        { id: "x", vector: e(0) },
        { id: "y", vector: e(1) },
      ]);
      await v.deleteNamespace("gdpr-tenant");
      expect(await v.query("gdpr-tenant", { vector: e(0), k: 10 })).toEqual([]);
    }, 120_000);

    it("querying an unknown namespace returns []", async () => {
      const v = await makeAdapter();
      expect(await v.query("never-seen", { vector: e(0), k: 5 })).toEqual([]);
    }, 120_000);

    it("rejects a blank/missing namespace on EVERY op (no cross-tenant wildcard)", async () => {
      const v = await makeAdapter();
      const blanks: string[] = ["", "   ", undefined as unknown as string, null as unknown as string];
      for (const ns of blanks) {
        await expect(v.upsert(ns, [{ id: "a", vector: e(0) }])).rejects.toThrow(/namespace/i);
        await expect(v.query(ns, { vector: e(0), k: 1 })).rejects.toThrow(/namespace/i);
        await expect(v.deleteById(ns, ["a"])).rejects.toThrow(/namespace/i);
        await expect(v.deleteNamespace(ns)).rejects.toThrow(/namespace/i);
      }
    }, 120_000);

    it("is NAMESPACE-ISOLATED — tenant B never sees tenant A's records", async () => {
      const v = await makeAdapter();
      await v.upsert("tenant-a", [{ id: "a-secret", vector: e(0), metadata: { owner: "A" } }]);
      await v.upsert("tenant-b", [{ id: "b-only", vector: e(0), metadata: { owner: "B" } }]);

      const bHits = await v.query("tenant-b", { vector: e(0), k: 10 });
      expect(bHits.map((h) => h.id)).toEqual(["b-only"]);
      expect(bHits.every((h) => (h.metadata as { owner?: string }).owner === "B")).toBe(true);

      // Erasing tenant A must not touch tenant B.
      await v.deleteNamespace("tenant-a");
      const bAfter = await v.query("tenant-b", { vector: e(0), k: 10 });
      expect(bAfter.map((h) => h.id)).toEqual(["b-only"]);
      expect(await v.query("tenant-a", { vector: e(0), k: 10 })).toEqual([]);
    }, 120_000);

    it("round-trips metadata INCLUDING a nested disposition array (widget-memory's FactMetadata shape), " +
        "via a VECTOR query", async () => {
      const v = await makeAdapter();
      const metadata = {
        class: "ordinary",
        expiresAt: "2026-09-01T00:00:00.000Z",
        disposition: [
          { axis: "style", value: "researcher", provenance: "stated", confidence: 0.8, sourceQuote: "I always research first" },
        ],
      };
      await v.upsert("subject-x", [{ id: "fact-1", vector: e(0), metadata }]);
      const [hit] = await v.query("subject-x", { vector: e(0), k: 10 });
      expect(hit!.metadata).toEqual(metadata); // deep nested structure preserved, not flattened/stringified
    }, 120_000);

    it("returned metadata is independent of caller mutation afterwards", async () => {
      const v = await makeAdapter();
      await v.upsert("t", [{ id: "a", vector: e(0), metadata: { n: 1 } }]);
      const first = await v.query("t", { vector: e(0), k: 1 });
      (first[0]!.metadata as { n: number }).n = 999;
      const second = await v.query("t", { vector: e(0), k: 1 });
      expect(second[0]!.metadata).toEqual({ n: 1 });
    }, 120_000);

    it("treats __proto__/constructor as ordinary literal ids/namespaces (no prototype confusion)", async () => {
      const v = await makeAdapter();
      expect(await v.query("__proto__", { vector: e(0), k: 5 })).toEqual([]);
      await v.upsert("t", [
        { id: "__proto__", vector: e(0), metadata: { ok: 1 } },
        { id: "constructor", vector: e(0), metadata: { ok: 2 } },
      ]);
      const hits = await v.query("t", { vector: e(0), k: 5 });
      expect(hits.map((h) => h.id).sort()).toEqual(["__proto__", "constructor"]);
    }, 120_000);

    it("a text-modality query is REJECTED — this adapter is vector-query-only (no lexical modality)", async () => {
      const v = await makeAdapter();
      await v.upsert("t", [{ id: "a", vector: e(0) }]);
      await expect(v.query("t", { text: "x", k: 5 })).rejects.toThrow(/unsupported|vector/i);
    }, 120_000);

    // semantic-memory-v1 foundation, T1 — `list` on the vector-query-only ANN adapter: a plain keyset
    // scan by id, unaffected by HNSW's approximate ranking (list never ranks by similarity at all).
    describe("list — bounded keyset enumerate (vector-query-only adapter; list has no text/vector modality issue)", () => {
      it("returns every record in ascending id order with metadata, honors limit, and pages via `after` with no overlap/gap", async () => {
        const v = await makeAdapter();
        await v.upsert("list-ns", [
          { id: "c", vector: e(0), metadata: { seq: 3 } },
          { id: "a", vector: e(1), metadata: { seq: 1 } },
          { id: "b", vector: e(2), metadata: { seq: 2 } },
          { id: "d", vector: e(0), metadata: { seq: 4 } },
        ]);
        const all = await listable(v).list("list-ns", { limit: 500 });
        expect(all.map((r) => r.id)).toEqual(["a", "b", "c", "d"]);
        expect(all.map((r) => r.metadata)).toEqual([{ seq: 1 }, { seq: 2 }, { seq: 3 }, { seq: 4 }]);

        const first = await listable(v).list("list-ns", { limit: 2 });
        expect(first.map((r) => r.id)).toEqual(["a", "b"]);
        const second = await listable(v).list("list-ns", { limit: 2, after: "b" });
        expect(second.map((r) => r.id)).toEqual(["c", "d"]);
        const third = await listable(v).list("list-ns", { limit: 2, after: "d" });
        expect(third).toEqual([]);
      }, 120_000);

      it("unknown namespace -> []; blank namespace rejected; never crosses namespaces", async () => {
        const v = await makeAdapter();
        expect(await listable(v).list("never-seen-list", { limit: 5 })).toEqual([]);
        await expect(listable(v).list("", { limit: 5 })).rejects.toThrow(/namespace/i);

        await v.upsert("list-tenant-a", [{ id: "a1", vector: e(0), metadata: { owner: "A" } }]);
        await v.upsert("list-tenant-b", [{ id: "b1", vector: e(0), metadata: { owner: "B" } }]);
        const bList = await listable(v).list("list-tenant-b", { limit: 10 });
        expect(bList.map((r) => r.id)).toEqual(["b1"]);
      }, 120_000);
    });

    it(
      "RECALL SPOT-CHECK: a near-duplicate of the query vector, planted among ~5000 random" +
        "background vectors, is found within the top-10 (recall floor, not exact ordering — HNSW is " +
        "approximate, so this proves the ANN index+ef_search is genuinely wired to real recall, not " +
        "just returning arbitrary rows)",
      async () => {
        const v = await makeAdapter();
        const ns = "recall-spot-check";

        function randomUnitVector(): number[] {
          const raw = Array.from({ length: dimension }, () => Math.random() * 2 - 1);
          const mag = Math.sqrt(raw.reduce((s, x) => s + x * x, 0)) || 1;
          return raw.map((x) => x / mag);
        }

        const N = 5000;
        const queryVector = randomUnitVector();
        // A near-duplicate: the query vector plus a tiny perturbation, then renormalized — cosine to the
        // query is ~0.999+, far closer than any of the N independently-random background vectors will be
        // by chance at this dimension.
        const plantedId = "planted-near-duplicate";
        const planted = (() => {
          const noisy = queryVector.map((x) => x + (Math.random() * 2 - 1) * 0.01);
          const mag = Math.sqrt(noisy.reduce((s, x) => s + x * x, 0)) || 1;
          return noisy.map((x) => x / mag);
        })();

        const records = Array.from({ length: N }, (_, i) => ({
          id: `bg-${i}`,
          vector: randomUnitVector(),
        }));
        records.push({ id: plantedId, vector: planted });

        await v.upsert(ns, records);
        const hits = await v.query(ns, { vector: queryVector, k: 10 });
        expect(hits.map((h) => h.id)).toContain(plantedId);
      },
      300_000,
    );
  });
}
