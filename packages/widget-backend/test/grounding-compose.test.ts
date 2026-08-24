import { describe, it, expect } from "vitest";
import { InMemoryRuntimeStore, createEnvSecrets, createInMemoryCatalogProductStore, createInMemoryProductFactsStore } from "@palup/platform-ports";
import { createGroundingPort } from "../src/model.js";

// unified-cutover-cleanup (2026-08-24): createGroundingPort routes per-tenant on backfill status ALONE —
// a backfilled tenant (a non-empty local `catalog_product` corpus) serves fully local; a non-backfilled
// tenant falls back to the fixtures adapter — all behind the caching wrapper. This used to ALSO route a
// non-backfilled-but-credentialed tenant to a live Shopify Storefront call (`SHOPIFY_STORES` + a resolvable
// SecretsPort token); that branch was removed as dead code once serving became unconditionally local (see
// model.ts's own header comment) — a tenant with Shopify credentials but no local backfill now gets
// fixtures too, exactly like an uncredentialed one.

describe("createGroundingPort composition", () => {
  it("falls back to fixtures when a tenant is not backfilled locally", async () => {
    const g = createGroundingPort(new InMemoryRuntimeStore(), createEnvSecrets(undefined));
    expect((await g.getContext("demo")).brandName).toBe("Auria"); // fixture
    expect((await g.getContext("northwind")).brandName).toBe("Northwind Coffee");
    expect((await g.getContext("unknown-tenant")).products).toEqual([]); // safe-empty
  });

  it("a backfilled tenant serves fully local, even with a throwing shopifyFetch (durability) — fixtures for other, non-backfilled tenants", async () => {
    const catalogProduct = createInMemoryCatalogProductStore();
    await catalogProduct.upsertMany("acme", [
      {
        productId: "gid://shopify/Product/1",
        handle: "widget",
        title: "Local Widget",
        status: "active",
        variants: [{ variantId: "v1", price: "$9", availableForSale: true }],
        contentHash: "h1",
        syncedAt: "2026-08-01T00:00:00.000Z",
      },
    ]);
    const g = createGroundingPort(new InMemoryRuntimeStore(), createEnvSecrets(undefined), {
      catalogProduct,
      productFacts: createInMemoryProductFactsStore(),
    });
    const acme = await g.getContext("acme");
    expect(acme.tenantId).toBe("acme");
    expect(acme.products.map((p) => p.title)).toContain("Local Widget");
    // a DIFFERENT, non-backfilled tenant still gets its fixture (routing is per-tenant + isolated).
    expect((await g.getContext("demo")).brandName).toBe("Auria");
  });
});
