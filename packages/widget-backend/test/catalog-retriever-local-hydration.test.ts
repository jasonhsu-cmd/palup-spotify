import { describe, expect, it } from "vitest";
import {
  createInMemoryVectorStore,
  InMemoryRuntimeStore,
  createInMemoryCatalogProductStore,
  createInMemoryProductFactsStore,
  type CatalogProductRecord,
  type ModelPort,
} from "@palup/platform-ports";
import { createCatalogRetriever } from "../src/catalog-retriever.js";
import { createLocalCatalogGroundingPort } from "../src/local-catalog-grounding.js";
import { runCatalogIndex, catalogNamespace } from "../src/jobs/catalog-index.js";

// Task 8b (durable-catalog-sync, spec §4.1) — RETRIEVER-seam hydration: for a backfilled tenant, each
// retrieved hit's render `metadata` is enriched with DESCRIPTIVE fields (description, tags) read from the
// tenant's own local `catalog_product` (+ `product_facts`) corpus — the SAME `GroundingPort.getProductsByIds`
// Task 8 already built (local-catalog-grounding.ts), reused here rather than a second local-serving path.
//
// WHAT THIS FILE DOES NOT CLAIM. It exercises the retriever's OWN hydration mechanics — the gating on
// `hasLocalCatalog`, that price/availability never cross this seam, and fail-open on a hydration error. The
// RENDER path (does the brain actually surface the hydrated fields in the prompt, and does price still come
// only from the A1b `product_facts` overlay) is covered in
// widget-brain/test/catalog-retrieval-local-hydration.test.ts.

const TENANT = "acme";

function fakeEmbed(): ModelPort {
  return {
    async complete() {
      throw new Error("unused");
    },
    async embed(req) {
      // every text ranks the same — order doesn't matter for these tests, just that hits resolve.
      return { vectors: req.texts.map(() => [1, 0, 0]), dimension: 3, model: "fake-embed-3d", purpose: req.purpose };
    },
  };
}

const record = (overrides: Partial<CatalogProductRecord> = {}): CatalogProductRecord => ({
  productId: "p1",
  handle: "glow-serum",
  title: "Glow Serum",
  status: "active",
  variants: [{ variantId: "v1", price: "$40", availableForSale: true }],
  contentHash: "h1",
  syncedAt: "2026-08-01T00:00:00.000Z",
  ...overrides,
});

/** Build a retriever wired against a real vector corpus (index job) + a real local hydration port, so
 *  this test exercises the same seam server.ts wires, not a hand-rolled stand-in. */
async function setup(opts: {
  hasLocalCatalog: (tenantId: string) => Promise<boolean>;
  catalogRecords?: CatalogProductRecord[];
  corpusProducts?: { id: string; title: string }[];
}) {
  const vector = createInMemoryVectorStore();
  const store = new InMemoryRuntimeStore();
  const corpusProducts = opts.corpusProducts ?? [{ id: "p1", title: "Glow Serum" }];
  const catalog = async () => ({
    tenantId: TENANT,
    brandName: "Acme",
    policy: { returns: "r", shipping: "s" },
    products: corpusProducts.map((p) => ({ id: p.id, title: p.title, description: "", price: "$0" })),
  });
  await runCatalogIndex({ store, vector, model: fakeEmbed(), catalog }, [TENANT]);

  const catalogProduct = createInMemoryCatalogProductStore();
  if (opts.catalogRecords) await catalogProduct.upsertMany(TENANT, opts.catalogRecords);
  const productFacts = createInMemoryProductFactsStore();
  const local = createLocalCatalogGroundingPort({
    catalogProduct,
    productFacts,
    shellSource: { getShell: async () => ({ tenantId: TENANT, brandName: "Acme", policy: { returns: "r", shipping: "s" } }) },
  });

  let getProductsByIdsCalls = 0;
  const retriever = createCatalogRetriever({
    store,
    vector,
    model: fakeEmbed(),
    localHydration: {
      hasLocalCatalog: opts.hasLocalCatalog,
      getProductsByIds: async (tenantId, ids) => {
        getProductsByIdsCalls++;
        return local.getProductsByIds(tenantId, ids);
      },
    },
  });
  return { retriever, getCalls: () => getProductsByIdsCalls };
}

