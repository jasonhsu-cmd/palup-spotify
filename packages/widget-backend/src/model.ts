import type { CatalogProductPort, CommercePort, GroundingPort, ModelPort, ProductFactsPort, RuntimeStatePort, SecretsPort, StoreProfilePort } from "@palup/platform-ports";
import {
  createRedactingModelPort,
  createCachingGroundingPort,
  createInMemoryStoreProfileStore,
  createInMemoryCatalogProductStore,
  createInMemoryProductFactsStore,
} from "@palup/platform-ports";
import { MockModelAdapter, StaticGroundingAdapter, MockCommerceAdapter } from "@palup/widget-brain";
import { createVertexAdapter, isVertexConfigured } from "@palup/model-vertex";
import { createLocalCatalogGroundingPort } from "./local-catalog-grounding.js";
import { createCustomerAccountCommerceAdapter } from "./shopify-customer-account-commerce.js";
import type { CustomerGrantStore } from "./customer-grant-store.js";

/**
 * Task 8 (durable-catalog-sync) — the per-tenant "is this tenant backfilled / locally served" decision,
 * MEMOIZED with a short TTL (coordinator review fix #2's own reasoning: `listByTenant(limit:1)` is a real
 * DB round-trip and a tenant is never un-backfilled, so a brief staleness window costs nothing but a short
 * delay before a newly-backfilled tenant benefits). Extracted to a standalone factory (Task 8b) so this
 * ONE decision instance can be shared between `createGroundingPort`'s own routing below AND the catalog
 * retriever's local-hydration seam (`catalog-retriever.ts`'s `localHydration.hasLocalCatalog`) — reusing
 * the memoization, not re-deriving "is this tenant backfilled" a second way that could drift from it.
 */
export function createLocalCatalogDecision(
  catalogProduct: CatalogProductPort,
  opts: { ttlMs?: number; now?: () => number } = {},
): (tenantId: string) => Promise<boolean> {
  const now = opts.now ?? (() => Date.now());
  const ttlMs = opts.ttlMs ?? 60_000;
  const cache = new Map<string, { isLocal: boolean; atMs: number }>();
  return async (tenantId: string): Promise<boolean> => {
    const cached = cache.get(tenantId);
    if (cached && now() - cached.atMs < ttlMs) return cached.isLocal;
    const isLocal = (await catalogProduct.listByTenant(tenantId, { limit: 1 })).length > 0;
    cache.set(tenantId, { isLocal, atMs: now() });
    return isLocal;
  };
}

// Composition root: pick the real Vertex adapter when GOOGLE_CLOUD_PROJECT is set, else the
// deterministic mock. Feature code only ever sees a ModelPort — it never knows which (ADR-0001).
// T8 (security-data-path §3): wrap whichever adapter in the PII-redaction guardrail so a payment
// card / SSN a shopper pastes never reaches the provider. The wrapper is transparent (same port).
export function createModelPort(): { port: ModelPort; name: string } {
  const { port, name } = isVertexConfigured()
    ? { port: createVertexAdapter(), name: "vertex/gemini" }
    : { port: new MockModelAdapter(), name: "mock" };
  return { port: createRedactingModelPort(port), name };
}

