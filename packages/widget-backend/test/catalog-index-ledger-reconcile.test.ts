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
import { readCorpusLedger } from "../src/jobs/catalog-ledger.js";

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

  it('GREP-GUARD: indexOneTenant/writeManifestAndAudit contain no `query(...{ text: "" })` enumerate', () => {
    const src = readFileSync(fileURLToPath(new URL("../src/jobs/catalog-index.ts", import.meta.url)), "utf8");
    // The reconcile path must never re-introduce the ANN-unsafe enumerate. `runCatalogClear` (the erase
    // path) is out of this guard's scope — it is exercised only on the brute-force store.
    const reconcileRegion = src.slice(src.indexOf("async function indexOneTenant"), src.indexOf("export async function runCatalogClear"));
    expect(reconcileRegion).not.toMatch(/\.query\([^)]*text\s*:\s*""/);
  });
});
