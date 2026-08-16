import { describe, it, expect } from "vitest";
import {
  createInMemoryVectorStore,
  InMemoryRuntimeStore,
  requireEmbedAlignment,
  requireEmbedInputs,
  type EmbedRequest,
  type EmbedResponse,
  type GroundingContext,
  type ModelPort,
  type Product,
} from "@palup/platform-ports";
import { MAX_INDEXED_PRODUCTS, runCatalogIndex, type CatalogSource } from "../src/jobs/catalog-index.js";
import {
  MAX_CATALOG_PAGES,
  MAX_CATALOG_PRODUCTS,
  MAX_INDEX_CATALOG_PAGES,
  STOREFRONT_PAGE_SIZE,
  storefrontFetch,
} from "../src/shopify-grounding.js";

// S2 Task 4 — raise the INDEX-side ceiling to ~50k, decoupled from serving's fetch ceiling, without
// touching serving's per-turn fetch (which still uses MAX_CATALOG_PRODUCTS / MAX_CATALOG_PAGES).

describe("S2 index scale", () => {
  it("indexes up to 50000 products, decoupled from serving's 1000 fetch ceiling", () => {
    expect(MAX_INDEXED_PRODUCTS).toBe(50000);
    expect(MAX_CATALOG_PRODUCTS).toBe(1000); // serving's per-turn getContext ceiling is UNCHANGED
    expect(MAX_INDEXED_PRODUCTS).toBeGreaterThan(MAX_CATALOG_PRODUCTS);
  });

  it("the index-fetch can page the whole 50k, separate from serving's 4-page cap", () => {
    expect(MAX_CATALOG_PAGES).toBe(4); // serving per-turn: unchanged
    expect(MAX_INDEX_CATALOG_PAGES).toBe(MAX_INDEXED_PRODUCTS / STOREFRONT_PAGE_SIZE); // 200
  });

  // ── the index path actually accepts a catalog bigger than serving could ever fetch per-turn ────────

  function fakeEmbedder(dimension = 4): ModelPort {
    return {
      async complete() {
        return { text: "ok", model: "fake-embed-4d" };
      },
      async embed(req: EmbedRequest): Promise<EmbedResponse> {
        requireEmbedInputs(req);
        const vectors = req.texts.map((t) => {
          const v = new Array<number>(dimension).fill(0);
          for (let i = 0; i < t.length; i++) v[i % dimension] = (v[i % dimension] ?? 0) + t.charCodeAt(i);
          return v;
        });
        const res: EmbedResponse = {
          vectors,
          dimension,
          model: "fake-embed-4d",
          purpose: req.purpose,
          usage: { inputTokens: req.texts.join(" ").length },
        };
        requireEmbedAlignment(req, res);
        return res;
      },
    };
  }

  const product = (i: number): Product => ({
    id: `gid://shopify/Product/${i}`,
    title: `Product ${i}`,
    description: "a description",
    price: "$10",
    tags: ["tag"],
  });

  it("indexes a catalog above serving's 1000-product ceiling via the index path (no ceiling-exceeded)", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const model = fakeEmbedder();
    const tenantId = "big-co";
    const products = Array.from({ length: 1500 }, (_, i) => product(i));
    const catalog: CatalogSource = async (t): Promise<GroundingContext | undefined> =>
      t === tenantId ? { tenantId: t, brandName: "Big Co", products, policy: { returns: "30 days", shipping: "free" } } : undefined;

    const reports = await runCatalogIndex({ store, vector, model, catalog }, [tenantId]);

    expect(reports[0]!.outcome).toBe("indexed");
    expect(reports[0]!.products).toBe(1500);
    expect(reports[0]!.products).toBeGreaterThan(MAX_CATALOG_PRODUCTS); // above serving's own fetch ceiling
  });

  // ── serving's per-turn fetch cap is UNCHANGED: still refuses anything past 4 pages / 1000 products ──

  it("serving's storefrontFetch (default maxPages) still refuses a catalog over its 4-page cap", async () => {
    let cursor = 0;
    const endlessFetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          shop: { name: "Acme", refundPolicy: { body: "" }, shippingPolicy: { body: "" } },
          products: {
            nodes: [
              {
                id: `gid://shopify/Product/${cursor}`,
                title: "t",
                description: "d",
                priceRange: { minVariantPrice: { amount: "1.00", currencyCode: "USD" } },
              },
            ],
            pageInfo: { hasNextPage: true, endCursor: `c${++cursor}` },
          },
        },
      }),
    })) as unknown as typeof globalThis.fetch;

    // No maxPages override — this is exactly the default the serving path (model.ts's getContext) uses.
    const servingFetch = storefrontFetch(endlessFetch, { log: () => {} });

    await expect(servingFetch({ shopDomain: "acme.myshopify.com", accessToken: "shptok_secret" })).rejects.toThrow(
      /exceeds the supported size/,
    );
  });
});
