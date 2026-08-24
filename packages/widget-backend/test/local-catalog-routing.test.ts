import { describe, it, expect } from "vitest";
import {
  InMemoryRuntimeStore,
  createInMemoryCatalogProductStore,
  createInMemoryProductFactsStore,
} from "@palup/platform-ports";
import { createGroundingPort } from "../src/model.js";

// Task 8 (unified-cutover-cleanup, 2026-08-24) — per-tenant local-serving routing (controller ruling,
// load-bearing requirement #1), now UNCONDITIONAL: a tenant with a `catalog_product` corpus (backfilled —
// a non-empty `listByTenant`) is served ENTIRELY from local stores; a tenant with none falls back to the
// fixtures adapter. The `localServingEnabled`/`catalogUnified` flags that used to gate this — and the live
// Storefront-serving fallback for a non-backfilled-but-credentialed tenant — are gone (see model.ts's own
// header comment); the non-local fallback is fixtures-only now.

const store = () => new InMemoryRuntimeStore();
const secrets = { get: async () => undefined } as any;

describe("createGroundingPort — per-tenant local-serving routing", () => {
  it("a BACKFILLED tenant (non-empty catalogProduct) is served locally", async () => {
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

    const g = createGroundingPort(store(), secrets, { catalogProduct, productFacts });

    const ctx = await g.getContext("backfilled-tenant");
    expect(ctx.products.length).toBe(1);
    expect(ctx.products[0].price).toBe("$9");

    const byIds = await g.getProductsByIds("backfilled-tenant", ["gid://shopify/Product/1"]);
    expect(byIds.length).toBe(1);
  });

  it("a NON-backfilled tenant (empty catalogProduct) falls back to fixtures", async () => {
    const catalogProduct = createInMemoryCatalogProductStore(); // empty — no backfill for this tenant
    const productFacts = createInMemoryProductFactsStore();

    const g = createGroundingPort(store(), secrets, { catalogProduct, productFacts });

    // "demo" resolves the built-in AURIA fixture in StaticGroundingAdapter.
    const ctx = await g.getContext("demo");
    expect(ctx.brandName).toBe("Auria");
  });

  it("no catalogProduct/productFacts supplied at all defaults to an empty (never-backfilled) local store — fixtures for every tenant", async () => {
    const g = createGroundingPort(store(), secrets);
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
      catalogProduct: countingCatalogProduct,
      productFacts,
      now: () => clock,
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
      catalogProduct,
      productFacts,
      hasLocalCatalog: alwaysNotLocal,
    });

    // "backfilled-tenant" is not a known fixture id, so the fixtures adapter returns EMPTY products. Had
    // the real (ignored) check been consulted instead, this tenant IS backfilled and would have returned
    // the one local catalog_product record — so an empty result here proves the injected decision won.
    const ctx = await g.getContext("backfilled-tenant");
    expect(ctx.products).toEqual([]);
  });
});