// Grounding source (ADR-0012, unified-cutover-cleanup 2026-08-24) — serving is ALWAYS local. Per request
// tenant: a BACKFILLED tenant (a non-empty `catalog_product` corpus — Task 7's Bulk-Operations backfill)
// is served entirely from `CatalogProductPort`/`ProductFactsPort`/`StoreProfilePort` (`model.ts`'s
// `createLocalCatalogGroundingPort` composition, no Shopify call on that path); a tenant that has NOT been
// backfilled falls back to the multi-tenant fixtures adapter. Wrapped in the caching + degradation layer
// (per-tenant TTL cache, hard timeouts, stale-while-error, fail-closed safe-empty). The whole thing stays
// behind GroundingPort.
//
// This used to ALSO route a backfilled-or-not tenant to a live Shopify Storefront call when the tenant had
// resolvable credentials (`resolveStorefrontCredential` + `createShopifyGroundingAdapter`, gated by the
// `localServingEnabled`/`catalogUnified` flags). The credential-enrollment-unification cutover (ADR-0023
// D1) made "serving is 100% local" the ONLY behavior; the owner then retired the flags entirely
// (unified-cutover-cleanup, 2026-08-24) and this file's live-Storefront-serving branch — along with it —
// became dead code and was deleted. `resolveStorefrontCredential`/`createShopifyGroundingAdapter` remain
// live for OTHER callers unrelated to this router (the WS2 sample-storefront catalog-page routes in
// server.ts, and `jobs/catalog-index.ts`'s sync-plane fetch) — see this task's own report for the full grep.
export function createGroundingPort(
  store: RuntimeStatePort,
  // Unused since the live-Storefront-serving branch was removed (unified-cutover-cleanup, 2026-08-24) —
  // kept in the signature to avoid a wider call-site churn across this composition root and its tests; a
  // future cleanup pass may drop it once every caller has been re-audited.
  secrets: SecretsPort,
  opts: {
    catalogProduct?: CatalogProductPort;
    productFacts?: ProductFactsPort;
    /**
     * The local `store_profile` brand+policy source `createLocalCatalogGroundingPort`'s `getContext`/
     * `getShell` always read. Absent ⇒ a fresh in-memory store (empty — degrades to the neutral default),
     * mirroring `catalogProduct`/`productFacts`'s own in-memory fallback below. The composition root
     * (server.ts) always wires a durable, migrated `PostgresStoreProfileStore` here in a real deployment.
     */
    storeProfile?: Pick<StoreProfilePort, "get">;
    /**
     * Coordinator review fix #2 — TTL (ms) for memoizing the per-tenant `hasLocalCatalog` decision below.
     * `createCachingGroundingPort` only caches `getContext`, so without this a `listByTenant(limit:1)` read
     * would run on EVERY `getShell`/`getProductsByIds` call for EVERY tenant (a hot-path DB round-trip that
     * serves no purpose once a tenant's backfill status is known). Default 60s. A tenant that becomes
     * backfilled mid-session may keep the fixtures path for up to this long — acceptable: a tenant is never
     * un-backfilled, so the only cost is a brief delay before it starts benefiting from local serving,
     * never a correctness/isolation issue.
     */
    localServingCacheTtlMs?: number;
    /** Injectable clock (ms) for deterministic tests of the memoization above. Default `Date.now`. */
    now?: () => number;
    /**
     * Task 8b — an already-built `createLocalCatalogDecision` instance, reused instead of building a new
     * one here. The composition root (server.ts) supplies this so the SAME memoized decision drives both
     * this router AND the catalog retriever's local-hydration seam. Absent ⇒ this function builds its own
     * internally.
     */
    hasLocalCatalog?: (tenantId: string) => Promise<boolean>;
  } = {},
): GroundingPort {
  const fixtures = new StaticGroundingAdapter();
  // In-memory fallbacks when the composition root does not inject its own durable handles — mirrors
  // `server.ts`'s own `localProductFacts`/`localCatalogProduct` in-memory-when-no-pool pattern, so a caller
  // that supplies nothing (most existing unit tests) gets a tenant that is simply never backfilled, i.e.
  // byte-identical to "always fixtures" — never a crash from a missing dependency.
  const catalogProduct = opts.catalogProduct ?? createInMemoryCatalogProductStore();
  const productFacts = opts.productFacts ?? createInMemoryProductFactsStore();
  const local = createLocalCatalogGroundingPort({
    catalogProduct,
    productFacts,
    storeProfile: opts.storeProfile ?? createInMemoryStoreProfileStore(),
  });
  // MEMOIZED (coordinator review fix #2): `createCachingGroundingPort` below only caches `getContext`, so
  // `getShell`/`getProductsByIds` would otherwise re-run this `listByTenant` read on every single call — an
  // unnecessary DB round-trip on a hot path, for every tenant, backfilled or not. A tenant is never
  // un-backfilled, so a short, process-local TTL cache is safe: the only observable effect of staleness is
  // a newly-backfilled tenant keeping the fixtures path for up to `ttlMs` longer than strictly necessary.
  const hasLocalCatalog =
    opts.hasLocalCatalog ?? createLocalCatalogDecision(catalogProduct, { ttlMs: opts.localServingCacheTtlMs, now: opts.now });
  const router: GroundingPort = {
    async getContext(tenantId) {
      return (await hasLocalCatalog(tenantId)) ? local.getContext(tenantId) : fixtures.getContext(tenantId);
    },
    async getShell(tenantId) {
      return (await hasLocalCatalog(tenantId)) ? local.getShell(tenantId) : fixtures.getShell(tenantId);
    },
    async getProductsByIds(tenantId, ids) {
      return (await hasLocalCatalog(tenantId)) ? local.getProductsByIds(tenantId, ids) : fixtures.getProductsByIds(tenantId, ids);
    },
  };
  return createCachingGroundingPort(router, store);
}

