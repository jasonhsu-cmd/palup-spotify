import { describe, it, expect, vi, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import {
  InMemoryRuntimeStore,
  createInMemoryMerchantRegistry,
  createInMemoryCatalogProductStore,
  createInMemoryStoreProfileStore,
} from "@palup/platform-ports";
import type { CatalogProductPort, StoreProfilePort } from "@palup/platform-ports";
import type { AdminTokenStore } from "@palup/state-postgres";
import { buildServer } from "../src/server.js";
import { SHOPIFY_APP_CLIENT_SECRET_NAME, SHOPIFY_APP_SECRET_SCOPE } from "../src/shopify-install-identity.js";
import { tenantIdForShop } from "../src/routes/shopify-install.js";
import { runCatalogSyncScheduler, type CatalogSyncSchedulerDeps } from "../src/jobs/catalog-sync-scheduler.js";

// Task 7 (credential-enrollment-unification) — proves the CATALOG_UNIFIED cutover flag's OWN
// composition-root wiring in server.ts, on top of the already-shipped durable-catalog-sync seams
// (localServingEnabled/hasLocalCatalog — server-catalog-sync-wiring.test.ts covers those). Four things,
// each with a flag-OFF byte-identical regression pin alongside it:
//
//   (a)+(c)+T4b — serving is 100% local for a backfilled tenant when the flag is ON: no Storefront call
//       for products (Task 8, unaffected by this flag) AND brand/policy come from the injected
//       `store_profile` handle (not `shellSource`/fixtures) — proving BOTH the persistent-handle wiring
//       into `createGroundingPort` AND `local-catalog-grounding.ts`'s `getContext` reading it. OFF: the
//       injected `store_profile` handle is never even consulted — brand/policy stay on `shellSource`/
//       fixtures exactly as before this task.
//   (b) — install does NOT mint/custody a delegate token when ON (Admin token is the sole credential);
//       OFF mints+custodies the delegate exactly as always (regression pin).
//   (d) — the catalog-sync scheduler's deps are composed with the REAL `listActive`-backed merchant
//       registry when ON; OFF ⇒ nothing is composed at all (unchanged from before this task — nothing
//       built this before Task 7 either).

const TENANT = "demo";

function fakeAdminTokenStore(): AdminTokenStore {
  return {
    put: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    async read() {
      return { status: "missing" };
    },
    async refresh() {},
  };
}

/** The grounding cache row `createCachingGroundingPort` writes — poll briefly (mirrors
 *  server-readback.test.ts's identical helper) rather than assume it has landed. */
async function pollGroundingCache(
  store: InMemoryRuntimeStore,
  tenantId: string,
): Promise<{ ctx: { brandName: string; products: { title: string }[] } } | null> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const row = await store.get<{ ctx: { brandName: string; products: { title: string }[] } }>({ tenantId }, "grounding", "context");
    if (row) return row;
    await new Promise((r) => setTimeout(r, 5));
  }
  return null;
}

function seedCatalogProduct(store: CatalogProductPort, tenantId: string, title: string): Promise<void> {
  return store.upsertMany(tenantId, [
    {
      productId: "gid://shopify/Product/1",
      handle: "unified-serum",
      title,
      status: "active",
      variants: [{ variantId: "gid://shopify/ProductVariant/1", price: "19.99", availableForSale: true }],
      contentHash: "h1",
      syncedAt: new Date().toISOString(),
    },
  ]);
}

