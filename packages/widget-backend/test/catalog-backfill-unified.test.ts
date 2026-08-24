import { describe, it, expect, vi } from "vitest";
import {
  InMemoryRuntimeStore,
  createInMemoryCatalogProductStore,
  createInMemoryProductFactsStore,
  createInMemoryVectorStore,
  createInMemoryStoreProfileStore,
  type EmbedRequest,
  type EmbedResponse,
  type ModelPort,
} from "@palup/platform-ports";
import type { ShopifyAdminClient, BulkStatus } from "../src/shopify-client.js";
import { runCatalogBackfill, type CatalogBackfillDeps } from "../src/jobs/catalog-backfill.js";
import { catalogNamespace, MANIFEST_COLLECTION, MANIFEST_KEY, type CatalogManifest } from "../src/jobs/catalog-index.js";

// Task 3 (credential-enrollment-unification) — the Admin/Bulk backfill (#439) writes `catalog_product` +
// `product_facts` but DELIBERATELY skips the pgvector embedding corpus and `store_profile`. This test file
// proves the unified pipeline: one Admin-path run now ALSO builds the corpus `catalog-retriever.ts` needs
// and persists brand/policy via `StoreProfilePort`.

const ALPHA_LINES = [
  JSON.stringify({
    id: "gid://shopify/Product/1",
    handle: "alpha-serum",
    title: "Alpha Serum",
    descriptionHtml: "<p>Great <b>hydrating</b> serum</p>",
    status: "ACTIVE",
    tags: ["hydrating", "vegan"],
  }),
  JSON.stringify({
    id: "gid://shopify/ProductVariant/10",
    __parentId: "gid://shopify/Product/1",
    price: "19.99",
    availableForSale: true,
  }),
];

const BETA_LINES = [
  JSON.stringify({
    id: "gid://shopify/Product/2",
    handle: "beta-cream",
    title: "Beta Cream",
    descriptionHtml: "<p>Soothing night cream</p>",
    status: "ACTIVE",
    tags: ["night"],
  }),
  JSON.stringify({
    id: "gid://shopify/ProductVariant/20",
    __parentId: "gid://shopify/Product/2",
    price: "9.99",
    availableForSale: true,
  }),
];

const TWO_PRODUCT_JSONL = [...ALPHA_LINES, ...BETA_LINES].join("\n") + "\n";

function fakeModel(): ModelPort & { embed: NonNullable<ModelPort["embed"]> } {
  return {
    async complete() {
      return { text: "ok", model: "fake-complete" };
    },
    embed: vi.fn(async (req: EmbedRequest): Promise<EmbedResponse> => ({
      vectors: req.texts.map((_, i) => [i + 1, 0, 0, 0]),
      dimension: 4,
      model: "fake-embed",
      purpose: req.purpose,
    })),
  };
}

function fakeClient(
  jsonl: string,
  opts: { graphqlImpl?: ShopifyAdminClient["graphql"] } = {},
): ShopifyAdminClient {
  return {
    graphql:
      opts.graphqlImpl ??
      (vi.fn(async () => ({
        data: {
          shop: {
            name: "Acme Skincare",
            shopPolicies: [
              { type: "REFUND_POLICY", body: "Returns within 30 days." },
              { type: "SHIPPING_POLICY", body: "Ships in 2-3 business days." },
            ],
          },
        },
      })) as unknown as ShopifyAdminClient["graphql"]),
    runBulkQuery: vi.fn(async () => ({ id: "gid://shopify/BulkOperation/1" })),
    pollBulk: vi.fn(async (): Promise<BulkStatus> => ({
      status: "COMPLETED",
      url: "https://storage.googleapis.com/bucket/result.jsonl",
      objectCount: 4,
    })),
    downloadJsonl: vi.fn(async () => jsonl),
  };
}