describe("Task 8b — createCatalogRetriever's localHydration seam", () => {
  it("AC1: enriches a hit's metadata with description + tags from catalog_product when the tenant is backfilled", async () => {
    const { retriever } = await setup({
      hasLocalCatalog: async () => true,
      catalogRecords: [
        record({
          descriptionText: "A vitamin C serum with hyaluronic acid, for dull and uneven skin tone.",
          tags: ["vitamin-c", "hydrating"],
        }),
      ],
    });
    const { hits } = await retriever.retrieve({ tenantId: TENANT, query: "serum", k: 5 });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.metadata).toMatchObject({
      title: "Glow Serum", // untouched, still the corpus's own render field
      description: "A vitamin C serum with hyaluronic acid, for dull and uneven skin tone.",
      tags: ["vitamin-c", "hydrating"],
    });
  });

  it("NN#1: never merges price/availability into a hit's metadata, even though the local port's own Product carries them", async () => {
    const { retriever } = await setup({
      hasLocalCatalog: async () => true,
      catalogRecords: [record({ variants: [{ variantId: "v1", price: "$999", availableForSale: true }] })],
    });
    const { hits } = await retriever.retrieve({ tenantId: TENANT, query: "serum", k: 5 });
    expect(hits[0]!.metadata).not.toHaveProperty("price");
    expect(hits[0]!.metadata).not.toHaveProperty("availableForSale");
    expect(hits[0]!.metadata).not.toHaveProperty("priceConfirmed");
  });

  it("AC2/AC4: a NON-backfilled tenant (hasLocalCatalog resolves false) is left byte-identical — no hydration call at all", async () => {
    const { retriever, getCalls } = await setup({
      hasLocalCatalog: async () => false,
      catalogRecords: [record({ descriptionText: "should never be read" })],
    });
    const { hits } = await retriever.retrieve({ tenantId: TENANT, query: "serum", k: 5 });
    expect(hits[0]!.metadata).toMatchObject({ title: "Glow Serum" }); // the corpus's own render field, untouched
    expect(hits[0]!.metadata).not.toHaveProperty("description"); // no hydration was applied
    expect(hits[0]!.metadata).not.toHaveProperty("tags");
    expect(getCalls()).toBe(0); // the local hydration source is never even consulted
  });

  it("no localHydration dep supplied at all is byte-identical to before this task (flag fully off)", async () => {
    const vector = createInMemoryVectorStore();
    const store = new InMemoryRuntimeStore();
    const catalog = async () => ({
      tenantId: TENANT,
      brandName: "Acme",
      policy: { returns: "r", shipping: "s" },
      products: [{ id: "p1", title: "Glow Serum", description: "", price: "$0" }],
    });
    await runCatalogIndex({ store, vector, model: fakeEmbed(), catalog }, [TENANT]);
    const retriever = createCatalogRetriever({ store, vector, model: fakeEmbed() });
    const { hits } = await retriever.retrieve({ tenantId: TENANT, query: "serum", k: 5 });
    expect(hits[0]!.metadata).toMatchObject({ title: "Glow Serum" });
    expect(hits[0]!.metadata).not.toHaveProperty("description");
    expect(hits[0]!.metadata).not.toHaveProperty("tags");
  });

  it("fails OPEN: a hydration error (getProductsByIds throws) never breaks the retrieval result", async () => {
    const vector = createInMemoryVectorStore();
    const store = new InMemoryRuntimeStore();
    const catalog = async () => ({
      tenantId: TENANT,
      brandName: "Acme",
      policy: { returns: "r", shipping: "s" },
      products: [{ id: "p1", title: "Glow Serum", description: "", price: "$0" }],
    });
    await runCatalogIndex({ store, vector, model: fakeEmbed(), catalog }, [TENANT]);
    const retriever = createCatalogRetriever({
      store,
      vector,
      model: fakeEmbed(),
      localHydration: {
        hasLocalCatalog: async () => true,
        getProductsByIds: async () => {
          throw new Error("local store unreachable");
        },
      },
    });
    const { hits } = await retriever.retrieve({ tenantId: TENANT, query: "serum", k: 5 });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.metadata).toMatchObject({ title: "Glow Serum" }); // degraded to metadata-only, not thrown
    expect(hits[0]!.metadata).not.toHaveProperty("description");
  });

  it("fails OPEN: hasLocalCatalog itself throwing never breaks the retrieval result", async () => {
    const { retriever } = await setup({
      hasLocalCatalog: async () => {
        throw new Error("db down");
      },
      catalogRecords: [record()],
    });
    const { hits } = await retriever.retrieve({ tenantId: TENANT, query: "serum", k: 5 });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.metadata).toMatchObject({ title: "Glow Serum" });
    expect(hits[0]!.metadata).not.toHaveProperty("description");
  });
});