const SERVING_ENV_KEYS = ["CATALOG_UNIFIED", "CATALOG_LOCAL_SERVING", "ADMIN_TOKEN_CUSTODY_ENABLED"];
const savedServingEnv: Record<string, string | undefined> = {};
for (const k of SERVING_ENV_KEYS) savedServingEnv[k] = process.env[k];
afterEach(() => {
  for (const k of SERVING_ENV_KEYS) {
    if (savedServingEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedServingEnv[k];
  }
});

describe("CATALOG_UNIFIED — serving (local port, local store_profile, no Storefront call)", () => {
  it("flag ON: a backfilled tenant serves products locally AND brand/policy from the injected store_profile — shopifyFetch is never called", async () => {
    process.env.CATALOG_UNIFIED = "true";
    process.env.ADMIN_TOKEN_CUSTODY_ENABLED = "true";

    const store = new InMemoryRuntimeStore();
    const catalogProduct: CatalogProductPort = createInMemoryCatalogProductStore();
    await seedCatalogProduct(catalogProduct, TENANT, "Unified Serum");
    const storeProfile: StoreProfilePort = createInMemoryStoreProfileStore();
    await storeProfile.put(TENANT, { brandName: "Unified Co", policy: { returns: "30d unified", shipping: "free unified" } });

    let shopifyFetchCalled = false;
    const app = await buildServer({
      store,
      catalogProduct,
      storeProfile,
      adminTokens: fakeAdminTokenStore(),
      shopifyFetch: async () => {
        shopifyFetchCalled = true;
        throw new Error("Storefront must not be called under CATALOG_UNIFIED for a backfilled tenant");
      },
    });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/chat",
        payload: { sessionId: "sess-unified-on", message: "hi", signals: {}, idempotencyKey: "unified-on-0" },
      });
      expect(res.statusCode).toBe(200);
      expect(shopifyFetchCalled).toBe(false);

      const row = await pollGroundingCache(store, TENANT);
      expect(row).not.toBeNull();
      // Brand/policy from the local store_profile handle (T4b) — NOT the "Auria" static fixture.
      expect(row!.ctx.brandName).toBe("Unified Co");
      // Products from the local catalog_product store (Task 8, unaffected by this flag).
      expect(row!.ctx.products.map((p) => p.title)).toContain("Unified Serum");
    } finally {
      await app.close();
    }
  });

  it("flag OFF: byte-identical — the SAME injected store_profile handle is never consulted; brand/policy stay on shellSource/fixtures", async () => {
    delete process.env.CATALOG_UNIFIED;
    delete process.env.ADMIN_TOKEN_CUSTODY_ENABLED;

    const store = new InMemoryRuntimeStore();
    const catalogProduct: CatalogProductPort = createInMemoryCatalogProductStore();
    await seedCatalogProduct(catalogProduct, TENANT, "Unified Serum");
    const storeProfile: StoreProfilePort = createInMemoryStoreProfileStore();
    await storeProfile.put(TENANT, { brandName: "Unified Co", policy: { returns: "30d unified", shipping: "free unified" } });

    let shopifyFetchCalled = false;
    const app = await buildServer({
      store,
      catalogProduct,
      storeProfile, // injected, but must be IGNORED entirely with the flag off
      shopifyFetch: async () => {
        shopifyFetchCalled = true;
        return { shop: { name: "Should Not Be Used" }, products: { nodes: [] } };
      },
    });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/chat",
        payload: { sessionId: "sess-unified-off", message: "hi", signals: {}, idempotencyKey: "unified-off-0" },
      });
      expect(res.statusCode).toBe(200);
      // Task 8's local-PRODUCT serving is independent of CATALOG_UNIFIED and defaults on — still no
      // Shopify call for products.
      expect(shopifyFetchCalled).toBe(false);

      const row = await pollGroundingCache(store, TENANT);
      expect(row).not.toBeNull();
      // Brand/policy still come from shellSource -> the built-in "demo" fixture, NOT the injected
      // store_profile — proving the persistent handle is CATALOG_UNIFIED-gated, not always-consulted.
      expect(row!.ctx.brandName).toBe("Auria");
      expect(row!.ctx.brandName).not.toBe("Unified Co");
      expect(row!.ctx.products.map((p) => p.title)).toContain("Unified Serum");
    } finally {
      await app.close();
    }
  });

  // Final-review Critical (2026-08-24): unlike `getContext` above, `local-catalog-grounding.ts`'s
  // `getShell` was NOT gated on `unifiedLocalShell` — it always read the local `store_profile` store no
  // matter the flag. With CATALOG_UNIFIED off (this test) and CATALOG_LOCAL_SERVING at its default-ON, a
  // BACKFILLED tenant's `getShell` therefore read the brand-new, permanently-EMPTY `store_profile` this
  // composition falls back to when the flag is off (server.ts's `catalogUnifiedStoreProfile` stays
  // `undefined` -> `createGroundingPort`'s own `opts.storeProfile ?? createInMemoryStoreProfileStore()`),
  // instead of degrading to the real shellSource/fixtures shell `getContext` already correctly falls back
  // to. Concretely this broke the `policy_q` support intent (widget-brain/support.ts calls
  // `grounding.getShell` directly, ungated by any commerce port): a shopper asking "what's your return
  // policy?" got "Our return policy: . Shipping: " (the blank FALLBACK_POLICY) instead of the real policy.
  // Driven through the REAL composition + a REAL shopper message (not just the grounding port directly)
  // so this pins the shopper-facing symptom, not merely the internal routing.
  it("flag OFF: a backfilled tenant's policy_q reply uses the REAL shell (fixtures/shellSource), never a blank empty-store_profile fallback", async () => {
    delete process.env.CATALOG_UNIFIED;
    delete process.env.CATALOG_LOCAL_SERVING; // exercise the documented default (ON)
    delete process.env.ADMIN_TOKEN_CUSTODY_ENABLED;

    const store = new InMemoryRuntimeStore();
    const catalogProduct: CatalogProductPort = createInMemoryCatalogProductStore();
    await seedCatalogProduct(catalogProduct, TENANT, "Unified Serum"); // backfilled -> hasLocalCatalog() = true

    const app = await buildServer({
      store,
      catalogProduct,
      adminTokens: fakeAdminTokenStore(),
      // No `storeProfile` injected at all — mirrors production exactly: with CATALOG_UNIFIED off, server.ts
      // never wires a persisted store_profile handle, so `createGroundingPort` defaults to a brand-new,
      // permanently-empty in-memory store. A `getShell` that (incorrectly) reads it unconditionally always
      // finds nothing there and degrades to FALLBACK_BRAND/FALLBACK_POLICY.
    });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/chat",
        payload: { sessionId: "sess-policyq-off", message: "what's your return policy?", signals: {}, idempotencyKey: "policyq-off-0" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { reply: string };
      // TENANT is "demo" -> the built-in AURIA fixture's real (non-blank) policy.
      expect(body.reply).toContain("30-day returns");
      expect(body.reply).not.toBe("Our return policy:  Shipping: "); // the blank FALLBACK_POLICY reply
    } finally {
      await app.close();
    }
  });
});

