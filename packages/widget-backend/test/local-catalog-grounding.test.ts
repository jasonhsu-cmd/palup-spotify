import { describe, it, expect } from "vitest";
import {
  createInMemoryCatalogProductStore,
  createInMemoryProductFactsStore,
  createInMemoryStoreProfileStore,
  type CatalogProductRecord,
} from "@palup/platform-ports";
import {
  createLocalCatalogGroundingPort,
  mapCatalogRecordToProduct,
  LocalCatalogCeilingExceededError,
} from "../src/local-catalog-grounding.js";
import { MAX_CATALOG_PRODUCTS } from "../src/shopify-grounding.js";

const record = (overrides: Partial<CatalogProductRecord> = {}): CatalogProductRecord => ({
  productId: "gid://shopify/Product/1",
  handle: "widget",
  title: "Widget",
  status: "active",
  variants: [{ variantId: "gid://shopify/ProductVariant/1", price: "$9", availableForSale: true }],
  contentHash: "h1",
  syncedAt: "2026-08-01T00:00:00.000Z",
  ...overrides,
});

describe("createLocalCatalogGroundingPort — durability invariant (§3)", () => {
  it("serves the full catalog from local stores even when store_profile THROWS", async () => {
    const catalogProduct = createInMemoryCatalogProductStore();
    await catalogProduct.upsertMany("t1", [
      record({ productId: "gid://shopify/Product/1", handle: "widget-1", title: "Widget One" }),
      record({
        productId: "gid://shopify/Product/2",
        handle: "widget-2",
        title: "Widget Two",
        variants: [{ variantId: "gid://shopify/ProductVariant/2", price: "$5" }],
      }),
    ]);
    const productFacts = createInMemoryProductFactsStore();
    await productFacts.upsertMany("t1", [{ productId: "gid://shopify/Product/1", price: "$10", availableForSale: true }]);

    const throwingStoreProfile = {
      get: async () => {
        throw new Error("store_profile is down");
      },
    };

    const grounding = createLocalCatalogGroundingPort({
      catalogProduct,
      productFacts,
      storeProfile: throwingStoreProfile,
    });
    const ctx = await grounding.getContext("t1");

    // PRODUCTS survive the store_profile outage in full — the durability invariant.
    expect(ctx.products.length).toBe(2);
    const one = ctx.products.find((p) => p.id === "gid://shopify/Product/1")!;
    expect(one.price).toBe("$10"); // fresh product_facts price, not the $9 variant copy
    const two = ctx.products.find((p) => p.id === "gid://shopify/Product/2")!;
    expect(two.price).toBe("$5"); // no fact yet -> falls back to the variant copy

    // Brand/policy degrade to the neutral default rather than the whole context failing.
    expect(ctx.brandName).toBe("this store");
    expect(ctx.policy).toEqual({ returns: "", shipping: "" });
  });

  // unified-cutover-cleanup (2026-08-24): getShell ALWAYS reads the local `store_profile` store — the
  // `unifiedLocalShell` flag and the `shellSource` fallback it used to gate are gone. Full coverage of the
  // happy path / missing profile / store_profile error cases lives in local-catalog-grounding-shell.test.ts.
  it("getShell reads store_profile", async () => {
    const catalogProduct = createInMemoryCatalogProductStore();
    const productFacts = createInMemoryProductFactsStore();
    const storeProfile = createInMemoryStoreProfileStore();
    await storeProfile.put("t1", { brandName: "Acme", policy: { returns: "30d", shipping: "free" } });
    const grounding = createLocalCatalogGroundingPort({ catalogProduct, productFacts, storeProfile });
    const shell = await grounding.getShell("t1");
    expect(shell).toEqual({ tenantId: "t1", brandName: "Acme", policy: { returns: "30d", shipping: "free" } });
  });

  // Coordinator review fix #1: getShell must degrade symmetrically with getContext, not throw. Called
  // DIRECTLY on the local port here (not through createCachingGroundingPort's own getShell try/catch), so
  // this proves the local port itself is fail-closed, independent of any caller-side safety net.
  it("getShell degrades to the SAME neutral default as getContext when store_profile has no record (called directly)", async () => {
    const catalogProduct = createInMemoryCatalogProductStore();
    const productFacts = createInMemoryProductFactsStore();
    const storeProfile = createInMemoryStoreProfileStore();
    const grounding = createLocalCatalogGroundingPort({ catalogProduct, productFacts, storeProfile });
    const shell = await grounding.getShell("t1");
    expect(shell).toEqual({ tenantId: "t1", brandName: "this store", policy: { returns: "", shipping: "" } });
  });

  it("getContext THROWS past the MAX_CATALOG_PRODUCTS ceiling (no silent truncation, NN#5)", async () => {
    const catalogProduct = createInMemoryCatalogProductStore();
    const many: CatalogProductRecord[] = [];
    for (let i = 0; i < MAX_CATALOG_PRODUCTS + 1; i++) {
      many.push(record({ productId: `gid://shopify/Product/${i}`, handle: `p-${i}`, title: `P${i}` }));
    }
    await catalogProduct.upsertMany("big", many);
    const productFacts = createInMemoryProductFactsStore();
    const storeProfile = createInMemoryStoreProfileStore();
    const grounding = createLocalCatalogGroundingPort({ catalogProduct, productFacts, storeProfile });
    await expect(grounding.getContext("big")).rejects.toBeInstanceOf(LocalCatalogCeilingExceededError);
  });
});

