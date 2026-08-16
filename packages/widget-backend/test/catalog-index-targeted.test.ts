import { describe, it, expect, vi } from "vitest";
import {
  InMemoryRuntimeStore,
  createInMemoryVectorStore,
  createInMemoryProductFactsStore,
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
  type CatalogSource,
  type CatalogByIdSource,
} from "../src/jobs/catalog-index.js";
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
const P = (id: string, title: string, price = "$10"): Product => ({ id, title, description: `${title} d`, price, tags: [title], availableForSale: true });
const A = P("gid://shopify/Product/1", "alpha");
const B = P("gid://shopify/Product/2", "beta");
const C = P("gid://shopify/Product/3", "gamma");
const fullCatalog = (ps: Product[]): CatalogSource => async (t): Promise<GroundingContext> => ({ tenantId: t, brandName: "Acme", products: ps, policy: { returns: "", shipping: "" } });

describe("S3 §C — reconcileProducts touches ONLY the changed set", () => {
  it("upserts only the named product and leaves every other row untouched", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const model = fakeModel();
    await runCatalogIndex({ store, vector, model, catalog: fullCatalog([A, B, C]) }, ["acme"]);

    const upsertSpy = vi.spyOn(vector, "upsert");
    const Bx = P("gid://shopify/Product/2", "beta-updated", "$12");
    const catalogById: CatalogByIdSource = async () => [Bx];
    const facts = createInMemoryProductFactsStore();

    const r = await reconcileProducts({ store, vector, model, catalog: fullCatalog([A, Bx, C]), catalogById, productFacts: facts }, "acme", [B.id], {
      reason: "product",
    });

    expect(r.outcome).toBe("indexed");
    expect(r.embedded).toBe(1);
    const upsertedIds = upsertSpy.mock.calls.flatMap(([, recs]) => recs.map((x) => x.id));
    expect(upsertedIds).toEqual([catalogRecordId(B.id)]);
    // Ledger still has all three; B's hash changed.
    expect((await readCorpusLedger(store, "acme")).size).toBe(3);
    // ProductFacts refreshed for B only.
    expect((await facts.getMany("acme", [B.id]))[0]!.price).toBe("$12");
    expect(await facts.getMany("acme", [A.id])).toEqual([]);
  });

  it("a delisted id (not returned by fetch) is deleteById'd and dropped from the ledger, no whole-catalog crawl", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const model = fakeModel();
    await runCatalogIndex({ store, vector, model, catalog: fullCatalog([A, B, C]) }, ["acme"]);

    const deleteSpy = vi.spyOn(vector, "deleteById");
    const catalogById: CatalogByIdSource = async () => []; // C resolved to nothing => delisted
    const catalogSpy = vi.fn(fullCatalog([A, B]));

    const r = await reconcileProducts({ store, vector, model, catalog: catalogSpy, catalogById }, "acme", [C.id], { reason: "product" });

    expect(r.outcome).toBe("indexed");
    expect(r.removed).toBe(1);
    expect(deleteSpy.mock.calls.flatMap((c) => c[1])).toEqual([catalogRecordId(C.id)]);
    expect(catalogSpy).not.toHaveBeenCalled(); // NEVER fell back to a full crawl
    const ledger = await readCorpusLedger(store, "acme");
    expect([...ledger.keys()].sort()).toEqual([catalogRecordId(A.id), catalogRecordId(B.id)]);
  });

  it("with no manifest yet, falls back to a full reconcile (never a 1-product corpus)", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const model = fakeModel();
    const catalogById = vi.fn(async () => [B]);
    const r = await reconcileProducts({ store, vector, model, catalog: fullCatalog([A, B, C]), catalogById }, "acme", [B.id], { reason: "product" });
    expect(r.outcome).toBe("indexed");
    expect(r.products).toBe(3); // the whole catalog, not just B
    expect(catalogById).not.toHaveBeenCalled();
  });
});
