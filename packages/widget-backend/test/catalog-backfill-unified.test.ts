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
import {
  chunkLedgerEntries,
  listLedgerChunkKeys,
  readCorpusLedger,
  readCorpusLedgerTimestamps,
  writeLedgerInTx,
} from "../src/jobs/catalog-ledger.js";

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

// Alpha with a changed tag (forces a new embed-text hash for product 1, so a run against this JSONL
// proceeds to the corpus WRITE step rather than short-circuiting on "nothing to embed, nothing stale").
const ALPHA_LINES_CHANGED = [
  JSON.stringify({
    id: "gid://shopify/Product/1",
    handle: "alpha-serum",
    title: "Alpha Serum",
    descriptionHtml: "<p>Great <b>hydrating</b> serum, now with retinol</p>",
    status: "ACTIVE",
    tags: ["hydrating", "vegan", "retinol"],
  }),
  JSON.stringify({
    id: "gid://shopify/ProductVariant/10",
    __parentId: "gid://shopify/Product/1",
    price: "19.99",
    availableForSale: true,
  }),
];
const CHANGED_JSONL = [...ALPHA_LINES_CHANGED, ...BETA_LINES].join("\n") + "\n";

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

  // Fix-round (review finding, Important) — the S4 §F concurrency guard `indexOneTenant` (catalog-index.ts)
  // has always had: a ledger id that is missing from this run's plan is only genuinely "stale" (safe to
  // delete) when its recorded `writtenAt` is at-or-before THIS run's fetch snapshot. An id written AFTER
  // that snapshot is a concurrent write (e.g. a webhook-driven `reconcileProducts` landing while this
  // bulk backfill was still in flight) and must be excluded from deletion and carried forward untouched.
  it("does not delete a product a concurrent webhook wrote after this run's fetch snapshot (S4 §F guard)", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const model = fakeModel();
    const ns = catalogNamespace("acme");

    // Seed: run 1 builds the corpus with products 1+2 at a fixed instant.
    const RUN1_AT = 1_000_000;
    const deps = makeDeps(fakeClient(TWO_PRODUCT_JSONL), { store, vector, model, now: () => new Date(RUN1_AT) });
    await runCatalogBackfill(deps, "acme");
    expect((await vector.query(ns, { text: "x", k: 10 })).map((h) => h.id).sort()).toEqual([
      "product:gid://shopify/Product/1",
      "product:gid://shopify/Product/2",
    ]);

    // Run 2's fetch snapshot (`fetchStartedAtMs`, captured at the TOP of `runCatalogBackfill`, before the
    // Bulk Operation even starts) is fixed at RUN2_FETCH_STARTED_AT. The "concurrent webhook write" below
    // is stamped strictly AFTER it, simulating a write that lands while run 2's bulk op is in flight.
    const RUN2_FETCH_STARTED_AT = 2_000_000;
    const CONCURRENT_WRITTEN_AT = 2_500_000;
    let concurrentWriteDone = false;

    const client2: ShopifyAdminClient = {
      graphql: vi.fn(),
      runBulkQuery: vi.fn(async () => ({ id: "gid://shopify/BulkOperation/2" })),
      pollBulk: vi.fn(async (): Promise<BulkStatus> => ({
        status: "COMPLETED",
        url: "https://storage.googleapis.com/bucket/result2.jsonl",
        objectCount: 4,
      })),
      downloadJsonl: vi.fn(async () => {
        // Simulate a webhook-driven `reconcileProducts` committing a BRAND-NEW product ("Product/3") to
        // the SAME shared store/vector while run 2's bulk operation is still "in flight" — after run 2's
        // fetch snapshot was taken, but before this run's own `syncEmbeddingCorpus` reads the ledger.
        // Product 3 is deliberately NOT part of run 2's own bulk export (`CHANGED_JSONL` below), so a
        // naive diff would see it as delisted.
        const priorChunkKeys = await listLedgerChunkKeys(store, "acme");
        const entries = await readCorpusLedger(store, "acme");
        const writtenAt = await readCorpusLedgerTimestamps(store, "acme");
        entries.set("product:gid://shopify/Product/3", "concurrent-hash");
        writtenAt.set("product:gid://shopify/Product/3", CONCURRENT_WRITTEN_AT);
        await vector.upsert(ns, [
          {
            id: "product:gid://shopify/Product/3",
            vector: [9, 9, 9, 9],
            metadata: { kind: "product", productId: "gid://shopify/Product/3", title: "Gamma Oil" },
          },
        ]);
        await store.tx({ tenantId: "acme" }, async (t) => {
          await writeLedgerInTx(
            t,
            chunkLedgerEntries(entries, new Date(CONCURRENT_WRITTEN_AT).toISOString(), writtenAt),
            priorChunkKeys,
          );
        });
        concurrentWriteDone = true;
        return CHANGED_JSONL; // product 1's embed text changed too, so run 2 proceeds to the WRITE step
      }),
    };

    const report2 = await runCatalogBackfill(
      { ...deps, createClient: () => client2, now: () => new Date(RUN2_FETCH_STARTED_AT) },
      "acme",
    );
    expect(concurrentWriteDone).toBe(true);
    expect(report2.outcome).toBe("backfilled"); // product 1's rich record changed (new tag)

    // The concurrently-written product must survive — NOT deleted as "stale" by run 2's diff.
    const hits = await vector.query(ns, { text: "x", k: 10 });
    expect(hits.map((h) => h.id).sort()).toEqual([
      "product:gid://shopify/Product/1",
      "product:gid://shopify/Product/2",
      "product:gid://shopify/Product/3",
    ]);

    const manifest = await store.get<CatalogManifest>({ tenantId: "acme" }, MANIFEST_COLLECTION, MANIFEST_KEY);
    expect(manifest!.products).toBe(3);
  });
});