describe("mapCatalogRecordToProduct — CatalogProductRecord + ProductFact -> Product", () => {
  it("price/availableForSale come from the fact when present, overriding the variant copy", () => {
    const r = record({
      variants: [{ variantId: "v1", price: "$9", availableForSale: false }],
      descriptionHtml: "<p>Nice</p>",
      descriptionText: "Nice",
      tags: ["a", "b"],
      featuredImageUrl: "https://cdn.shopify.com/x.jpg",
    });
    const fact = { productId: r.productId, price: "$7", availableForSale: true };
    const p = mapCatalogRecordToProduct(r, fact);
    expect(p).toMatchObject({
      id: "gid://shopify/Product/1",
      title: "Widget",
      description: "Nice",
      price: "$7",
      availableForSale: true,
      variantId: "v1",
      imageUrl: "https://cdn.shopify.com/x.jpg",
      handle: "widget",
      tags: ["a", "b"],
    });
  });

  it("falls back to the variant copy when no fact exists yet", () => {
    const r = record({ variants: [{ variantId: "v1", price: "$9", availableForSale: true }] });
    const p = mapCatalogRecordToProduct(r, undefined);
    expect(p.price).toBe("$9");
    expect(p.availableForSale).toBe(true);
  });

  it("a product with zero variants and no fact yields an empty price string, never undefined/invented", () => {
    const r = record({ variants: [] });
    const p = mapCatalogRecordToProduct(r, undefined);
    expect(p.price).toBe("");
    expect(p.availableForSale).toBeUndefined();
  });
});

describe("createLocalCatalogGroundingPort — getProductsByIds (bounded by-id fetch)", () => {
  it("hydrates the named ids from local stores; unknown ids are simply omitted", async () => {
    const catalogProduct = createInMemoryCatalogProductStore();
    await catalogProduct.upsertMany("t1", [record({ productId: "gid://shopify/Product/1" })]);
    const productFacts = createInMemoryProductFactsStore();
    await productFacts.upsertMany("t1", [{ productId: "gid://shopify/Product/1", price: "$11" }]);
    const storeProfile = createInMemoryStoreProfileStore();
    const grounding = createLocalCatalogGroundingPort({ catalogProduct, productFacts, storeProfile });

    const products = await grounding.getProductsByIds("t1", ["gid://shopify/Product/1", "gid://shopify/Product/missing"]);
    expect(products.length).toBe(1);
    expect(products[0].price).toBe("$11");
  });

  it("an empty id list short-circuits to [] with no store calls", async () => {
    const catalogProduct = createInMemoryCatalogProductStore();
    const productFacts = createInMemoryProductFactsStore();
    const storeProfile = createInMemoryStoreProfileStore();
    const grounding = createLocalCatalogGroundingPort({ catalogProduct, productFacts, storeProfile });
    expect(await grounding.getProductsByIds("t1", [])).toEqual([]);
  });
});
