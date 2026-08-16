import { describe, it, expect, vi } from "vitest";
import {
  InMemoryRuntimeStore,
  createInMemoryVectorStore,
  requireEmbedInputs,
  type EmbedRequest,
  type EmbedResponse,
  type GroundingContext,
  type ModelPort,
  type Product,
} from "@palup/platform-ports";
import {
  runCatalogIndex,
  reconcileProducts,
  catalogNamespace,
  catalogRecordId,
  MANIFEST_COLLECTION,
  type CatalogSource,
  type CatalogByIdSource,
} from "../src/jobs/catalog-index.js";
import { readCorpusLedger, readCorpusLedgerTimestamps, ledgerChunkKey } from "../src/jobs/catalog-ledger.js";

const DIMENSION = 8;
function fakeModel(): ModelPort {
  return {
    async complete() { return { text: "ok", model: "fe" }; },
    async embed(req: EmbedRequest): Promise<EmbedResponse> {
      requireEmbedInputs(req);
      return { vectors: req.texts.map((t) => { const v = new Array(DIMENSION).fill(0); for (let i = 0; i < t.length; i++) v[i % DIMENSION] += 1; return v; }), model: "fe", dimension: DIMENSION, purpose: req.purpose };
    },
  };
}
function products(ids: number[]): Product[] {
  return ids.map((i) => ({ id: `gid://shopify/Product/${i}`, title: `t-${i}`, description: `d-${i}`, price: "$1", tags: ["x"], availableForSale: true }));
}

