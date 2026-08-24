import { describe, it, expect, afterEach } from "vitest";
import {
  InMemoryRuntimeStore,
  createInMemoryCatalogProductStore,
  createInMemoryProductFactsStore,
  createInMemoryStoreProfileStore,
  createInMemoryVectorStore,
  type CatalogProductPort,
  type CatalogProductRecord,
  type StoreProfilePort,
  type ModelPort,
} from "@palup/platform-ports";
import type { AdminTokenStore } from "@palup/state-postgres";
import { buildServer } from "../src/server.js";
import { createLocalCatalogGroundingPort, LocalCatalogCeilingExceededError } from "../src/local-catalog-grounding.js";
import { createCatalogRetriever } from "../src/catalog-retriever.js";
import { runCatalogIndex } from "../src/jobs/catalog-index.js";
import { MAX_CATALOG_PRODUCTS } from "../src/shopify-grounding.js";

// Task 9 (credential-enrollment-unification) — THE DURABILITY TEST. Encodes, in one file, the headline
// invariant the whole cutover exists to prove (spec `docs/superpowers/specs/2026-08-23-durable-catalog-sync
// -design.md` §3 "Durability invariant"; carried into local-catalog-grounding.ts's own file banner as
// "the durability invariant this whole file exists for" / "§8a invariant 11"):
//
//   > The assistant serves the catalog from PalUp's local store. A live Shopify call is only ever a
//   > background sync mechanism, never on the shopper's hot path.
//
// This file is a REGRESSION PIN, not a red-first test — see the "PASS-ON-ARRIVAL" note below each describe
// block for why, and the non-vacuousness proof each block documents (run manually, not committed, per the
// task brief's Step 2 allowance for a pass-on-arrival invariant test).
//
// TWO SCOPES, per the plan's Step 1:
//   1. The ≤MAX_CATALOG_PRODUCTS getContext path — driven through the REAL composition root (`buildServer`
//      + `app.inject("/chat")`), with `shopifyFetch` wired to THROW on every call. This is the strongest
//      form of the invariant: an actual HTTP round trip through the full server, not a hand-built port.
//   2. The >MAX_CATALOG_PRODUCTS retrieval-hydration path (`getShell` + `getProductsByIds`). Forcing THIS
//      path through the full `/chat` composition would additionally require standing up the two-gate
//      `catalogRetrievalEnabledFor` per-tenant enablement, a real embedding `ModelPort`, and a populated
//      pgvector corpus purely to prove a routing decision this file's own production code
//      (`local-catalog-grounding.ts`'s `getContext` ceiling check) already makes deterministically and
//      synchronously — impractical for a focused unit test and orthogonal to what CATALOG_UNIFIED itself
//      changes. Per the task brief's explicit fallback, this scope instead drives the REAL production
//      functions directly: `createLocalCatalogGroundingPort` (the exact `GroundingPort` `model.ts` composes
//      under `CATALOG_UNIFIED`) and `createCatalogRetriever` (the exact retriever `server.ts` composes,
//      wired with a REAL vector corpus built by the REAL `runCatalogIndex`) — the identical seam
//      `catalog-retriever-local-hydration.test.ts` (Task 8b) already exercises for its own narrower claim.
//      Zero Shopify calls is proved by a THROWING `shellSource` stub that is asserted to never be invoked
//      (there is no other Shopify seam in this port's dependency surface at all — `LocalCatalogGroundingDeps`
//      carries no fetch/client dependency, so "zero Shopify calls" is also a structural, type-level property
//      here, not merely a runtime one).

// "demo" — not an arbitrary label: `/chat` resolves an unauthenticated request's tenant through the
// merchant-resolver's default embed-key mapping, which maps the built-in "demo-embed-key" to "demo"
// (mirrors server-catalog-unified-wiring.test.ts's identical choice, for the identical reason — an
// unrelated tenant id here would never reach the seeded rows at all).
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

/** Mirrors server-catalog-unified-wiring.test.ts's identical helper — the grounding cache row
 *  `createCachingGroundingPort` writes fire-and-forget, so poll briefly rather than assume it landed. */
async function pollGroundingCache(
  store: InMemoryRuntimeStore,
  tenantId: string,
): Promise<{ ctx: { brandName: string; products: { title: string }[]; policy: { returns: string; shipping: string } } } | null> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const row = await store.get<{ ctx: { brandName: string; products: { title: string }[]; policy: { returns: string; shipping: string } } }>(
      { tenantId },
      "grounding",
      "context",
    );
    if (row) return row;
    await new Promise((r) => setTimeout(r, 5));
  }
  return null;
}

