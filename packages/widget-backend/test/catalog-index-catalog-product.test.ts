import { describe, it, expect } from "vitest";
import {
  InMemoryRuntimeStore,
  createInMemoryVectorStore,
  createInMemoryCatalogProductStore,
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
  type CatalogSource,
  type CatalogByIdSource,
  type CatalogIndexDeps,
} from "../src/jobs/catalog-index.js";

// Task 6 (durable-catalog-sync) — persisting full product fields into the `catalog_product` store from
// BOTH the full-crawl (indexOneTenant, via runCatalogIndex) and the targeted webhook reconcile
// (reconcileProducts) paths. This is a NEW store independent of the vector corpus / ProductFactsPort: it
// carries the full renderable/administrative record (title, handle, variants w/ boolean
// availableForSale, images, status, contentHash) rather than just the semantic embed text or the
// volatile price/availability money-facts.

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

const P = (id: string, title: string, price = "$10"): Product => ({
  id,
  title,
  description: `${title} description`,
  price,
  tags: [title, "tag2"],
  availableForSale: true,
  handle: title.toLowerCase(),
  variantId: `${id}/variant/1`,
  imageUrl: "https://cdn.shopify.com/img.jpg",
});
const A = P("gid://shopify/Product/1", "alpha");
const B = P("gid://shopify/Product/2", "beta");

const fullCatalog =
  (ps: Product[]): CatalogSource =>
  async (t): Promise<GroundingContext> => ({
    tenantId: t,
    brandName: "Acme",
    products: ps,
    policy: { returns: "", shipping: "" },
  });

describe("Task 6 — catalog_product durable store persisted from index + reconcile", () => {
  it("indexOneTenant (full path, via runCatalogIndex) upserts full fields to catalog_product on every fetch", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const model = fakeModel();
    const catalogProduct = createInMemoryCatalogProductStore();

    const [r] = await runCatalogIndex(
      { store, vector, model, catalog: fullCatalog([A, B]), catalogProduct },
      ["acme"],
    );
    expect(r!.outcome).toBe("indexed");

    const rows = await catalogProduct.getMany("acme", [A.id, B.id]);
    expect(rows.map((x) => x.productId).sort()).toEqual([A.id, B.id]);
    const alpha = rows.find((x) => x.productId === A.id)!;
    expect(alpha.title).toBe("alpha");
    expect(alpha.handle).toBe("alpha");
    expect(alpha.status).toBe("active");
    expect(alpha.contentHash).toBeDefined();
    expect(alpha.variants).toHaveLength(1);
    expect(alpha.variants[0]!.availableForSale).toBe(true);
    expect(typeof alpha.variants[0]!.availableForSale).toBe("boolean");
  });

  it("a full re-index with an unchanged embed text still refreshes catalog_product (price/variant change)", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const model = fakeModel();
    const catalogProduct = createInMemoryCatalogProductStore();

    await runCatalogIndex({ store, vector, model, catalog: fullCatalog([A]), catalogProduct }, ["acme"]);
    const before = (await catalogProduct.getMany("acme", [A.id]))[0]!;

    // Same title/tags/description (so the embed text and its contentHash are IDENTICAL — the vector
    // corpus would short-circuit and re-embed nothing) but the price changed.
    const Ax = { ...A, price: "$99" };
    await runCatalogIndex({ store, vector, model, catalog: fullCatalog([Ax]), catalogProduct }, ["acme"]);
    const after = (await catalogProduct.getMany("acme", [A.id]))[0]!;

    expect(after.variants[0]!.price).toBe("$99");
    expect(after.variants[0]!.price).not.toBe(before.variants[0]!.price);
  });

  it("reconcileProducts upserts full fields to catalog_product and tombstones delisted", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const model = fakeModel();
    const catalogProduct = createInMemoryCatalogProductStore();
    const deps: CatalogIndexDeps = { store, vector, model, catalog: fullCatalog([A, B]), catalogProduct };

    // Seed a manifest first so reconcileProducts takes the TARGETED path (a manifest + catalogById +
    // valid ids are all required, else it falls back to a full crawl — see reconcileProducts's guard).
    await runCatalogIndex(deps, ["acme"]);

    // gid .../1 (A) still resolves; gid .../2 (B) no longer does — simulating a delisted product.
    const catalogById: CatalogByIdSource = async (_t, ids) => [A].filter((p) => ids.includes(p.id));

    const r = await reconcileProducts({ ...deps, catalogById }, "acme", [A.id, B.id], { reason: "product" });
    expect(r.outcome).toBe("indexed");

    expect((await catalogProduct.getMany("acme", [A.id]))[0]!.title).toBeDefined();
    expect(await catalogProduct.getMany("acme", [B.id])).toEqual([]); // tombstoned
  });

  it("a catalog_product store failure is fail-safe: the vector index still completes", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const model = fakeModel();
    const catalogProduct = {
      ...createInMemoryCatalogProductStore(),
      async upsertMany(): Promise<void> {
        throw new Error("catalog_product store down");
      },
    };

    const [r] = await runCatalogIndex(
      { store, vector, model, catalog: fullCatalog([A]), catalogProduct },
      ["acme"],
    );
    expect(r!.outcome).toBe("indexed"); // the primary vector index is unaffected by the secondary failure
  });
});