const SHOP_ON = "acme-unified-on.myshopify.com";
const SHOP_OFF = "acme-unified-off.myshopify.com";
const APP_SECRET = "app-client-secret-never-logged";
const CLIENT_ID = "client-123";
const REDIRECT_URI = "https://widget.palup.ai/shopify/callback";
const PARENT_TOKEN = "shpat_UNIFIED_PARENT_TOKEN_NEVER_LOGGED";
const DELEGATE_TOKEN = "shpca_UNIFIED_DELEGATE_TOKEN_NEVER_LOGGED";
const AUTH_CODE = "authorization-code-unified-never-logged";
const GRANTED_SCOPES = "unauthenticated_read_product_listings";

const INSTALL_ENV_KEYS = [
  "SHOPIFY_APP_CLIENT_ID",
  "SHOPIFY_INSTALL_REDIRECT_URI",
  "SHOPIFY_INSTALL_REGION",
  "PALUP_SECRETS",
  "CATALOG_UNIFIED",
  "ADMIN_TOKEN_CUSTODY_ENABLED",
];
const savedInstallEnv: Record<string, string | undefined> = {};
for (const k of INSTALL_ENV_KEYS) savedInstallEnv[k] = process.env[k];
afterEach(() => {
  for (const k of INSTALL_ENV_KEYS) {
    if (savedInstallEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedInstallEnv[k];
  }
});

function sign(query: Record<string, string>, secret = APP_SECRET): string {
  const sp = new URLSearchParams();
  for (const k of Object.keys(query)
    .filter((x) => x !== "hmac")
    .sort((a, b) => a.localeCompare(b))) {
    sp.append(k, query[k]);
  }
  return createHmac("sha256", secret).update(sp.toString().replace(/\+/g, "%20")).digest("hex");
}

function qs(query: Record<string, string>): string {
  const sp = new URLSearchParams(query);
  sp.set("hmac", sign(query));
  return sp.toString();
}

function cookieFrom(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers["set-cookie"];
  const first = Array.isArray(raw) ? raw[0] : (raw as string | undefined);
  return String(first).split(";")[0];
}

/** Records EVERY outbound call; a `/graphql.json` POST whose body mentions `delegateAccessTokenCreate` is
 *  recorded as that literal string, so a test can assert on its PRESENCE/ABSENCE without parsing bodies. */
function installFetchImpl(calls: string[]): typeof globalThis.fetch {
  return (async (url: unknown, init?: unknown) => {
    const u = String(url);
    const body = (init as RequestInit | undefined)?.body;
    const bodyStr = typeof body === "string" ? body : "";
    if (u.endsWith("/admin/oauth/access_token")) {
      calls.push(u);
      return { ok: true, status: 200, json: async () => ({ access_token: PARENT_TOKEN, scope: GRANTED_SCOPES }) };
    }
    if (u.includes("/graphql.json")) {
      if (bodyStr.includes("delegateAccessTokenCreate")) {
        calls.push("delegateAccessTokenCreate");
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: { delegateAccessTokenCreate: { delegateAccessToken: { accessToken: DELEGATE_TOKEN, accessScopes: [GRANTED_SCOPES] }, userErrors: [] } },
          }),
        };
      }
      calls.push(u);
      return { ok: true, status: 200, json: async () => ({ data: {} }) };
    }
    calls.push(u);
    return { ok: false, status: 404, json: async () => ({}) };
  }) as unknown as typeof globalThis.fetch;
}