// Commerce source: mock orders/policy/subscription by default; the Shopify Customer Account API (CAA)
// adapter (ADR-0018 task 8) swaps in behind the SAME port once a shopper has signed in AND the deployment
// has CAA fully configured. `isLive` (ADR-0017 T7 capability marker) tells the ADR-0016 fail-closed guard
// (commerce-guard.ts) whether this IS a real/live adapter — false for the mock (a tested no-op for that
// slice), true for the CAA adapter, at which point the guard's fail-closed check activates automatically.
//
// Wave-1 E (revenue-flywheel) — DEFAULT-OFF, ships dark: `deps.caaEnabled` mirrors server.ts's own
// `CAA_ENABLED` (SHOPPER_AUTH + WIDGET_AUTH_REQUIRED + a configured redirect_uri + shopper-token secret,
// all individually load-bearing). No args (or `caaEnabled` false/absent, or `grants`/`shopDomainForTenant`
// missing) ⇒ byte-identical to before this change — the mock, `isLive:false`. Regression-locked by
// widget-backend/test/commerce-fixture-marker.test.ts (calls this with NO ARGS) and
// widget-backend/test/commerce-port-caa-wiring.test.ts (explicit `caaEnabled:false`/omitted cases).
export interface CommercePortDeps {
  /** ADR-0018 task 8 — the custodied per-shopper OAuth grant store. Required (with `shopDomainForTenant`)
   * to construct the live adapter; its absence alone is enough to stay on the mock. */
  grants?: CustomerGrantStore;
  /** tenant → its `*.myshopify.com` domain — mirrors `MerchantResolver.shopDomainFor` (async) or
   * `parseStoreDomains` (sync); `createCustomerAccountCommerceAdapter` awaits either. */
  shopDomainForTenant?: (tenant: string) => string | undefined | Promise<string | undefined>;
  /** Mirrors server.ts's `CAA_ENABLED` posture. Default OFF ⇒ this stays the mock (ships dark). */
  caaEnabled?: boolean;
  /** Injectable outbound fetch for the live adapter's discovery + GraphQL calls (mirrors `caaFetch` in
   * server.ts). Prod uses the live global fetch (the adapter's own default). */
  fetchFn?: typeof globalThis.fetch;
  /** Test seam: override the mock fallback. getPolicy + the ADR-0016 subscription WRITES always delegate
   * here — on the live path too — because those stay human-routed until ADR-0016 enactment, a separate
   * build. Defaults to a fresh fixture-marked MockCommerceAdapter, same as the pre-Wave-1-E behavior. */
  fallback?: CommercePort;
}

export function createCommercePort(deps: CommercePortDeps = {}): { port: CommercePort; isLive: boolean } {
  // `fixtureData: true` is what stops the support path from stating DEMO order/account facts to real
  // shoppers. Without it this composition root was serving "I've confirmed order #1042 is on your
  // account" — a confident false claim about a real person's account — because the brain's fallback
  // shopper id is the very id that owns the fixtures, so the ownership check passed.
  //
  // KEEP THIS SET for as long as this is the port shoppers are actually served by. A live adapter simply
  // never passes the flag (it is not fixture data), at which point the guard in support.ts stops firing.
  const fallback = deps.fallback ?? new MockCommerceAdapter({ fixtureData: true });
  if (deps.caaEnabled && deps.grants && deps.shopDomainForTenant) {
    return {
      port: createCustomerAccountCommerceAdapter({
        grants: deps.grants,
        shopDomainForTenant: deps.shopDomainForTenant,
        fallback,
        fetchFn: deps.fetchFn,
      }),
      isLive: true,
    };
  }
  return { port: fallback, isLive: false };
}
