import { describe, it, expect } from "vitest";
import {
  InMemoryRuntimeStore,
  createInMemoryCatalogProductStore,
  createInMemoryProductFactsStore,
} from "@palup/platform-ports";
import { createGroundingPort } from "../src/model.js";

// Task 8 — per-tenant local-serving routing (controller ruling, load-bearing requirement #1). A tenant
// with a `catalog_product` corpus (backfilled — a non-empty `listByTenant`) is served ENTIRELY from local
// stores; a tenant with none keeps the existing storefront/fixtures path unchanged, so flipping
// CATALOG_LOCAL_SERVING on globally never blanks a currently-working tenant that has not been backfilled.

const store = () => new InMemoryRuntimeStore();
const secrets = { get: async () => undefined } as any;
const throwingShopifyFetch = async (): Promise<never> => {
  throw new Error("Shopify is down — must not be called for a backfilled tenant's PRODUCTS path");
};

describe("createGroundingPort — per-tenant local-serving routing", () => {
  it("a BACKFILLED tenant (non-empty catalogProduct) is served locally — no Shopify call for products", async () => {
    const catalogProduct = createInMemoryCatalogProductStore();
    await catalogProduct.upsertMany("backfilled-tenant", [
      {
        productId: "gid://shopify/Product/1",
        handle: "widget",
        title: "Widget",
        status: "active",
        variants: [{ variantId: "v1", price: "$9", availableForSale: true }],
        contentHash: "h1",
        syncedAt: "2026-08-01T00:00:00.000Z",
      },
    ]);
    const productFacts = createInMemoryProductFactsStore();

    const g = createGroundingPort(store(), secrets, {
      localServingEnabled: true,
      catalogProduct,
      productFacts,
      shopifyFetch: throwingShopifyFetch, // proves the PRODUCTS path never reaches this
      shopDomainFor: async () => "backfilled.myshopify.com",
    });

    const ctx = await g.getContext("backfilled-tenant");
    expect(ctx.products.length).toBe(1);
    expect(ctx.products[0].price).toBe("$9");

    const byIds = await g.getProductsByIds("backfilled-tenant", ["gid://shopify/Product/1"]);
    expect(byIds.length).toBe(1);
  });

  it("a NON-backfilled tenant (empty catalogProduct) keeps the existing storefront/fixtures path", async () => {
    const catalogProduct = createInMemoryCatalogProductStore(); // empty — no backfill for this tenant
    const productFacts = createInMemoryProductFactsStore();

    const g = createGroundingPort(store(), secrets, {
      localServingEnabled: true,
      catalogProduct,
      productFacts,
      shopifyFetch: async () => ({ shop: { name: "Acme" }, products: { nodes: [{ id: "1", title: "Widget" }] } }),
      shopDomainFor: async () => undefined, // no registry row -> resolveStorefrontCredential falls to fixtures/SecretsPort
    });

    // "demo" resolves the built-in AURIA fixture in StaticGroundingAdapter — a non-backfilled tenant with
    // no live creds must still resolve exactly as it did before this task (byte-identical fallback chain).
    const ctx = await g.getContext("demo");
    expect(ctx.brandName).toBe("Auria");
  });

  it("localServingEnabled OFF (or catalogProduct/productFacts absent) is byte-identical to before this task", async () => {
    const g = createGroundingPort(store(), secrets, {
      shopDomainFor: async () => undefined,
    });
    const ctx = await g.getContext("demo");
    expect(ctx.brandName).toBe("Auria");
  });

  it("localServingEnabled true but catalogProduct/productFacts NOT supplied is a no-op (falls through unchanged)", async () => {
    const g = createGroundingPort(store(), secrets, {
      localServingEnabled: true,
      shopDomainFor: async () => undefined,
    });
    const ctx = await g.getContext("demo");
    expect(ctx.brandName).toBe("Auria");
  });

  // Coordinator review fix #2: hasLocalCatalog's listByTenant(limit:1) read must be memoized per tenant
  // with a short TTL — createCachingGroundingPort only caches getContext, so getShell/getProductsByIds
  // would otherwise re-read the backfill check on EVERY call.
  it("memoizes the per-tenant local-serving decision with a short TTL — repeated calls do NOT re-read listByTenant", async () => {
    const realCatalogProduct = createInMemoryCatalogProductStore();
    await realCatalogProduct.upsertMany("backfilled-tenant", [
      {
        productId: "gid://shopify/Product/1",
        handle: "widget",
        title: "Widget",
        status: "active",
        variants: [{ variantId: "v1", price: "$9" }],
        contentHash: "h1",
        syncedAt: "2026-08-01T00:00:00.000Z",
      },
    ]);
    let listByTenantCalls = 0;
    const countingCatalogProduct = {
      ...realCatalogProduct,
      listByTenant: async (tenantId: string, opts?: { limit?: number; includeDeleted?: boolean }) => {
        listByTenantCalls++;
        return realCatalogProduct.listByTenant(tenantId, opts);
      },
    };
    const productFacts = createInMemoryProductFactsStore();

    let clock = 1_000_000;
    const g = createGroundingPort(store(), secrets, {
      localServingEnabled: true,
      catalogProduct: countingCatalogProduct,
      productFacts,
      now: () => clock,
      shopDomainFor: async () => "backfilled.myshopify.com",
    });

    await g.getShell("backfilled-tenant");
    await g.getShell("backfilled-tenant");
    await g.getShell("backfilled-tenant");
    expect(listByTenantCalls).toBe(1); // memoized within the TTL window — not one read per call

    clock += 61_000; // advance past the (default 60s) TTL
    await g.getShell("backfilled-tenant");
    expect(listByTenantCalls).toBe(2); // cache expired -> re-checked exactly once more
  });

  // Task 8b — the retrieval-render hydration seam (catalog-retriever.ts) must consult the SAME per-tenant
  // backfilled decision Task 8 already built, not a second one. `createGroundingPort` accepts an injected
  // `hasLocalCatalog` for exactly this reuse: when supplied, it is honoured INSTEAD of building its own
  // internal memoized decision, so the composition root (server.ts) can share one instance between the
  // grounding router and the catalog retriever's hydration dep.
  it("honours an injected hasLocalCatalog decision instead of building its own", async () => {
    const catalogProduct = createInMemoryCatalogProductStore();
    // The REAL check (a non-empty listByTenant) would say this tenant IS backfilled.
    await catalogProduct.upsertMany("backfilled-tenant", [
      {
        productId: "gid://shopify/Product/1",
        handle: "widget",
        title: "Widget",
        status: "active",
        variants: [{ variantId: "v1", price: "$9" }],
        contentHash: "h1",
        syncedAt: "2026-08-01T00:00:00.000Z",
      },
    ]);
    const productFacts = createInMemoryProductFactsStore();
    // An injected decision that DISAGREES with the real check on purpose, to prove it — not the internal
    // memoized listByTenant check — is what actually routes when supplied.
    const alwaysNotLocal = async () => false;

    const g = createGroundingPort(store(), secrets, {
      localServingEnabled: true,
      catalogProduct,
      productFacts,
      hasLocalCatalog: alwaysNotLocal,
      shopDomainFor: async () => undefined, // no live creds -> falls to StaticGroundingAdapter fixtures
    });

    // "backfilled-tenant" is not a known fixture id, so the fixtures adapter returns EMPTY products. Had
    // the real (ignored) check been consulted instead, this tenant IS backfilled and would have returned
    // the one local catalog_product record — so an empty result here proves the injected decision won.
    const ctx = await g.getContext("backfilled-tenant");
    expect(ctx.products).toEqual([]);
  });
});
