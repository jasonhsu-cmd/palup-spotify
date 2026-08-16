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
import { reconcileByReason, catalogRecordId, runCatalogIndex, type CatalogByIdSource, type CatalogSource } from "../src/jobs/catalog-index.js";

// S3 §C fix round 1 (coverage gap) — `reconcileByReason` is the composition root's routing decision, now a
// named export so it is unit-testable independent of Fastify/env wiring (server.ts just calls it).

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

describe("S3 §C — reconcileByReason routing", () => {
  it('reason:"inventory" with no ids is a REAL no-op: zero calls to store, vector, or model', async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const model = fakeModel();
    const storeGetSpy = vi.spyOn(store, "get");
    const storeTxSpy = vi.spyOn(store, "tx");
    const vectorUpsertSpy = vi.spyOn(vector, "upsert");
    const vectorDeleteSpy = vi.spyOn(vector, "deleteById");
    const vectorQuerySpy = vi.spyOn(vector, "query");
    const modelEmbedSpy = vi.spyOn(model, "embed");
    const catalogSpy = vi.fn(fullCatalog([A, B, C]));

    await reconcileByReason({ store, vector, model, catalog: catalogSpy }, "acme", { reason: "inventory" });

    expect(storeGetSpy).not.toHaveBeenCalled();
    expect(storeTxSpy).not.toHaveBeenCalled();
    expect(vectorUpsertSpy).not.toHaveBeenCalled();
    expect(vectorDeleteSpy).not.toHaveBeenCalled();
    expect(vectorQuerySpy).not.toHaveBeenCalled();
    expect(modelEmbedSpy).not.toHaveBeenCalled();
    expect(catalogSpy).not.toHaveBeenCalled();
  });

  it('reason:"product" + productIds routes to the TARGETED reconcileProducts (no whole-catalog fetch)', async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const model = fakeModel();
    await runCatalogIndex({ store, vector, model, catalog: fullCatalog([A, B, C]) }, ["acme"]);

    const upsertSpy = vi.spyOn(vector, "upsert");
    const Bx = P(B.id, "beta-updated", "$12");
    const catalogById: CatalogByIdSource = async () => [Bx];
    const catalogSpy = vi.fn(fullCatalog([A, Bx, C])); // the FULL fetcher — must NOT be called

    await reconcileByReason({ store, vector, model, catalog: catalogSpy, catalogById }, "acme", { productIds: [B.id], reason: "product" });

    const upsertedIds = upsertSpy.mock.calls.flatMap(([, recs]) => recs.map((x) => x.id));
    expect(upsertedIds).toEqual([catalogRecordId(B.id)]);
    expect(catalogSpy).not.toHaveBeenCalled(); // targeted, not the whole-catalog path
  });

  it('reason:"full" routes to the whole-catalog runCatalogIndex even when productIds are present', async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const model = fakeModel();
    await runCatalogIndex({ store, vector, model, catalog: fullCatalog([A, B, C]) }, ["acme"]);

    const catalogSpy = vi.fn(fullCatalog([A, B, C]));
    const catalogById: CatalogByIdSource = vi.fn(async () => [B]);

    await reconcileByReason({ store, vector, model, catalog: catalogSpy, catalogById }, "acme", { productIds: [B.id], reason: "full" });

    expect(catalogSpy).toHaveBeenCalled(); // the whole-catalog fetcher WAS used
    expect(catalogById).not.toHaveBeenCalled(); // the by-id path was NOT taken
  });

  it("absent opts routes to the whole-catalog runCatalogIndex (the backstop path)", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const model = fakeModel();
    const catalogSpy = vi.fn(fullCatalog([A, B, C]));

    await reconcileByReason({ store, vector, model, catalog: catalogSpy }, "acme", undefined);

    expect(catalogSpy).toHaveBeenCalled();
  });
});
