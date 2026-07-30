import { describe, it, expect } from "vitest";
import { createInMemoryVectorStore } from "../src/vector-port.js";

// Contract for the `vector` port (port-interfaces.md): namespace = tenant, no cross-namespace query,
// right-to-erasure by id and by namespace, blank namespace fails closed. The in-memory adapter is the
// behavioral oracle a cloud adapter must match.
describe("createInMemoryVectorStore — VectorPort contract", () => {
  it("upsert + query returns same-namespace records ordered by similarity (nearest first)", async () => {
    const v = createInMemoryVectorStore();
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
    const v = createInMemoryVectorStore();
    await v.upsert("t", [
      { id: "r1", vector: [1, 0, 0] },
      { id: "r2", vector: [0.8, 0.6, 0] },
      { id: "r3", vector: [0, 1, 0] },
    ]);
    const top2 = await v.query("t", { vector: [1, 0, 0], k: 2 });
    expect(top2.map((h) => h.id)).toEqual(["r1", "r2"]);
  });

  it("orders by lexical similarity when records carry text instead of vectors", async () => {
    const v = createInMemoryVectorStore();
    await v.upsert("shop", [
      { id: "hat", text: "wool winter beanie hat" },
      { id: "boot", text: "leather winter boots" },
      { id: "mug", text: "ceramic coffee mug" },
    ]);
    const hits = await v.query("shop", { text: "winter hat", k: 3 });
    expect(hits.map((h) => h.id)).toEqual(["hat", "boot", "mug"]);
  });

  it("deleteById removes only the given ids (missing ids are ignored)", async () => {
    const v = createInMemoryVectorStore();
    await v.upsert("t", [
      { id: "a", vector: [1, 0] },
      { id: "b", vector: [0, 1] },
    ]);
    await v.deleteById("t", ["a", "does-not-exist"]);
    const hits = await v.query("t", { vector: [1, 0], k: 10 });
    expect(hits.map((h) => h.id)).toEqual(["b"]);
  });

  it("deleteNamespace erases the whole tenant (right-to-erasure)", async () => {
    const v = createInMemoryVectorStore();
    await v.upsert("gdpr-tenant", [
      { id: "x", vector: [1, 0] },
      { id: "y", vector: [0, 1] },
    ]);
    await v.deleteNamespace("gdpr-tenant");
    expect(await v.query("gdpr-tenant", { vector: [1, 0], k: 10 })).toEqual([]);
  });

  it("querying an unknown namespace returns []", async () => {
    const v = createInMemoryVectorStore();
    expect(await v.query("never-seen", { vector: [1, 0], k: 5 })).toEqual([]);
  });

  it("rejects a blank/missing namespace on EVERY op (no cross-tenant wildcard)", async () => {
    const v = createInMemoryVectorStore();
    const blanks: string[] = ["", "   ", undefined as unknown as string, null as unknown as string];
    for (const ns of blanks) {
      await expect(v.upsert(ns, [{ id: "a", vector: [1, 0] }])).rejects.toThrow(/namespace/i);
      await expect(v.query(ns, { vector: [1, 0], k: 1 })).rejects.toThrow(/namespace/i);
      await expect(v.deleteById(ns, ["a"])).rejects.toThrow(/namespace/i);
      await expect(v.deleteNamespace(ns)).rejects.toThrow(/namespace/i);
    }
  });

  it("is namespace-isolated — tenant B never sees tenant A's records", async () => {
    const v = createInMemoryVectorStore();
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

  it("does not confuse prototype keys for records (null-proto inner map)", async () => {
    const v = createInMemoryVectorStore();
    // A namespace that only exists on Object.prototype resolves to no records, not a spurious hit.
    expect(await v.query("__proto__", { vector: [1, 0], k: 5 })).toEqual([]);
    // An id literally named __proto__/constructor is stored & retrieved as an ordinary record.
    await v.upsert("t", [
      { id: "__proto__", vector: [1, 0], metadata: { ok: 1 } },
      { id: "constructor", vector: [1, 0], metadata: { ok: 2 } },
    ]);
    const hits = await v.query("t", { vector: [1, 0], k: 5 });
    expect(hits.map((h) => h.id).sort()).toEqual(["__proto__", "constructor"]);
  });

  it("returns cloned metadata so callers can't mutate stored state by reference", async () => {
    const v = createInMemoryVectorStore();
    await v.upsert("t", [{ id: "a", vector: [1, 0], metadata: { n: 1 } }]);
    const first = await v.query("t", { vector: [1, 0], k: 1 });
    (first[0].metadata as { n: number }).n = 999;
    const second = await v.query("t", { vector: [1, 0], k: 1 });
    expect(second[0].metadata).toEqual({ n: 1 });
  });
});