async function runInstall(app: Awaited<ReturnType<typeof buildServer>>, shop: string): Promise<{ statusCode: number }> {
  const beginRes = await app.inject({
    method: "GET",
    url: `/shopify/install?${qs({ shop, timestamp: String(Math.floor(Date.now() / 1000)) })}`,
  });
  const state = new URL(beginRes.headers.location as string).searchParams.get("state")!;
  const cookie = cookieFrom(beginRes as unknown as { headers: Record<string, unknown> });
  const cbRes = await app.inject({
    method: "GET",
    url: `/shopify/callback?${qs({ code: AUTH_CODE, host: "aG9zdA", shop, state, timestamp: String(Math.floor(Date.now() / 1000)) })}`,
    headers: { cookie },
  });
  return { statusCode: cbRes.statusCode };
}

function baseSecrets(): string {
  return JSON.stringify({ [SHOPIFY_APP_SECRET_SCOPE]: { [SHOPIFY_APP_CLIENT_SECRET_NAME]: APP_SECRET } });
}

describe("CATALOG_UNIFIED cutover — install (ADR-0023 D1: Admin token is the sole credential)", () => {
  it("flag ON: does NOT mint or custody a delegate token; the Admin token IS custodied", async () => {
    process.env.SHOPIFY_APP_CLIENT_ID = CLIENT_ID;
    process.env.SHOPIFY_INSTALL_REDIRECT_URI = REDIRECT_URI;
    process.env.SHOPIFY_INSTALL_REGION = "us";
    process.env.PALUP_SECRETS = baseSecrets();
    process.env.CATALOG_UNIFIED = "true";
    process.env.ADMIN_TOKEN_CUSTODY_ENABLED = "true";

    const calls: string[] = [];
    const delegateSinkPut = vi.fn(async () => {});
    const adminPut = vi.fn(async () => {});
    const registry = createInMemoryMerchantRegistry();

    const app = await buildServer({
      store: new InMemoryRuntimeStore(),
      merchantRegistry: registry,
      installFetch: installFetchImpl(calls),
      merchantCredentials: { put: delegateSinkPut },
      adminTokens: { put: adminPut, delete: vi.fn(async () => {}), async read() { return { status: "missing" }; }, async refresh() {} },
    });
    try {
      const { statusCode } = await runInstall(app, SHOP_ON);
      expect(statusCode).toBe(200);

      expect(calls).not.toContain("delegateAccessTokenCreate");
      expect(delegateSinkPut).not.toHaveBeenCalled();
      expect(adminPut).toHaveBeenCalledTimes(1);
      expect(adminPut).toHaveBeenCalledWith(tenantIdForShop(SHOP_ON), PARENT_TOKEN, expect.objectContaining({ actor: "system:shopify-install" }));

      const rec = await registry.lookupByShopDomain(SHOP_ON);
      expect(rec?.status).toBe("active");
    } finally {
      await app.close();
    }
  });

  it("flag OFF: byte-identical — the delegate token IS minted and custodied (regression pin)", async () => {
    process.env.SHOPIFY_APP_CLIENT_ID = CLIENT_ID;
    process.env.SHOPIFY_INSTALL_REDIRECT_URI = REDIRECT_URI;
    process.env.SHOPIFY_INSTALL_REGION = "us";
    process.env.PALUP_SECRETS = baseSecrets();
    delete process.env.CATALOG_UNIFIED;
    delete process.env.ADMIN_TOKEN_CUSTODY_ENABLED;

    const calls: string[] = [];
    const delegateSinkPut = vi.fn(async () => {});
    const app = await buildServer({
      store: new InMemoryRuntimeStore(),
      merchantRegistry: createInMemoryMerchantRegistry(),
      installFetch: installFetchImpl(calls),
      merchantCredentials: { put: delegateSinkPut },
    });
    try {
      const { statusCode } = await runInstall(app, SHOP_OFF);
      expect(statusCode).toBe(200);

      expect(calls).toContain("delegateAccessTokenCreate");
      expect(delegateSinkPut).toHaveBeenCalledTimes(1);
      expect(delegateSinkPut).toHaveBeenCalledWith(tenantIdForShop(SHOP_OFF), DELEGATE_TOKEN, expect.objectContaining({ actor: "system:shopify-install" }));
    } finally {
      await app.close();
    }
  });
});

