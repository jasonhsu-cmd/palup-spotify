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
import { runCatalogIndex, catalogNamespace, MANIFEST_COLLECTION, type CatalogSource } from "../src/jobs/catalog-index.js";
import { readCorpusLedger, ledgerChunkKey } from "../src/jobs/catalog-ledger.js";

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
});
