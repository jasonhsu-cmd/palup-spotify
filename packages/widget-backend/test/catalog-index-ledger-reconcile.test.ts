import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
  type VectorPort,
} from "@palup/platform-ports";
import { runCatalogIndex, catalogNamespace, catalogRecordId, type CatalogSource } from "../src/jobs/catalog-index.js";
import { LEDGER_CHUNK_SIZE, listLedgerChunkKeys, readCorpusLedger } from "../src/jobs/catalog-ledger.js";

function fakeModel(dimension = 4, model = "fake-embed-4d"): ModelPort {
  return {
    async complete() {
      return { text: "ok", model };
    },
    async embed(req: EmbedRequest): Promise<EmbedResponse> {
      requireEmbedInputs(req);
      const vectors = req.texts.map((t) => {
        const v = new Array(dimension).fill(0);
        for (let i = 0; i < t.length; i++) v[i % dimension] += t.charCodeAt(i) % 7;
        return v;
      });
      return { vectors, model, dimension, purpose: req.purpose };
    },
  };
}

function product(id: string, title: string): Product {
  return { id, title, description: `${title} desc`, price: "$10", tags: [title], availableForSale: true };
}

function catalogOf(products: Product[]): CatalogSource {
  return async (tenantId): Promise<GroundingContext | undefined> => ({
    tenantId,
    brandName: "Acme",
    products,
    policy: { returns: "", shipping: "" },
  });
}

const P1 = product("gid://shopify/Product/1", "alpha");
const P2 = product("gid://shopify/Product/2", "beta");
const P3 = product("gid://shopify/Product/3", "gamma");

describe("S3 §B — reconcile diffs the ledger (new/changed/stale), never enumerates the vector store", () => {
  it("first run (no ledger) indexes everything and writes a ledger; a clean re-run is unchanged (no spend)", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const model = fakeModel();
    const catalog = catalogOf([P1, P2]);

    const [r1] = await runCatalogIndex({ store, vector, model, catalog }, ["acme"]);
    expect(r1!.outcome).toBe("indexed");
    expect(r1!.embedded).toBe(2);
    expect((await readCorpusLedger(store, "acme")).size).toBe(2);

    const embedSpy = vi.spyOn(model, "embed");
    const [r2] = await runCatalogIndex({ store, vector, model, catalog }, ["acme"]);
    expect(r2!.outcome).toBe("unchanged");
    expect(embedSpy).not.toHaveBeenCalled();
  });

  it("a changed hash re-embeds ONLY that product; a delisted product is deleteById'd exactly once", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const model = fakeModel();
    await runCatalogIndex({ store, vector, model, catalog: catalogOf([P1, P2, P3]) }, ["acme"]);

    const deleteSpy = vi.spyOn(vector, "deleteById");
    const embedSpy = vi.spyOn(model, "embed");
    // P2 changed (new title => new embed text => new hash); P3 delisted; P1 unchanged.
    const P2b = product("gid://shopify/Product/2", "beta-renamed");
    const [r] = await runCatalogIndex({ store, vector, model, catalog: catalogOf([P1, P2b]) }, ["acme"]);

    expect(r!.outcome).toBe("indexed");
    expect(r!.embedded).toBe(1); // only P2b
    expect(r!.removed).toBe(1); // only P3
    const deletedIds = deleteSpy.mock.calls.flatMap((c) => c[1]);
    expect(deletedIds).toEqual([catalogRecordId(P3.id)]);
    const ledger = await readCorpusLedger(store, "acme");
    expect([...ledger.keys()].sort()).toEqual([catalogRecordId(P1.id), catalogRecordId(P2.id)]);
    // P1's hash unchanged, so embed was called once (for P2b) — no re-spend on P1.
    expect(embedSpy.mock.calls.flatMap((c) => c[0].texts)).toHaveLength(1);
  });

  it("no product in the reconcile calls vector.query with a text modality", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const querySpy = vi.spyOn(vector, "query");
    await runCatalogIndex({ store, vector, model: fakeModel(), catalog: catalogOf([P1, P2]) }, ["acme"]);
    await runCatalogIndex({ store, vector, model: fakeModel(), catalog: catalogOf([P1]) }, ["acme"]);
    const textQueries = querySpy.mock.calls.filter(([, q]) => typeof q.text === "string");
    expect(textQueries).toEqual([]);
  });

  it("FIX 1 (review round-1): --reindex prunes orphan ledger chunks, not just the diff content", async () => {
    // Repro: index enough products for >=2 ledger chunks, --reindex down to a size that needs only 1
    // chunk. The buggy code skipped fetching the REAL prior chunk keys on --reindex (`opts.reindex ? [] :
    // ...`), so writeLedgerInTx's prune list was empty and the old second chunk (`ledger:0001`) survived
    // with its stale ids — which the VERY NEXT normal reconcile would then read, treat as delisted, and
    // report a false `removed` count for a catalog that never shrank.
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const model = fakeModel();
    const catalogOfSize = (n: number): CatalogSource =>
      catalogOf(Array.from({ length: n }, (_, i) => product(`gid://shopify/Product/${i}`, `p${i}`)));

    // LEDGER_CHUNK_SIZE (10_000) + 2_000 spans 2 chunks.
    await runCatalogIndex({ store, vector, model, catalog: catalogOfSize(LEDGER_CHUNK_SIZE + 2_000) }, ["acme"], {});
    expect(await listLedgerChunkKeys(store, "acme")).toHaveLength(2);

    // --reindex down to a size that fits in ONE chunk.
    await runCatalogIndex({ store, vector, model, catalog: catalogOfSize(3_000) }, ["acme"], { reindex: true });
    expect(await listLedgerChunkKeys(store, "acme")).toHaveLength(1); // no orphan ledger:0001 chunk
    expect((await readCorpusLedger(store, "acme")).size).toBe(3_000); // not inflated by a leftover chunk

    // The VERY NEXT normal reconcile (same 3,000-product catalog, no --reindex) must see NO false stale.
    const [r] = await runCatalogIndex({ store, vector, model, catalog: catalogOfSize(3_000) }, ["acme"], {});
    expect(r!.outcome).toBe("unchanged");
    expect(r!.removed ?? 0).toBe(0);
  }, 30_000);

  it('GREP-GUARD: indexOneTenant/writeManifestAndAudit contain no `query(...{ text: "" })` enumerate', () => {
    const src = readFileSync(fileURLToPath(new URL("../src/jobs/catalog-index.ts", import.meta.url)), "utf8");
    // The reconcile path must never re-introduce the ANN-unsafe enumerate. `runCatalogClear` (the erase
    // path) is out of this guard's scope — it is exercised only on the brute-force store.
    const reconcileRegion = src.slice(src.indexOf("async function indexOneTenant"), src.indexOf("export async function runCatalogClear"));
    expect(reconcileRegion).not.toMatch(/\.query\([^)]*text\s*:\s*""/);
  });
});
