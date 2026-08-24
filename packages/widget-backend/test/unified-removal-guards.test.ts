import { describe, it, expect, afterEach } from "vitest";
import {
  InMemoryRuntimeStore,
  createInMemoryMerchantRegistry,
  createInMemoryCatalogProductStore,
  createInMemoryStoreProfileStore,
} from "@palup/platform-ports";
import type { CatalogProductPort, StoreProfilePort } from "@palup/platform-ports";
import type { AdminTokenStore } from "@palup/state-postgres";
import { buildServer } from "../src/server.js";
import { runCatalogSyncScheduler, type CatalogSyncSchedulerDeps } from "../src/jobs/catalog-sync-scheduler.js";
import { INSTALL_SCOPES_DEFAULT } from "../src/routes/shopify-install.js";
import { ADMIN_SYNC_SCOPES } from "../src/shopify-webhook-identity.js";

// Task 8 (credential-enrollment-unification) — REMOVAL GUARDS.
//
// ADR-0023 D1 retires two mechanisms for the unified (now the ONLY, unconditional — unified-cutover-cleanup
// 2026-08-24 dropped `CATALOG_UNIFIED`) serving path: the delegate/Storefront credential
// (`resolveShopifyStore`/`resolveStorefrontCredential`, backed by the `PALUP_SECRETS` Storefront token map)
// for SERVING a backfilled tenant — DELETED outright from model.ts's `createGroundingPort` — and
// `SHOPIFY_STORES`-env tenant enumeration for the catalog-sync SCHEDULER (replaced by the registry's
// `listActive`, Task 5), which is still a live, in-place mechanism used elsewhere (install/webhooks,
// `jobs/catalog-index.ts`'s fleet enumeration) so this file continues to guard that the scheduler never
// falls back to it. This file PINS the invariant that the serving/scheduler paths never reach back into
// either retired mechanism, so a future change cannot silently reintroduce them without a test going red.
//
// Assertions are BEHAVIORAL (via the same DI seams server-catalog-unified-wiring.test.ts already exercises)
// wherever the codebase gives a seam to observe "was the retired call ever made" — grep-style static
// assertions are reserved for the scope pin, which is exactly what order-attribution-scope-pinning.test.ts
// already uses static/import assertions for (there is no runtime call to observe there; scopes are a
// static, code-level constant).

const TENANT = "demo";

function fakeAdminTokenStore(): AdminTokenStore {
  return {
    put: async () => {},
    delete: async () => {},
    async read() {
      return { status: "missing" };
    },
    async refresh() {},
  };
}

function seedCatalogProduct(store: CatalogProductPort, tenantId: string, title: string): Promise<void> {
  return store.upsertMany(tenantId, [
    {
      productId: "gid://shopify/Product/1",
      handle: "removal-guard-serum",
      title,
      status: "active",
      variants: [{ variantId: "gid://shopify/ProductVariant/1", price: "9.99", availableForSale: true }],
      contentHash: "h1",
      syncedAt: new Date().toISOString(),
    },
  ]);
}

describe("Removal guard — unified SERVING never resolves a Storefront credential (resolveShopifyStore / PALUP_SECRETS token)", () => {
  it("a backfilled tenant never calls the injected Storefront fetch seam", async () => {
    // unified-cutover-cleanup (2026-08-24): the live Storefront-serving branch
    // (`resolveStorefrontCredential`/`resolveShopifyStore`/`createShopifyGroundingAdapter`/the
    // PALUP_SECRETS Storefront token) was DELETED from model.ts's `createGroundingPort` — a backfilled
    // tenant's serving path has no Shopify/fetch dependency left to consult at all (structural, not just
    // behavioral). `shopifyFetch` throwing is the externally-observable proof, through the full composition
    // root, that no such call is ever reached.
    const store = new InMemoryRuntimeStore();
    const catalogProduct: CatalogProductPort = createInMemoryCatalogProductStore();
    await seedCatalogProduct(catalogProduct, TENANT, "Removal Guard Serum");
    const storeProfile: StoreProfilePort = createInMemoryStoreProfileStore();
    await storeProfile.put(TENANT, { brandName: "Removal Guard Co", policy: { returns: "30d", shipping: "free" } });

    let shopifyFetchCalled = false;
    const app = await buildServer({
      store,
      catalogProduct,
      storeProfile,
      adminTokens: fakeAdminTokenStore(),
      shopifyFetch: async () => {
        shopifyFetchCalled = true;
        throw new Error("removal guard: resolveShopifyStore/Storefront must never be reached for a backfilled tenant");
      },
    });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/chat",
        payload: { sessionId: "sess-removal-guard", message: "hi", signals: {}, idempotencyKey: "removal-guard-0" },
      });
      expect(res.statusCode).toBe(200);
      expect(shopifyFetchCalled).toBe(false);
    } finally {
      await app.close();
    }
  });
});