describe("catalog-index — fetch-timestamp concurrency guard (S4 §F)", () => {
  it("does NOT stale-delete a product a concurrent webhook wrote after the full job's fetch snapshot", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    // Seed: index products 0,1,2 normally so a ledger exists with real writtenAt timestamps.
    const seed: CatalogSource = async (t) => ({ tenantId: t, brandName: "B", products: products([0, 1, 2]), policy: { returns: "", shipping: "" } });
    await runCatalogIndex({ store, vector, model: fakeModel(), catalog: seed, now: () => new Date(1_000) }, ["acme"], {});

    // The full job's fetch returns 0,1,2 (product 9 was NOT yet in the merchant catalog when it fetched).
    // A concurrent webhook writes product 9 into the ledger DURING the run — modeled by a catalog source
    // whose FIRST await injects the ledger write, then returns the pre-webhook snapshot {0,1,2}.
    const ns = catalogNamespace("acme");
    const racingCatalog: CatalogSource = async (t): Promise<GroundingContext> => {
      // webhook wrote product:9 with a writtenAt AFTER the full job's fetchStartedAt (now()=5_000 below).
      const chunk = { version: 1 as const, at: new Date(6_000).toISOString(), entries: { "product:gid://shopify/Product/9": "hash9" }, writtenAt: { "product:gid://shopify/Product/9": 6_000 } };
      // merge onto the existing ledger chunk 0000 (read-modify-write to keep 0,1,2 too)
      const existing = await readCorpusLedger(store, "acme");
      const entries: Record<string, string> = { "product:gid://shopify/Product/9": "hash9" };
      const writtenAt: Record<string, number> = { "product:gid://shopify/Product/9": 6_000 };
      for (const [id, h] of existing) { entries[id] = h; writtenAt[id] = 1_000; }
      await store.put({ tenantId: "acme" }, MANIFEST_COLLECTION, ledgerChunkKey(0), { version: 1, at: chunk.at, entries, writtenAt });
      await vector.upsert(ns, [{ id: "product:gid://shopify/Product/9", vector: new Array(DIMENSION).fill(1), metadata: { kind: "product", productId: "gid://shopify/Product/9", contentHash: "hash9", title: "t-9" } }]);
      return { tenantId: t, brandName: "B", products: products([0, 1, 2]), policy: { returns: "", shipping: "" } };
    };
    const [report] = await runCatalogIndex({ store, vector, model: fakeModel(), catalog: racingCatalog, now: () => new Date(5_000) }, ["acme"], {});
    expect(report!.outcome).not.toBe("failed");
    // product 9 (written after fetchStartedAt=5_000) must survive both the vector store AND the ledger.
    const ledger = await readCorpusLedger(store, "acme");
    expect([...ledger.keys()]).toContain("product:gid://shopify/Product/9");
    expect(report!.removed).toBe(0);
  });

  it("treats a pre-S4 entry (no writtenAt) as writtenAt=0 — still reconcilable, never spuriously protected", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    // Write a pre-S4-shaped ledger chunk (NO writtenAt map) with a delisted product 7.
    await store.put({ tenantId: "acme" }, MANIFEST_COLLECTION, ledgerChunkKey(0), { version: 1, at: new Date(1_000).toISOString(), entries: { "product:gid://shopify/Product/7": "old" } });
    await store.put({ tenantId: "acme" }, MANIFEST_COLLECTION, "manifest", { model: "fe", dimension: DIMENSION, purpose: "document", products: 1, at: new Date(1_000).toISOString(), ceiling: 50000 });
    await vector.upsert(catalogNamespace("acme"), [{ id: "product:gid://shopify/Product/7", vector: new Array(DIMENSION).fill(1), metadata: { kind: "product", productId: "gid://shopify/Product/7", contentHash: "old", title: "t-7" } }]);
    // The current catalog no longer lists 7 → it must be pruned (writtenAt defaults to 0 < fetchStartedAt).
    const catalog: CatalogSource = async (t) => ({ tenantId: t, brandName: "B", products: products([0]), policy: { returns: "", shipping: "" } });
    const [report] = await runCatalogIndex({ store, vector, model: fakeModel(), catalog, now: () => new Date(9_000) }, ["acme"], {});
    const ledger = await readCorpusLedger(store, "acme");
    expect([...ledger.keys()]).not.toContain("product:gid://shopify/Product/7");
    expect(report!.removed).toBe(1);
  });

  it("fix-round-1 (reviewer-reproduced 🔴): an UNRELATED commit must not reset a bystander id's writtenAt — " +
    "otherwise a later full reconcile can never prune it, even once genuinely delisted", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const model = fakeModel();

    // Seed products 0,1,2 at t=1000 — real ledger, real writtenAt=1000 for all three.
    const seed: CatalogSource = async (t) => ({ tenantId: t, brandName: "B", products: products([0, 1, 2]), policy: { returns: "", shipping: "" } });
    await runCatalogIndex({ store, vector, model, catalog: seed, now: () => new Date(1_000) }, ["acme"], {});

    // An UNRELATED targeted reconcile (webhook: products/create for a brand-new SKU 3) commits at t=6_000.
    // It touches ONLY product 3 — 0,1,2 are carried into the new ledger unchanged.
    const catalogById: CatalogByIdSource = async () => products([3]);
    const anyCatalog: CatalogSource = async (t) => ({ tenantId: t, brandName: "B", products: products([0, 1, 2]), policy: { returns: "", shipping: "" } });
    const r3 = await reconcileProducts(
      { store, vector, model, catalog: anyCatalog, catalogById, now: () => new Date(6_000) },
      "acme",
      ["gid://shopify/Product/3"],
      {},
    );
    expect(r3.outcome).toBe("indexed");

    // THE BUG (round-1): a uniform per-commit restamp would reset 0,1,2's writtenAt to 6_000 here too.
    // THE FIX: only product 3 (new this commit) gets 6_000; 0,1,2 (untouched) keep their prior 1_000.
    const tsAfterUnrelatedCommit = await readCorpusLedgerTimestamps(store, "acme");
    expect(tsAfterUnrelatedCommit.get(catalogRecordId("gid://shopify/Product/0"))).toBe(1_000);
    expect(tsAfterUnrelatedCommit.get(catalogRecordId("gid://shopify/Product/1"))).toBe(1_000);
    expect(tsAfterUnrelatedCommit.get(catalogRecordId("gid://shopify/Product/2"))).toBe(1_000);
    expect(tsAfterUnrelatedCommit.get(catalogRecordId("gid://shopify/Product/3"))).toBe(6_000);

    // A full reconcile now runs with fetchStartedAt=5_000 (BEFORE the unrelated commit's 6_000, exactly the
    // reviewer's repro ordering). Its fetch legitimately omits product 0 (the merchant genuinely deleted it)
    // and never saw product 3 either (a full crawl that predates that webhook, same as guard test 1).
    const afterDeleteCatalog: CatalogSource = async (t) => ({ tenantId: t, brandName: "B", products: products([1, 2]), policy: { returns: "", shipping: "" } });
    const [report] = await runCatalogIndex({ store, vector, model, catalog: afterDeleteCatalog, now: () => new Date(5_000) }, ["acme"], {});

    // Product 0 is genuinely stale (writtenAt=1_000 <= fetchStartedAt=5_000, UNCHANGED by the unrelated
    // commit) and MUST be pruned — this is the round-1 regression: with the uniform restamp, 0's writtenAt
    // had been bumped to 6_000 by the unrelated commit, so it read as "protected" and was NEVER deleted.
    expect(report!.removed).toBe(1);
    const ledgerAfter = await readCorpusLedger(store, "acme");
    expect([...ledgerAfter.keys()]).not.toContain(catalogRecordId("gid://shopify/Product/0"));
    // Product 3 (genuinely concurrently-created, writtenAt=6_000 > this run's fetchStartedAt=5_000) is still
    // correctly protected — the fix does not disable real concurrency protection, only the false positive.
    expect([...ledgerAfter.keys()]).toContain(catalogRecordId("gid://shopify/Product/3"));
  });
});