describe("CATALOG_UNIFIED cutover — catalog-sync scheduler (CARRY T5, listActive enumeration)", () => {
  it("flag ON: catalogSyncSchedulerDeps is composed with the REAL listActive-backed registry; running it enumerates every active tenant", async () => {
    process.env.CATALOG_UNIFIED = "true";
    process.env.ADMIN_TOKEN_CUSTODY_ENABLED = "true";

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
      // The REAL listActive-backed registry object — not a substitute/rebuilt one.
      expect(deps!.registry).toBe(registry);

      const report = await runCatalogSyncScheduler(deps!);
      expect(backfillCalls.slice().sort()).toEqual(["alpha", "beta"]);
      expect(report.results.map((r) => r.tenantId).sort()).toEqual(["alpha", "beta"]);
    } finally {
      await app.close();
    }
  });

  it("flag OFF: catalogSyncSchedulerDeps is not constructed at all (unchanged — nothing built this before Task 7 either)", async () => {
    delete process.env.CATALOG_UNIFIED;
    delete process.env.ADMIN_TOKEN_CUSTODY_ENABLED;
    const app = await buildServer({ store: new InMemoryRuntimeStore() });
    try {
      const deps = (app as unknown as { catalogSyncSchedulerDeps?: CatalogSyncSchedulerDeps }).catalogSyncSchedulerDeps;
      expect(deps).toBeUndefined();
      // Flag-off byte-identical guarantee: the returned `app` must not even gain the own-property (value
      // `undefined`) — it must be genuinely absent, not present-but-undefined.
      expect(Object.prototype.hasOwnProperty.call(app, "catalogSyncSchedulerDeps")).toBe(false);
    } finally {
      await app.close();
    }
  });
});