describe("Removal guard — unified catalog-sync SCHEDULER enumerates via listActive, never via SHOPIFY_STORES", () => {
  const SHOPIFY_STORES_SAVED = process.env.SHOPIFY_STORES;
  afterEach(() => {
    if (SHOPIFY_STORES_SAVED === undefined) delete process.env.SHOPIFY_STORES;
    else process.env.SHOPIFY_STORES = SHOPIFY_STORES_SAVED;
  });

  it("a tenant present ONLY in SHOPIFY_STORES (not the registry) is never synced; the registry's listActive is the sole source of truth", async () => {
    // A ghost tenant that exists ONLY in the retired SHOPIFY_STORES env map, never in the registry — if the
    // scheduler's tenant discovery fell back to (or merged in) `parseStoreDomains`/SHOPIFY_STORES, this
    // tenant would appear in the run; it must not.
    process.env.SHOPIFY_STORES = JSON.stringify({ "ghost-tenant": "ghost.myshopify.com" });

    const registry = createInMemoryMerchantRegistry();
    await registry.create({ tenantId: "alpha", shopDomain: "alpha.myshopify.com", embedKey: "pk_alpha", region: "us" });
    await registry.create({ tenantId: "beta", shopDomain: "beta.myshopify.com", embedKey: "pk_beta", region: "us" });

    const backfillCalls: string[] = [];
    const app = await buildServer({
      store: new InMemoryRuntimeStore(),
      merchantRegistry: registry,
      adminTokens: fakeAdminTokenStore(),
      catalogSyncBackfill: async (tenantId) => {
        backfillCalls.push(tenantId);
        return { tenantId, outcome: "no_products" } as unknown as Awaited<ReturnType<CatalogSyncSchedulerDeps["backfill"]>>;
      },
    });
    try {
      const deps = (app as unknown as { catalogSyncSchedulerDeps?: CatalogSyncSchedulerDeps }).catalogSyncSchedulerDeps;
      expect(deps).toBeDefined();
      // The scheduler's `registry` dep IS the real listActive-backed registry object — not something
      // rebuilt from (or merged with) SHOPIFY_STORES.
      expect(deps!.registry).toBe(registry);

      const report = await runCatalogSyncScheduler(deps!);
      expect(backfillCalls.slice().sort()).toEqual(["alpha", "beta"]);
      expect(backfillCalls).not.toContain("ghost-tenant");
      expect(report.results.map((r) => r.tenantId).sort()).toEqual(["alpha", "beta"]);
    } finally {
      await app.close();
    }
  });
});

// Task 12 (F3) already pins this exact invariant with the same imports (order-attribution-scope-pinning.test.ts).
// Re-asserted here, framed as a removal guard for THIS task's scope: the unified/production install and
// admin-sync paths must never regress to requesting a write scope as a code-level default. Deliberately a
// static/import assertion (not a runtime spy) — there is no live call to observe here; these are
// compile-time-constant scope lists, exactly the shape order-attribution-scope-pinning.test.ts already
// treats as a static pin.
describe("Removal guard — the app declares ONLY read-only scopes as code-level defaults (no write-scope regression)", () => {
  it("INSTALL_SCOPES_DEFAULT contains no write scope", () => {
    const scopes = INSTALL_SCOPES_DEFAULT.split(",").map((s) => s.trim());
    for (const w of ["write_products", "write_customers", "write_orders", "write_inventory"]) {
      expect(scopes).not.toContain(w);
    }
  });

  it("ADMIN_SYNC_SCOPES is exactly the least-privilege read-only pair", () => {
    expect(ADMIN_SYNC_SCOPES).toEqual(["read_products", "read_inventory"]);
  });
});
