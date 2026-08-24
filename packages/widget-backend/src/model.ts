import type { CatalogProductPort, CommercePort, GroundingContext, GroundingPort, GroundingShell, ModelPort, Product, ProductFactsPort, RuntimeStatePort, SecretsPort, StoreProfilePort } from "@palup/platform-ports";
import { createRedactingModelPort, createCachingGroundingPort, createInMemoryStoreProfileStore } from "@palup/platform-ports";
import { MockModelAdapter, StaticGroundingAdapter, MockCommerceAdapter } from "@palup/widget-brain";
import { createVertexAdapter, isVertexConfigured } from "@palup/model-vertex";
import type { MerchantCredentialRead } from "@palup/state-postgres";
import { resolveStorefrontCredential } from "./merchant-store.js";
import { createShopifyGroundingAdapter, type StorefrontFetch, type StorefrontShellFetch } from "./shopify-grounding.js";
import { createLocalCatalogGroundingPort } from "./local-catalog-grounding.js";
import { createCustomerAccountCommerceAdapter } from "./shopify-customer-account-commerce.js";
import type { CustomerGrantStore } from "./customer-grant-store.js";

// D2: the router refuses rather than silently falling back to fixtures when a custodied credential
// exists but cannot be read back (undecryptable / malformed) — never serve a merchant's shoppers the
// wrong brand's catalog. The caching wrapper below degrades a cold throw to safe-empty defensively; a
// graceful shopper-facing "unavailable" surface is a later task's pre-flight, not this router's job.
export class GroundingCredentialUnreadableError extends Error {
  constructor(public readonly reason: "undecryptable" | "malformed-record") {
    super(`grounding credential unreadable: ${reason}`);
    this.name = "GroundingCredentialUnreadableError";
  }
}

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

