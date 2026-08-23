import { describe, it, expect } from "vitest";
import {
  createInMemoryCatalogProductStore,
  createInMemoryProductFactsStore,
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
  it("serves the full catalog from local stores even when the shell/Shopify source THROWS", async () => {
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

    const throwingShellSource = {
      getShell: async () => {
        throw new Error("Shopify is down");
      },
    };

    const grounding = createLocalCatalogGroundingPort({ catalogProduct, productFacts, shellSource: throwingShellSource });
    const ctx = await grounding.getContext("t1");

    // PRODUCTS survive the Shopify outage in full — the durability invariant.
    expect(ctx.products.length).toBe(2);
    const one = ctx.products.find((p) => p.id === "gid://shopify/Product/1")!;
    expect(one.price).toBe("$10"); // fresh product_facts price, not the $9 variant copy
    const two = ctx.products.find((p) => p.id === "gid://shopify/Product/2")!;
    expect(two.price).toBe("$5"); // no fact yet -> falls back to the variant copy

    // Brand/policy degrade to the neutral default rather than the whole context failing.
    expect(ctx.brandName).toBe("this store");
    expect(ctx.policy).toEqual({ returns: "", shipping: "" });
  });

  it("getShell delegates to the shell source untouched (no catalog/product dependency)", async () => {
    const catalogProduct = createInMemoryCatalogProductStore();
    const productFacts = createInMemoryProductFactsStore();
    const shellSource = { getShell: async () => ({ tenantId: "t1", brandName: "Acme", policy: { returns: "30d", shipping: "free" } }) };
    const grounding = createLocalCatalogGroundingPort({ catalogProduct, productFacts, shellSource });
    const shell = await grounding.getShell("t1");
    expect(shell).toEqual({ tenantId: "t1", brandName: "Acme", policy: { returns: "30d", shipping: "free" } });
  });

  it("getContext THROWS past the MAX_CATALOG_PRODUCTS ceiling (no silent truncation, NN#5)", async () => {
    const catalogProduct = createInMemoryCatalogProductStore();
    const many: CatalogProductRecord[] = [];
    for (let i = 0; i < MAX_CATALOG_PRODUCTS + 1; i++) {
      many.push(record({ productId: `gid://shopify/Product/${i}`, handle: `p-${i}`, title: `P${i}` }));
    }
    await catalogProduct.upsertMany("big", many);
    const productFacts = createInMemoryProductFactsStore();
    const shellSource = { getShell: async () => ({ tenantId: "big", brandName: "Big Store", policy: { returns: "", shipping: "" } }) };
    const grounding = createLocalCatalogGroundingPort({ catalogProduct, productFacts, shellSource });
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
    const shellSource = { getShell: async () => ({ tenantId: "t1", brandName: "x", policy: { returns: "", shipping: "" } }) };
    const grounding = createLocalCatalogGroundingPort({ catalogProduct, productFacts, shellSource });

    const products = await grounding.getProductsByIds("t1", ["gid://shopify/Product/1", "gid://shopify/Product/missing"]);
    expect(products.length).toBe(1);
    expect(products[0].price).toBe("$11");
  });

  it("an empty id list short-circuits to [] with no store calls", async () => {
    const catalogProduct = createInMemoryCatalogProductStore();
    const productFacts = createInMemoryProductFactsStore();
    const shellSource = { getShell: async () => ({ tenantId: "t1", brandName: "x", policy: { returns: "", shipping: "" } }) };
    const grounding = createLocalCatalogGroundingPort({ catalogProduct, productFacts, shellSource });
    expect(await grounding.getProductsByIds("t1", [])).toEqual([]);
  });
});
