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
      expect(hits[0].score).toBeGreaterThan(hits[1].score);
      expect(hits[1].score).toBeGreaterThan(hits[2].score);
      expect(hits[0].metadata).toEqual({ title: "exact" });
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
      expect(hits[0].id).toBe("a");
      expect(hits[0].metadata).toEqual({ rev: 2 });
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
      expect(hit.metadata).toEqual(metadata); // deep nested structure preserved, not flattened/stringified
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
      (first[0].metadata as { n: number }).n = 999;
      const second = await v.query("t", { vector: [1, 0], k: 1 });
      expect(second[0].metadata).toEqual({ n: 1 });
    });
  });
}