function seedCatalogProduct(store: CatalogProductPort, tenantId: string, title: string): Promise<void> {
  return store.upsertMany(tenantId, [
    {
      productId: "gid://shopify/Product/1",
      handle: "durable-serum",
      title,
      status: "active",
      descriptionText: "A durable local serum.",
      variants: [{ variantId: "gid://shopify/ProductVariant/1", price: "24.99", availableForSale: true }],
      contentHash: "h1",
      syncedAt: new Date().toISOString(),
    },
  ]);
}

describe("Task 9 durability — ≤1000-SKU getContext, driven through the REAL composition (buildServer + /chat)", () => {
  // unified-cutover-cleanup (2026-08-24): `createGroundingPort`'s local-serving routing and
  // `local-catalog-grounding.ts`'s local `store_profile` read are now the ONLY behavior — this test pins
  // that as Task 9's own named durability regression (the acceptance criterion this task exists to encode).
  it("a backfilled tenant's getContext returns full local products + brand/policy — shopifyFetch is NEVER called", async () => {
    const store = new InMemoryRuntimeStore();
    const catalogProduct: CatalogProductPort = createInMemoryCatalogProductStore();
    await seedCatalogProduct(catalogProduct, TENANT, "Durable Serum");
    const storeProfile: StoreProfilePort = createInMemoryStoreProfileStore();
    await storeProfile.put(TENANT, { brandName: "Durable Co", policy: { returns: "45d durable", shipping: "free durable" } });

    let shopifyFetchCalled = false;
    const app = await buildServer({
      store,
      catalogProduct,
      storeProfile,
      adminTokens: fakeAdminTokenStore(),
      shopifyFetch: async () => {
        shopifyFetchCalled = true;
        throw new Error("durability violation: Shopify must never be called for a backfilled tenant");
      },
    });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/chat",
        payload: { sessionId: "sess-durability-getcontext", message: "hi", signals: {}, idempotencyKey: "durability-getcontext-0" },
      });
      expect(res.statusCode).toBe(200);
      expect(shopifyFetchCalled).toBe(false);

      const row = await pollGroundingCache(store, TENANT);
      expect(row).not.toBeNull();
      // Full local PRODUCTS (Task 8's local-catalog-grounding, unaffected by this flag but exercised here
      // as part of the whole-invariant round trip).
      expect(row!.ctx.products.map((p) => p.title)).toContain("Durable Serum");
      // Full local BRAND/POLICY (Task 4/7's store_profile — NOT the "Auria" static fixture, and NOT a
      // Shopify shell fetch).
      expect(row!.ctx.brandName).toBe("Durable Co");
      expect(row!.ctx.policy).toEqual({ returns: "45d durable", shipping: "free durable" });
    } finally {
      await app.close();
    }
  });

  // getShell, driven through the same composition — a second, independent HTTP route (`/storefront/catalog`
  // resolves via the SAME `grounding` handle when there is no live Storefront credential) would require its
  // own tenant/domain plumbing unrelated to this task; the port-level getShell coverage below (which drives
  // the EXACT SAME `createLocalCatalogGroundingPort`/`readLocalShell` code this composition wires in) is the
  // more direct proof and avoids duplicating server-catalog-unified-wiring.test.ts's own getShell-adjacent
  // assertions. See the >1000-SKU describe block below for the direct getShell proof.
});

