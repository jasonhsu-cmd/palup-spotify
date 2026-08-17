import { describe, it, expect } from "vitest";
import type { VectorPort } from "../vector-port.js";

// Port contract (ADR-0001; port-interfaces.md `vector`): every VectorPort adapter (in-memory, Postgres,
// …) MUST pass this, so adapters stay behavior-equivalent (the same discipline as
// runRuntimeStatePortContract) and the engine stays swappable. `makeAdapter` must return a FRESH,
// namespace-empty adapter each call — async so a Postgres adapter can migrate/connect per test.
//
// Ranking behavior asserted here (cosine for vectors, lexical Jaccard for text, tie-break by id) is the
// oracle every adapter must reproduce EXACTLY — see vector-port.ts's exported `scoreRecord`, which a
// durable adapter should reuse rather than reimplement, so ranking can never drift between engines.

// TEMPORARY BRIDGE (semantic-memory-v1 foundation, T1) — `VectorPort` itself does not yet declare
// `list` (a plain, bounded keyset enumerate distinct from the ANN `query`; the fix for
// PgVectorTextQueryUnsupported on the memory package's list-all idiom, `query(ns,{text:"",k:500})`).
// That lands on the interface + every adapter as the BUILD half of this PR. Contract tests reach it
// through this narrow widening so a not-yet-implemented adapter fails at RUNTIME
// ("adapter.list is not a function") — a genuine behavior-red — rather than making every existing
// VectorPort-typed call site fail to COMPILE before a single adapter has been touched. Once `VectorPort`
// gains `list` for real, delete this and change every `listable(v)` below back to plain `v`.
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
export function runVectorPortContract(makeAdapter: () => VectorPort | Promise<VectorPort>): void {
  describe("VectorPort contract", () => {
    it("upsert + query returns same-namespace records ordered by similarity (nearest first)", async () => {
      const v = await makeAdapter();
      await v.upsert("tenant-a", [
        { id: "r3", vector: [0, 1, 0], metadata: { title: "far" } },
        { id: "r1", vector: [1, 0, 0], metadata: { title: "exact" } },
        { id: "r2", vector: [0.8, 0.6, 0], metadata: { title: "near" } },
      ]);
      const hits = await v.query("tenant-a", { vector: [1, 0, 0], k: 3 });
      expect(hits.map((h) => h.id)).toEqual(["r1", "r2", "r3"]);
      expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
      expect(hits[1]!.score).toBeGreaterThan(hits[2]!.score);
      expect(hits[0]!.metadata).toEqual({ title: "exact" });
    });

    it("honors k — returns only the top-k nearest", async () => {
      const v = await makeAdapter();
      await v.upsert("t", [
        { id: "r1", vector: [1, 0, 0] },
        { id: "r2", vector: [0.8, 0.6, 0] },
        { id: "r3", vector: [0, 1, 0] },
      ]);
      const top2 = await v.query("t", { vector: [1, 0, 0], k: 2 });
      expect(top2.map((h) => h.id)).toEqual(["r1", "r2"]);
    });

    it("orders by lexical similarity when records carry text instead of vectors", async () => {
      const v = await makeAdapter();
      await v.upsert("shop", [
        { id: "hat", text: "wool winter beanie hat" },
        { id: "boot", text: "leather winter boots" },
        { id: "mug", text: "ceramic coffee mug" },
      ]);
      const hits = await v.query("shop", { text: "winter hat", k: 3 });
      expect(hits.map((h) => h.id)).toEqual(["hat", "boot", "mug"]);
    });

    it('an empty-text query is the "list everything" idiom the real consumer (widget-memory) uses: every ' +
        "record ties at score 0 and comes back in stable id order, up to k", async () => {
      const v = await makeAdapter();
      await v.upsert("subject", [
        { id: "c", text: "third fact" },
        { id: "a", text: "first fact" },
        { id: "b", text: "second fact" },
      ]);
      const all = await v.query("subject", { text: "", k: 500 });
      expect(all.map((h) => h.id)).toEqual(["a", "b", "c"]); // stable id order, not insertion order
      expect(all.every((h) => h.score === 0)).toBe(true);
      const capped = await v.query("subject", { text: "", k: 2 });
      expect(capped.map((h) => h.id)).toEqual(["a", "b"]); // still honors k
    });

    it("upsert OVERWRITES an existing id (same id twice -> one record, latest wins)", async () => {
      const v = await makeAdapter();
      await v.upsert("t", [{ id: "a", vector: [1, 0, 0], metadata: { rev: 1 } }]);
      await v.upsert("t", [{ id: "a", vector: [0, 1, 0], metadata: { rev: 2 } }]);
      const hits = await v.query("t", { vector: [0, 1, 0], k: 10 });
      expect(hits).toHaveLength(1); // not two rows for the same id
      expect(hits[0]!.id).toBe("a");
      expect(hits[0]!.metadata).toEqual({ rev: 2 });
    });

    it("round-trips metadata INCLUDING a nested disposition array (widget-memory's FactMetadata shape)", async () => {
      const v = await makeAdapter();
      const metadata = {
        text: "prefers eco-friendly packaging",
        class: "ordinary",
        expiresAt: "2026-09-01T00:00:00.000Z",
        disposition: [
          { axis: "style", value: "researcher", provenance: "stated", confidence: 0.8, sourceQuote: "I always research first" },
        ],
      };
      await v.upsert("subject-x", [{ id: "fact-1", text: metadata.text, metadata }]);
      const [hit] = await v.query("subject-x", { text: "", k: 10 });
      expect(hit!.metadata).toEqual(metadata); // deep nested structure preserved, not flattened/stringified
    });

    it("deleteById removes only the given ids (missing ids are ignored)", async () => {
      const v = await makeAdapter();
      await v.upsert("t", [
        { id: "a", vector: [1, 0] },
        { id: "b", vector: [0, 1] },
      ]);
      await v.deleteById("t", ["a", "does-not-exist"]);
      const hits = await v.query("t", { vector: [1, 0], k: 10 });
      expect(hits.map((h) => h.id)).toEqual(["b"]);
    });

    it("deleteNamespace erases the whole tenant (right-to-erasure)", async () => {
      const v = await makeAdapter();
      await v.upsert("gdpr-tenant", [
        { id: "x", vector: [1, 0] },
        { id: "y", vector: [0, 1] },
      ]);
      await v.deleteNamespace("gdpr-tenant");
      expect(await v.query("gdpr-tenant", { vector: [1, 0], k: 10 })).toEqual([]);
    });

    it("querying an unknown namespace returns []", async () => {
      const v = await makeAdapter();
      expect(await v.query("never-seen", { vector: [1, 0], k: 5 })).toEqual([]);
    });

    it("rejects a blank/missing namespace on EVERY op (no cross-tenant wildcard)", async () => {
      const v = await makeAdapter();
      const blanks: string[] = ["", "   ", undefined as unknown as string, null as unknown as string];
      for (const ns of blanks) {
        await expect(v.upsert(ns, [{ id: "a", vector: [1, 0] }])).rejects.toThrow(/namespace/i);
        await expect(v.query(ns, { vector: [1, 0], k: 1 })).rejects.toThrow(/namespace/i);
        await expect(v.deleteById(ns, ["a"])).rejects.toThrow(/namespace/i);
        await expect(v.deleteNamespace(ns)).rejects.toThrow(/namespace/i);
      }
    });

    it("is NAMESPACE-ISOLATED — tenant B never sees tenant A's records", async () => {
      const v = await makeAdapter();
      await v.upsert("tenant-a", [{ id: "a-secret", vector: [1, 0, 0], metadata: { owner: "A" } }]);
      await v.upsert("tenant-b", [{ id: "b-only", vector: [1, 0, 0], metadata: { owner: "B" } }]);

      const bHits = await v.query("tenant-b", { vector: [1, 0, 0], k: 10 });
      expect(bHits.map((h) => h.id)).toEqual(["b-only"]);
      expect(bHits.every((h) => (h.metadata as { owner?: string }).owner === "B")).toBe(true);

      // Erasing tenant A must not touch tenant B.
      await v.deleteNamespace("tenant-a");
      const bAfter = await v.query("tenant-b", { vector: [1, 0, 0], k: 10 });
      expect(bAfter.map((h) => h.id)).toEqual(["b-only"]);
      expect(await v.query("tenant-a", { vector: [1, 0, 0], k: 10 })).toEqual([]);
    });

    it("treats __proto__/constructor as ordinary literal ids/namespaces (no prototype confusion)", async () => {
      const v = await makeAdapter();
      expect(await v.query("__proto__", { vector: [1, 0], k: 5 })).toEqual([]);
      await v.upsert("t", [
        { id: "__proto__", vector: [1, 0], metadata: { ok: 1 } },
        { id: "constructor", vector: [1, 0], metadata: { ok: 2 } },
      ]);
      const hits = await v.query("t", { vector: [1, 0], k: 5 });
      expect(hits.map((h) => h.id).sort()).toEqual(["__proto__", "constructor"]);
    });

    it("upsert REJECTS record.text carrying a control character (e.g. NUL) or an unpaired UTF-16 " +
        "surrogate — every adapter must fail closed the SAME way (verified: pglite/Postgres throws on a " +
        "raw NUL byte; a naive in-memory adapter would otherwise accept it silently)", async () => {
      const v = await makeAdapter();
      const NUL = String.fromCharCode(0);
      const LONE_SURROGATE = String.fromCharCode(0xd800);
      await expect(v.upsert("t", [{ id: "a", text: `abc${NUL}def` }])).rejects.toThrow(
        /control character|surrogate/i,
      );
      await expect(v.upsert("t", [{ id: "b", text: `abc${LONE_SURROGATE}def` }])).rejects.toThrow(
        /control character|surrogate/i,
      );
      // A valid surrogate PAIR (an emoji) must NOT be rejected.
      await expect(v.upsert("t", [{ id: "c", text: "abc\u{1F600}def" }])).resolves.not.toThrow();
    });

    it("returned metadata is independent of caller mutation afterwards", async () => {
      const v = await makeAdapter();
      await v.upsert("t", [{ id: "a", vector: [1, 0], metadata: { n: 1 } }]);
      const first = await v.query("t", { vector: [1, 0], k: 1 });
      (first[0]!.metadata as { n: number }).n = 999;
      const second = await v.query("t", { vector: [1, 0], k: 1 });
      expect(second[0]!.metadata).toEqual({ n: 1 });
    });

    // semantic-memory-v1 foundation, T1 — `list`: a plain, bounded KEYSET enumerate ("give me the next
    // page of this namespace by id"), distinct from `query`'s similarity ranking. This is the operation
    // widget-memory's erasure/retention/merge modules need to walk a subject's ENTIRE fact set to
    // completion at any scale, and the one pgvector can actually perform (its `query` throws
    // PgVectorTextQueryUnsupported on the text-modality "list everything" idiom `query(ns,{text:"",k:500})}`
    // those modules use today).
    describe("list — bounded keyset enumerate (ascending id; `after` is an exclusive lower bound)", () => {
      it("returns every record in ASCENDING id order with metadata, and NEVER a record from another namespace", async () => {
        const v = await makeAdapter();
        await v.upsert("subject-list", [
          { id: "c", text: "third fact", metadata: { seq: 3 } },
          { id: "a", text: "first fact", metadata: { seq: 1 } },
          { id: "b", text: "second fact", metadata: { seq: 2 } },
        ]);
        await v.upsert("other-tenant-list", [{ id: "z", text: "not mine", metadata: { seq: 99 } }]);

        const all = await listable(v).list("subject-list", { limit: 500 });
        expect(all.map((r) => r.id)).toEqual(["a", "b", "c"]); // ascending id, not insertion order
        expect(all.map((r) => r.metadata)).toEqual([{ seq: 1 }, { seq: 2 }, { seq: 3 }]);
        expect(all.some((r) => r.id === "z")).toBe(false); // the other namespace never leaks in
      });

      it("honors `limit` — returns only the first N by ascending id", async () => {
        const v = await makeAdapter();
        await v.upsert("list-limit", [
          { id: "c", text: "" },
          { id: "a", text: "" },
          { id: "b", text: "" },
        ]);
        const page = await listable(v).list("list-limit", { limit: 2 });
        expect(page.map((r) => r.id)).toEqual(["a", "b"]);
      });

      it("`after` is an EXCLUSIVE lower bound — the next page picks up with no overlap and no gap, and a fully-exhausted page is []", async () => {
        const v = await makeAdapter();
        await v.upsert("list-paginate", [
          { id: "c", text: "" },
          { id: "a", text: "" },
          { id: "b", text: "" },
          { id: "d", text: "" },
        ]);
        const first = await listable(v).list("list-paginate", { limit: 2 });
        expect(first.map((r) => r.id)).toEqual(["a", "b"]);
        const second = await listable(v).list("list-paginate", { limit: 2, after: first[first.length - 1]!.id });
        expect(second.map((r) => r.id)).toEqual(["c", "d"]); // continues exactly where the first page stopped
        const third = await listable(v).list("list-paginate", { limit: 2, after: second[second.length - 1]!.id });
        expect(third).toEqual([]); // exhausted — no further page, no repeats
      });

      it("an unknown namespace returns []", async () => {
        const v = await makeAdapter();
        expect(await listable(v).list("never-seen-list", { limit: 10 })).toEqual([]);
      });

      it("rejects a blank/missing namespace on `list` too (no cross-tenant wildcard)", async () => {
        const v = await makeAdapter();
        const blanks: string[] = ["", "   ", undefined as unknown as string, null as unknown as string];
        for (const ns of blanks) {
          await expect(listable(v).list(ns, { limit: 10 })).rejects.toThrow(/namespace/i);
        }
      });

      it("returned metadata deep round-trips (nested disposition array) and is independent of caller mutation afterwards", async () => {
        const v = await makeAdapter();
        const metadata = {
          text: "prefers eco-friendly packaging",
          class: "ordinary",
          expiresAt: "2026-09-01T00:00:00.000Z",
          disposition: [
            { axis: "style", value: "researcher", provenance: "stated", confidence: 0.8, sourceQuote: "I always research first" },
          ],
        };
        await v.upsert("list-meta", [{ id: "fact-1", text: metadata.text, metadata }]);
        const [hit] = await listable(v).list("list-meta", { limit: 10 });
        expect(hit!.metadata).toEqual(metadata); // deep nested structure preserved, not flattened/stringified
        (hit!.metadata as { class: string }).class = "mutated";
        const again = await listable(v).list("list-meta", { limit: 10 });
        expect(again[0]!.metadata).toEqual(metadata); // unaffected by the caller's mutation above
      });

      it(
        "KEYSET AT SCALE: 1000 records in namespace A + 200 in namespace B — three list(A,{limit:500,after}) " +
          "pages return EXACTLY A's 1000 ids in ascending order, no overlap, no gap, and never a B row " +
          "(the memory package's current list-all idiom truncates/fails-closed at k=500 — this proves " +
          "genuine pagination, not a bigger cap)",
        async () => {
          const v = await makeAdapter();
          const A = Array.from({ length: 1000 }, (_, i) => ({
            id: `a-${String(i).padStart(4, "0")}`,
            text: "",
            metadata: { i },
          }));
          const B = Array.from({ length: 200 }, (_, i) => ({
            id: `b-${String(i).padStart(4, "0")}`,
            text: "",
            metadata: { i },
          }));
          // Shuffle insertion order so nothing here could pass by accident on insertion order.
          await v.upsert("scale-a", [...A].sort(() => Math.random() - 0.5));
          await v.upsert("scale-b", B);

          const seen: string[] = [];
          const pageSizes: number[] = [];
          let after: string | undefined;
          for (let guard = 0; guard < 10; guard++) {
            const page = await listable(v).list("scale-a", { limit: 500, after });
            pageSizes.push(page.length);
            if (page.length === 0) break;
            seen.push(...page.map((r) => r.id));
            after = page[page.length - 1]!.id;
          }
          expect(pageSizes).toEqual([500, 500, 0]); // two full pages, then an empty terminator — exactly 3 calls
          expect(seen).toEqual(A.map((r) => r.id)); // exactly A's 1000, in ascending id order, no dup/gap
          expect(new Set(seen).size).toBe(1000); // no overlap across pages
          expect(seen.every((id) => id.startsWith("a-"))).toBe(true); // never a B row leaked in
        },
        60_000,
      );
    });
  });
}