function makeDeps(client: ShopifyAdminClient, overrides: Partial<CatalogBackfillDeps> = {}): CatalogBackfillDeps {
  return {
    store: new InMemoryRuntimeStore(),
    catalogProduct: createInMemoryCatalogProductStore(),
    productFacts: createInMemoryProductFactsStore(),
    getFreshAdminToken: vi.fn(async () => "admin-tok"),
    shopDomainOf: vi.fn(async () => "acme.myshopify.com"),
    createClient: () => client,
    sleep: async () => {},
    ...overrides,
  };
}

describe("runCatalogBackfill — unified pipeline (Task 3)", () => {
  it("builds the pgvector embedding corpus under ${tenant}::catalog with a retriever-readable manifest", async () => {
    const client = fakeClient(TWO_PRODUCT_JSONL);
    const vector = createInMemoryVectorStore();
    const model = fakeModel();
    const deps = makeDeps(client, { vector, model });

    const report = await runCatalogBackfill(deps, "acme");
    expect(report.outcome).toBe("backfilled");

    // The corpus lives under the SAME namespace scheme catalog-index.ts uses.
    const ns = catalogNamespace("acme");
    const hits = await vector.query(ns, { text: "serum", k: 10 });
    expect(hits.length).toBe(2);
    const ids = hits.map((h) => h.id).sort();
    expect(ids).toEqual(["product:gid://shopify/Product/1", "product:gid://shopify/Product/2"]);

    // The manifest the retriever's own gate checks: purpose must be "document".
    const manifest = await deps.store.get<CatalogManifest>({ tenantId: "acme" }, MANIFEST_COLLECTION, MANIFEST_KEY);
    expect(manifest).toBeDefined();
    expect(manifest!.purpose).toBe("document");
    expect(manifest!.model).toBe("fake-embed");
    expect(manifest!.dimension).toBe(4);
    expect(manifest!.products).toBe(2);

    expect(model.embed).toHaveBeenCalledTimes(1);
  });

  it("persists store_profile (brand + policy) from a one-shot Admin shop/shopPolicies query", async () => {
    const client = fakeClient(TWO_PRODUCT_JSONL);
    const storeProfile = createInMemoryStoreProfileStore();
    const deps = makeDeps(client, { storeProfile });

    await runCatalogBackfill(deps, "acme");

    const profile = await storeProfile.get("acme");
    expect(profile).toEqual({
      brandName: "Acme Skincare",
      policy: {
        returns: "Returns within 30 days.",
        shipping: "Ships in 2-3 business days.",
      },
    });
  });

  it("a content-hash-unchanged re-run embeds ZERO products", async () => {
    const vector = createInMemoryVectorStore();
    const model = fakeModel();
    const deps = makeDeps(fakeClient(TWO_PRODUCT_JSONL), { vector, model });

    await runCatalogBackfill(deps, "acme");
    expect(model.embed).toHaveBeenCalledTimes(1);

    // Re-run against the SAME catalog content, with a fresh client (new bulk op, same JSONL) — mirrors
    // catalog-backfill.test.ts's own re-run pattern.
    const client2 = fakeClient(TWO_PRODUCT_JSONL);
    const embedSpy = model.embed as unknown as ReturnType<typeof vi.fn>;
    embedSpy.mockClear();

    const report2 = await runCatalogBackfill({ ...deps, createClient: () => client2 }, "acme");
    expect(report2.outcome).toBe("unchanged");
    expect(model.embed).not.toHaveBeenCalled();
  });

  it("omits embedding + store_profile work entirely when the optional deps are absent (byte-identical to #439)", async () => {
    const client = fakeClient(TWO_PRODUCT_JSONL);
    const deps = makeDeps(client); // no vector/model/storeProfile
    const report = await runCatalogBackfill(deps, "acme");
    expect(report.outcome).toBe("backfilled");
    // graphql() must not even be called when no storeProfile dep is wired (no gratuitous Admin call).
    expect(client.graphql).not.toHaveBeenCalled();
  });
});