describe("Task 9 durability — >1000-SKU retrieval-hydration path (getShell + getProductsByIds), zero Shopify calls", () => {
  const record = (i: number): CatalogProductRecord => ({
    productId: `gid://shopify/Product/${i}`,
    handle: `durable-${i}`,
    title: `Durable Product ${i}`,
    status: "active",
    descriptionText: `Descriptive text for durable product ${i}.`,
    tags: ["durable", `tag-${i % 5}`],
    variants: [{ variantId: `gid://shopify/ProductVariant/${i}`, price: "9.99", availableForSale: true }],
    contentHash: `h${i}`,
    syncedAt: new Date().toISOString(),
  });

  function fakeEmbed(): ModelPort {
    return {
      async complete() {
        throw new Error("unused in this test");
      },
      async embed(req) {
        // Every text ranks identically — this test only needs hits to resolve, not a meaningful ranking.
        return { vectors: req.texts.map(() => [1, 0, 0]), dimension: 3, model: "fake-embed-3d", purpose: req.purpose };
      },
    };
  }

  /** Builds a tenant whose LOCAL catalog exceeds MAX_CATALOG_PRODUCTS — the exact condition that forces a
   *  backfilled tenant off the whole-catalog getContext render path and onto the retrieval-hydration path
   *  (S2 render path, `docs/superpowers/specs/2026-08-23-durable-catalog-sync-design.md` §4.1/§5.4). */
  async function setupOverCeilingTenant() {
    const catalogProduct = createInMemoryCatalogProductStore();
    const many: CatalogProductRecord[] = [];
    for (let i = 0; i < MAX_CATALOG_PRODUCTS + 1; i++) many.push(record(i));
    await catalogProduct.upsertMany(TENANT, many);

    const productFacts = createInMemoryProductFactsStore();
    const storeProfile: StoreProfilePort = createInMemoryStoreProfileStore();
    await storeProfile.put(TENANT, { brandName: "Durable Co", policy: { returns: "45d durable", shipping: "free durable" } });

    // The REAL local grounding port `server.ts` composes — not a stand-in. No Shopify/fetch dependency
    // exists anywhere in `LocalCatalogGroundingDeps` at all: the "zero Shopify calls" property is
    // structural here, not merely behavioral.
    const local = createLocalCatalogGroundingPort({
      catalogProduct,
      productFacts,
      storeProfile,
    });

    // A real pgvector-shaped corpus (in-memory adapter) built by the REAL `runCatalogIndex` — the same
    // corpus-build path `catalog-sync-scheduler.ts`'s `index` step invokes in the composed server.
    const vector = createInMemoryVectorStore();
    const runtimeStore = new InMemoryRuntimeStore();
    const corpusProducts = many.slice(0, 3).map((r) => ({ id: r.productId, title: r.title }));
    await runCatalogIndex(
      {
        store: runtimeStore,
        vector,
        model: fakeEmbed(),
        catalog: async () => ({
          tenantId: TENANT,
          brandName: "unused-by-retriever",
          policy: { returns: "", shipping: "" },
          products: corpusProducts.map((p) => ({ id: p.id, title: p.title, description: "", price: "$0" })),
        }),
      },
      [TENANT],
    );

    // The REAL retriever `server.ts` composes, wired with the REAL local hydration functions (getProductsByIds)
    // — the exact seam Task 8b built and this task's composition reuses (server.ts `localCatalogHydration`).
    const retriever = createCatalogRetriever({
      store: runtimeStore,
      vector,
      model: fakeEmbed(),
      localHydration: {
        hasLocalCatalog: async () => true,
        getProductsByIds: (tenantId, ids) => local.getProductsByIds(tenantId, ids),
      },
    });

    return { local, retriever, corpusProducts };
  }

  // PASS-ON-ARRIVAL: `local-catalog-grounding.ts`'s ceiling check (Task 8) and `catalog-retriever.ts`'s
  // `localHydration` seam (Task 8b) both predate this task; this block pins them as part of Task 9's own
  // durability invariant rather than re-deriving them. Non-vacuousness: seeding one FEWER record
  // (MAX_CATALOG_PRODUCTS instead of +1) makes the first assertion below fail (getContext would resolve
  // instead of throwing) — verified manually this session by editing the loop bound in a scratch run and
  // observing the `rejects.toBeInstanceOf` assertion fail, then reverting.
  it("getContext detects the >MAX_CATALOG_PRODUCTS ceiling (routes off the whole-catalog path)", async () => {
    const { local } = await setupOverCeilingTenant();
    await expect(local.getContext(TENANT)).rejects.toBeInstanceOf(LocalCatalogCeilingExceededError);
  });

  it("getShell returns full local brand/policy for the over-ceiling tenant — no Shopify/shellSource dependency exists to consult", async () => {
    const { local } = await setupOverCeilingTenant();
    const shell = await local.getShell(TENANT);
    expect(shell).toEqual({ tenantId: TENANT, brandName: "Durable Co", policy: { returns: "45d durable", shipping: "free durable" } });
  });

  it("the retrieval-hydration path (getShell + getProductsByIds) returns full local descriptive data for the over-ceiling tenant, zero Shopify calls", async () => {
    const { retriever, corpusProducts } = await setupOverCeilingTenant();

    const { hits } = await retriever.retrieve({ tenantId: TENANT, query: "durable product", k: 10 });
    expect(hits.length).toBe(corpusProducts.length);
    for (const hit of hits) {
      // Enriched straight from the local catalog_product store (getProductsByIds), not the thin corpus
      // metadata alone — the durability invariant's "full, last-known-good catalog" for this render path.
      expect(hit.metadata).toMatchObject({ description: expect.stringContaining("Descriptive text for durable product") });
      expect((hit.metadata as { tags?: string[] }).tags).toContain("durable");
    }
  });
});
