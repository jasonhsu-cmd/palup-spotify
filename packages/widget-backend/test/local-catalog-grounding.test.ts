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

    const grounding = createLocalCatalogGroundingPort({
      catalogProduct,
      productFacts,
      shellSource: throwingShellSource,
      storeProfile: createInMemoryStoreProfileStore(),
    });
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

  // Task 4/7 (credential-enrollment-unification): getShell serves from the local `store_profile` store,
  // not `shellSource`, ONLY when `unifiedLocalShell` is set (final-review Critical fix, 2026-08-24: getShell
  // initially read store_profile unconditionally, ignoring the flag — now gated exactly like getContext).
  // Full coverage of the unifiedLocalShell=true behavior (happy path, missing profile, store_profile error)
  // lives in local-catalog-grounding-shell.test.ts. This test just confirms that, WITH the flag set, getShell
  // ignores shellSource even when it WOULD have returned a different (wrong) answer, proving no accidental
  // fallback remains.
  it("getShell reads store_profile, never shellSource, even when shellSource would answer differently (unifiedLocalShell)", async () => {
    const catalogProduct = createInMemoryCatalogProductStore();
    const productFacts = createInMemoryProductFactsStore();
    const storeProfile = createInMemoryStoreProfileStore();
    await storeProfile.put("t1", { brandName: "Acme", policy: { returns: "30d", shipping: "free" } });
    const shellSource = { getShell: async () => ({ tenantId: "t1", brandName: "Wrong Brand", policy: { returns: "x", shipping: "y" } }) };
    const grounding = createLocalCatalogGroundingPort({ catalogProduct, productFacts, shellSource, storeProfile, unifiedLocalShell: true });
    const shell = await grounding.getShell("t1");
    expect(shell).toEqual({ tenantId: "t1", brandName: "Acme", policy: { returns: "30d", shipping: "free" } });
  });

  // getShell must mirror shellSource EXACTLY when `unifiedLocalShell` is NOT set (the default) — the
  // final-review Critical fix's own regression pin at this port's level: store_profile is never consulted
  // and shellSource's answer (even a THROW) passes straight through, unlike the unified branch above.
  it("getShell delegates to shellSource, never store_profile, when unifiedLocalShell is absent (flag-off default)", async () => {
    const catalogProduct = createInMemoryCatalogProductStore();
    const productFacts = createInMemoryProductFactsStore();
    const storeProfile = {
      get: async () => {
        throw new Error("store_profile must never be consulted from getShell when unifiedLocalShell is off");
      },
    };
    const shellSource = { getShell: async () => ({ tenantId: "t1", brandName: "Real Shopify Shell", policy: { returns: "60d", shipping: "flat $5" } }) };
    const grounding = createLocalCatalogGroundingPort({ catalogProduct, productFacts, shellSource, storeProfile });
    const shell = await grounding.getShell("t1");
    expect(shell).toEqual({ tenantId: "t1", brandName: "Real Shopify Shell", policy: { returns: "60d", shipping: "flat $5" } });
  });

  // Coordinator review fix #1: getShell must degrade symmetrically with getContext, not throw. Called
  // DIRECTLY on the local port here (not through createCachingGroundingPort's own getShell try/catch), so
  // this proves the local port itself is fail-closed, independent of any caller-side safety net. Now
  // exercises the store_profile dependency (Task 4/7, unifiedLocalShell:true), not shellSource.
  it("getShell degrades to the SAME neutral default as getContext when store_profile has no record (called directly, unifiedLocalShell)", async () => {
    const catalogProduct = createInMemoryCatalogProductStore();
    const productFacts = createInMemoryProductFactsStore();
    const storeProfile = createInMemoryStoreProfileStore();
    const shellSource = {
      getShell: async () => {
        throw new Error("Shopify is down");
      },
    };
    const grounding = createLocalCatalogGroundingPort({ catalogProduct, productFacts, shellSource, storeProfile, unifiedLocalShell: true });
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
    const shellSource = { getShell: async () => ({ tenantId: "big", brandName: "Big Store", policy: { returns: "", shipping: "" } }) };
    const storeProfile = createInMemoryStoreProfileStore();
    const grounding = createLocalCatalogGroundingPort({ catalogProduct, productFacts, shellSource, storeProfile });
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
    const storeProfile = createInMemoryStoreProfileStore();
    const grounding = createLocalCatalogGroundingPort({ catalogProduct, productFacts, shellSource, storeProfile });

    const products = await grounding.getProductsByIds("t1", ["gid://shopify/Product/1", "gid://shopify/Product/missing"]);
    expect(products.length).toBe(1);
    expect(products[0].price).toBe("$11");
  });

  it("an empty id list short-circuits to [] with no store calls", async () => {
    const catalogProduct = createInMemoryCatalogProductStore();
    const productFacts = createInMemoryProductFactsStore();
    const shellSource = { getShell: async () => ({ tenantId: "t1", brandName: "x", policy: { returns: "", shipping: "" } }) };
    const storeProfile = createInMemoryStoreProfileStore();
    const grounding = createLocalCatalogGroundingPort({ catalogProduct, productFacts, shellSource, storeProfile });
    expect(await grounding.getProductsByIds("t1", [])).toEqual([]);
  });
});