// Grounding source (ADR-0012). Per request tenant, route to the merchant's Shopify store when its
// credentials resolve (via the SecretsPort), else fall back to the multi-tenant fixtures adapter —
// mirrors isVertexConfigured() for the model port, but per-tenant. Wrapped in the caching + degradation
// layer (per-tenant TTL cache, hard timeouts, stale-while-error, fail-closed safe-empty). The whole
// thing stays behind GroundingPort. During rollout no tenant has Shopify creds ⇒ everyone gets fixtures.
//
// D1 — the SHOP DOMAIN now comes through the merchant resolver (`opts.shopDomainFor`), so a revoked
// merchant's catalog can no longer be pulled into a prompt from a stale `SHOPIFY_STORES` entry. The TOKEN
// is unchanged: still `SecretsPort` (see resolveShopifyStore's own doc comment for why, and for what that
// means for a merchant who installs through C1).
export function createGroundingPort(
  store: RuntimeStatePort,
  secrets: SecretsPort,
  opts: {
    shopifyFetch?: StorefrontFetch; // injectable for tests; defaults to the live Storefront call
    /** S2 — the shell-only (brand+policy, no products) fetch. Injectable for tests; defaults to the live single-round-trip Storefront call, mirroring `shopifyFetch` above. */
    shopifyShellFetch?: StorefrontShellFetch;
    /** D1: registry-first shop-domain resolution. Absent ⇒ the pre-D1 `SHOPIFY_STORES`-only path. */
    shopDomainFor?: (tenantId: string) => Promise<string | undefined>;
    /** D2: the custodied delegate credential store's read(). Consulted only when `readbackEnabled`. */
    credRead?: (tenantId: string) => Promise<MerchantCredentialRead>;
    /** D2: gates the read-back path above; off ⇒ unchanged SecretsPort-only resolution. */
    readbackEnabled?: boolean;
    /**
     * Task 8 (durable-catalog-sync, §3/§13.4) — the local-serving deps + gate. All three of
     * `localServingEnabled`/`catalogProduct`/`productFacts` must be present for a tenant to ever be routed
     * to `createLocalCatalogGroundingPort`; any one absent (the default) leaves this function byte-identical
     * to before this task. See the per-tenant gate below `shopifyOrFixtures` for the routing rule itself.
     */
    localServingEnabled?: boolean;
    catalogProduct?: CatalogProductPort;
    productFacts?: ProductFactsPort;
    /**
     * Task 4 (credential-enrollment-unification) — the local `store_profile` brand+policy source
     * `createLocalCatalogGroundingPort`'s `getShell` now reads instead of `shellSource`. Absent (the
     * default) falls back to an empty in-memory store below, so `getShell` degrades to the same neutral
     * default it always has — wiring a real, persistent `StoreProfilePort` into this composition root is
     * Task 7/9's job, not this task's (byte-identical to before this task until that lands).
     */
    storeProfile?: Pick<StoreProfilePort, "get">;
    /**
     * Coordinator review fix #2 — TTL (ms) for memoizing the per-tenant `hasLocalCatalog` decision below.
     * `createCachingGroundingPort` only caches `getContext`, so without this a `listByTenant(limit:1)` read
     * would run on EVERY `getShell`/`getProductsByIds` call for EVERY tenant (a hot-path DB round-trip that
     * serves no purpose once a tenant's backfill status is known). Default 60s. A tenant that becomes
     * backfilled mid-session may keep the storefront path for up to this long — acceptable: a tenant is
     * never un-backfilled, so the only cost is a brief delay before it starts benefiting from local serving,
     * never a correctness/isolation issue.
     */
    localServingCacheTtlMs?: number;
    /** Injectable clock (ms) for deterministic tests of the memoization above. Default `Date.now`. */
    now?: () => number;
    /**
     * Task 8b — an already-built `createLocalCatalogDecision` instance, reused instead of building a new
     * one here. The composition root (server.ts) supplies this so the SAME memoized decision drives both
     * this router AND the catalog retriever's local-hydration seam. Absent ⇒ this function builds its own
     * internally (byte-identical to before this task) — every pre-existing caller that does not pass this
     * is unaffected.
     */
    hasLocalCatalog?: (tenantId: string) => Promise<boolean>;
  } = {},
): GroundingPort {
  const fixtures = new StaticGroundingAdapter();
  // The PRE-Task-8 router, unchanged: per-tenant Shopify-or-fixtures, exactly as before. Kept as its own
  // value (not inlined) for two reasons: it is the fallback for a tenant that has NOT been backfilled, and
  // — Task 8's brand/policy gap (see local-catalog-grounding.ts's file banner) — it is also the `shellSource`
  // a BACKFILLED tenant's local port reads brand+policy from, so both paths share one credential-resolution
  // implementation rather than two that could drift.
  const shopifyOrFixtures: GroundingPort = {
    async getContext(tenantId: string): Promise<GroundingContext> {
      // tenantId here is the SERVER-DERIVED request tenant (threaded from the verified widget token via
      // the brain) — never client input, so one merchant can never resolve another's store creds.
      const outcome = await resolveStorefrontCredential(tenantId, {
        secrets,
        credRead: opts.credRead,
        readbackEnabled: opts.readbackEnabled,
        shopDomainFor: opts.shopDomainFor,
      });
      if (outcome.status === "live")
        return createShopifyGroundingAdapter(outcome.creds, opts.shopifyFetch).getContext(tenantId);
      if (outcome.status === "refuse") throw new GroundingCredentialUnreadableError(outcome.reason);
      return fixtures.getContext(tenantId);
    },
    async getShell(tenantId: string): Promise<GroundingShell> {
      const outcome = await resolveStorefrontCredential(tenantId, {
        secrets,
        credRead: opts.credRead,
        readbackEnabled: opts.readbackEnabled,
        shopDomainFor: opts.shopDomainFor,
      });
      if (outcome.status === "live")
        return createShopifyGroundingAdapter(outcome.creds, opts.shopifyFetch, opts.shopifyShellFetch).getShell(tenantId);
      if (outcome.status === "refuse") throw new GroundingCredentialUnreadableError(outcome.reason);
      return fixtures.getShell(tenantId);
    },
    async getProductsByIds(tenantId: string, ids: string[]): Promise<Product[]> {
      const outcome = await resolveStorefrontCredential(tenantId, {
        secrets,
        credRead: opts.credRead,
        readbackEnabled: opts.readbackEnabled,
        shopDomainFor: opts.shopDomainFor,
      });
      if (outcome.status === "live")
        return createShopifyGroundingAdapter(outcome.creds, opts.shopifyFetch, opts.shopifyShellFetch).getProductsByIds(tenantId, ids);
      if (outcome.status === "refuse") throw new GroundingCredentialUnreadableError(outcome.reason);
      return fixtures.getProductsByIds(tenantId, ids);
    },
  };

  let router: GroundingPort = shopifyOrFixtures;
  if (opts.localServingEnabled && opts.catalogProduct && opts.productFacts) {
    const catalogProduct = opts.catalogProduct;
    const local = createLocalCatalogGroundingPort({
      catalogProduct,
      productFacts: opts.productFacts,
      shellSource: shopifyOrFixtures,
      storeProfile: opts.storeProfile ?? createInMemoryStoreProfileStore(),
    });
    // Controller ruling (per-tenant gating, load-bearing) — local serving is active ONLY for a tenant that
    // HAS a `catalog_product` corpus (backfilled), detected via a non-empty `listByTenant`. A tenant with
    // none (not yet backfilled) keeps `shopifyOrFixtures` UNCHANGED, so flipping `CATALOG_LOCAL_SERVING` on
    // globally never blanks a currently-working ≤1000-SKU tenant that has not gone through Task 7's backfill.
    //
    // MEMOIZED (coordinator review fix #2): `createCachingGroundingPort` below only caches `getContext`,
    // so `getShell`/`getProductsByIds` would otherwise re-run this `listByTenant` read on every single call
    // — an unnecessary DB round-trip on a hot path, for every tenant, backfilled or not. A tenant is never
    // un-backfilled, so a short, process-local TTL cache is safe: the only observable effect of staleness is
    // a newly-backfilled tenant keeping the storefront path for up to `ttlMs` longer than strictly necessary.
    const hasLocalCatalog =
      opts.hasLocalCatalog ?? createLocalCatalogDecision(catalogProduct, { ttlMs: opts.localServingCacheTtlMs, now: opts.now });
    router = {
      async getContext(tenantId) {
        return (await hasLocalCatalog(tenantId)) ? local.getContext(tenantId) : shopifyOrFixtures.getContext(tenantId);
      },
      async getShell(tenantId) {
        return (await hasLocalCatalog(tenantId)) ? local.getShell(tenantId) : shopifyOrFixtures.getShell(tenantId);
      },
      async getProductsByIds(tenantId, ids) {
        return (await hasLocalCatalog(tenantId)) ? local.getProductsByIds(tenantId, ids) : shopifyOrFixtures.getProductsByIds(tenantId, ids);
      },
    };
  }
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
