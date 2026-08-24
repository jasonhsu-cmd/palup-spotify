import { describe, it, expect, vi, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import {
  InMemoryRuntimeStore,
  createInMemoryMerchantRegistry,
  createInMemoryCatalogProductStore,
  createAesGcmCrypto,
  createEnvSecrets,
  keyScopeSecretName,
} from "@palup/platform-ports";
import type { RuntimeStatePort, MerchantRegistryPort, CatalogProductPort } from "@palup/platform-ports";
import { createAdminTokenStore, ADMIN_CRED_KEY_SCOPE, MERCHANT_CRED_KEY_SCOPE } from "@palup/state-postgres";
import type { AdminTokenStore } from "@palup/state-postgres";
import { buildServer } from "../src/server.js";
import { SHOPIFY_APP_CLIENT_SECRET_NAME, SHOPIFY_APP_SECRET_SCOPE } from "../src/shopify-install-identity.js";
import { WEBHOOK_ROUTES } from "../src/routes/shopify-webhooks.js";
import { tenantIdForShop } from "../src/routes/shopify-install.js";

// Task 13 — proves buildServer's OWN composition-root wiring for the durable catalog-sync subsystem:
//   (a) ADMIN_TOKEN_CUSTODY_ENABLED gates constructing/injecting an AdminTokenStore into the REAL install
//       (put) and shop/redact webhook (delete) flows, honoring the `opts.adminTokens` test seam when given;
//   (b) absent that seam AND with the flag on, the composition root builds its OWN AdminTokenStore under
//       the DISTINCT `adminCredCrypto()` scope (ADR-0022 F2) — proven by provisioning ONLY the
//       admin-cred-scoped secret name and independently reading the row back through the same scope;
//   (c) `localCatalogProduct` (Task 8) is threaded into shop/redact's teardown UNCONDITIONALLY (a
//       compliance action, not gated on CATALOG_BACKFILL_ENABLED/CATALOG_LOCAL_SERVING);
//   (d) CATALOG_BACKFILL_ENABLED does not break composition either way (on/off).
//
// This file deliberately does NOT re-prove the deep behavioral properties already covered elsewhere:
// admin-token custody mechanics + F7 shop-binding (shopify-install-admin-token.test.ts), the two-step
// reversible/irreversible teardown split (shopify-webhooks-admin-token.test.ts), and catalog_product write
// correctness once wired (catalog-index-catalog-product.test.ts, catalog-backfill.test.ts). It also does
// NOT attempt an end-to-end proof that CATALOG_BACKFILL_ENABLED reaches `reconcileDeps.catalogProduct` via
// a live webhook→queue→reconcile delivery: that pipeline calls real Shopify Storefront fetchers
// (`shopifyCatalogSource`/`shopifyCatalogByIdSource`) with no fetch-injection seam, which is exactly why
// the pre-existing `shopify-webhooks-catalog.test.ts` (testing the SAME reconcile pipeline for
// `productFacts`, wired since before this task) also stops at the route/enqueue layer rather than
// exercising `buildServer`'s internal worker — see its own header comment. Server.ts's contribution there
// (passing one already-constructed reference into an existing, already-tested object) is instead verified
// by code inspection (see the Task 13 report) plus the boot-composition smoke test below.

const SHOP = "acme-store.myshopify.com";
const TENANT = tenantIdForShop(SHOP);
const APP_SECRET = "app-client-secret-never-logged";
const CLIENT_ID = "client-123";
const REDIRECT_URI = "https://widget.palup.ai/shopify/callback";
const PARENT_TOKEN = "shpat_ADMIN_PARENT_TOKEN_NEVER_LOGGED";
const DELEGATE_TOKEN = "shpca_DELEGATE_TOKEN_NEVER_LOGGED";
const AUTH_CODE = "authorization-code-never-logged";
const GRANTED_SCOPES = "unauthenticated_read_product_listings";

const ENV_KEYS = [
  "SHOPIFY_APP_CLIENT_ID",
  "SHOPIFY_INSTALL_REDIRECT_URI",
  "SHOPIFY_INSTALL_REGION",
  "PALUP_SECRETS",
  "ADMIN_TOKEN_CUSTODY_ENABLED",
  "CATALOG_BACKFILL_ENABLED",
  "CATALOG_LOCAL_SERVING",
];
const saved: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) saved[k] = process.env[k];
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
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

function signBody(raw: string, secret = APP_SECRET): string {
  return createHmac("sha256", secret).update(raw, "utf8").digest("base64");
}

let webhookSeq = 0;
function nextWebhookId(): string {
  webhookSeq += 1;
  return `wh-server-wiring-${webhookSeq}`;
}

function installFetchImpl(): typeof globalThis.fetch {
  return (async (url: unknown) => {
    const u = String(url);
    if (u.endsWith("/admin/oauth/access_token")) {
      return { ok: true, status: 200, json: async () => ({ access_token: PARENT_TOKEN, scope: GRANTED_SCOPES }) };
    }
    if (u.includes("/graphql.json")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: { delegateAccessTokenCreate: { delegateAccessToken: { accessToken: DELEGATE_TOKEN, accessScopes: [GRANTED_SCOPES] }, userErrors: [] } },
        }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  }) as unknown as typeof globalThis.fetch;
}

function baseSecrets(extra: Record<string, Record<string, string>> = {}): string {
  return JSON.stringify({
    [SHOPIFY_APP_SECRET_SCOPE]: { [SHOPIFY_APP_CLIENT_SECRET_NAME]: APP_SECRET },
    ...extra,
  });
}

async function runInstall(app: Awaited<ReturnType<typeof buildServer>>): Promise<{ statusCode: number }> {
  const beginRes = await app.inject({
    method: "GET",
    url: `/shopify/install?${qs({ shop: SHOP, timestamp: String(Math.floor(Date.now() / 1000)) })}`,
  });
  const state = new URL(beginRes.headers.location as string).searchParams.get("state")!;
  const cookie = cookieFrom(beginRes as unknown as { headers: Record<string, unknown> });
  const cbRes = await app.inject({
    method: "GET",
    url: `/shopify/callback?${qs({
      code: AUTH_CODE,
      host: "aG9zdA",
      shop: SHOP,
      state,
      timestamp: String(Math.floor(Date.now() / 1000)),
    })}`,
    headers: { cookie },
  });
  return { statusCode: cbRes.statusCode };
}

async function postWebhook(app: Awaited<ReturnType<typeof buildServer>>, path: string, topic: string, raw: string) {
  const res = await app.inject({
    method: "POST",
    url: path,
    headers: {
      "content-type": "application/json",
      "x-shopify-topic": topic,
      "x-shopify-api-version": "2026-07",
      "x-shopify-webhook-id": nextWebhookId(),
      "x-shopify-shop-domain": SHOP,
      "x-shopify-hmac-sha256": signBody(raw),
    },
    payload: raw,
  });
  return { statusCode: res.statusCode };
}

const shopRedactBody = (): string => JSON.stringify({ shop_id: 954889, shop_domain: SHOP });

describe("server.ts composition — durable catalog-sync (Task 13)", () => {
  it("ADMIN_TOKEN_CUSTODY_ENABLED unset (default): an injected opts.adminTokens is never touched, install still succeeds", async () => {
    process.env.SHOPIFY_APP_CLIENT_ID = CLIENT_ID;
    process.env.SHOPIFY_INSTALL_REDIRECT_URI = REDIRECT_URI;
    process.env.SHOPIFY_INSTALL_REGION = "us";
    process.env.PALUP_SECRETS = baseSecrets();

    const put = vi.fn(async () => {});
    const del = vi.fn(async () => {});
    const fakeAdminTokens: AdminTokenStore = {
      put,
      delete: del,
      async read() {
        return { status: "missing" };
      },
      async refresh() {},
    };

    const app = await buildServer({
      store: new InMemoryRuntimeStore(),
      merchantRegistry: createInMemoryMerchantRegistry(),
      installFetch: installFetchImpl(),
      // A fake sink for the DELEGATE credential — this test is about the admin-token seam, not merchant-
      // cred custody, so avoid needing a real merchant-cred key provisioned just to reach a 200.
      merchantCredentials: { async put() {} },
      adminTokens: fakeAdminTokens,
    });
    try {
      const { statusCode } = await runInstall(app);
      expect(statusCode).toBe(200);
      expect(put).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("ADMIN_TOKEN_CUSTODY_ENABLED=true wires the injected opts.adminTokens into BOTH the install (put) and shop/redact (delete) flows", async () => {
    process.env.SHOPIFY_APP_CLIENT_ID = CLIENT_ID;
    process.env.SHOPIFY_INSTALL_REDIRECT_URI = REDIRECT_URI;
    process.env.SHOPIFY_INSTALL_REGION = "us";
    process.env.PALUP_SECRETS = baseSecrets();
    process.env.ADMIN_TOKEN_CUSTODY_ENABLED = "true";

    const put = vi.fn(async () => {});
    const del = vi.fn(async () => {});
    const fakeAdminTokens: AdminTokenStore = {
      put,
      delete: del,
      async read() {
        return { status: "found", token: PARENT_TOKEN };
      },
      async refresh() {},
    };
    const registry: MerchantRegistryPort = createInMemoryMerchantRegistry();

    const app = await buildServer({
      store: new InMemoryRuntimeStore(),
      merchantRegistry: registry,
      installFetch: installFetchImpl(),
      merchantCredentials: { async put() {} },
      adminTokens: fakeAdminTokens,
    });
    try {
      const { statusCode } = await runInstall(app);
      expect(statusCode).toBe(200);
      expect(put).toHaveBeenCalledTimes(1);
      expect(put).toHaveBeenCalledWith(TENANT, PARENT_TOKEN, expect.objectContaining({ actor: "system:shopify-install" }));

      const { statusCode: redactStatus } = await postWebhook(app, WEBHOOK_ROUTES.shopRedact, "shop/redact", shopRedactBody());
      expect(redactStatus).toBe(200);
      expect(del).toHaveBeenCalledTimes(1);
      expect(del).toHaveBeenCalledWith(TENANT, expect.objectContaining({ actor: expect.any(String) }));
    } finally {
      await app.close();
    }
  });

  it("ADMIN_TOKEN_CUSTODY_ENABLED=true with NO opts.adminTokens override: the composition root builds its own AdminTokenStore under the DISTINCT admin-cred crypto scope (ADR-0022 F2)", async () => {
    process.env.SHOPIFY_APP_CLIENT_ID = CLIENT_ID;
    process.env.SHOPIFY_INSTALL_REDIRECT_URI = REDIRECT_URI;
    process.env.SHOPIFY_INSTALL_REGION = "us";
    process.env.ADMIN_TOKEN_CUSTODY_ENABLED = "true";
    // Provision ONLY the two scope-specific secret names — never the bare, unscoped default — so a
    // successful round-trip through EACH scope is proof that scope is genuinely load-bearing (not a
    // coincidental fallback to a shared/default key).
    const adminKeyName = keyScopeSecretName("MEMORY_ENCRYPTION_KEY", ADMIN_CRED_KEY_SCOPE);
    const merchantKeyName = keyScopeSecretName("MEMORY_ENCRYPTION_KEY", MERCHANT_CRED_KEY_SCOPE);
    expect(adminKeyName).not.toBe(merchantKeyName); // pins the scope names are genuinely distinct
    process.env.PALUP_SECRETS = baseSecrets({
      [TENANT]: {
        [adminKeyName]: "admin-cred-key-material-32-bytes-long!!",
        [merchantKeyName]: "merchant-cred-key-material-32-bytes-long",
      },
    });

    const store = new InMemoryRuntimeStore();
    const app = await buildServer({
      store,
      merchantRegistry: createInMemoryMerchantRegistry(),
      installFetch: installFetchImpl(),
      // deliberately NOT passing opts.adminTokens — proves the REAL construction path
    });
    try {
      const { statusCode } = await runInstall(app);
      expect(statusCode).toBe(200);

      // Independently reconstruct the same kind of store the composition root built, over the SAME
      // underlying RuntimeStatePort + a fresh generic CryptoPort — proving the row is readable through
      // the admin-cred scope alone (no coupling to server.ts's private closures).
      const readBack = createAdminTokenStore(store, createAesGcmCrypto(createEnvSecrets()));
      const row = await readBack.read(TENANT);
      expect(row.status).toBe("found");
      expect(row.status === "found" ? row.token : undefined).toBe(PARENT_TOKEN);
    } finally {
      await app.close();
    }
  });

  it("shop/redact tombstones/hard-deletes catalog_product UNCONDITIONALLY (not gated on CATALOG_BACKFILL_ENABLED)", async () => {
    process.env.PALUP_SECRETS = baseSecrets();
    process.env.CATALOG_BACKFILL_ENABLED = "false";

    const registry = createInMemoryMerchantRegistry();
    await registry.create({ tenantId: TENANT, shopDomain: SHOP, embedKey: "pk_test", region: "us" });
    const catalogProduct: CatalogProductPort = createInMemoryCatalogProductStore();
    await catalogProduct.upsertMany(TENANT, [
      { productId: "gid://shopify/Product/1", handle: "p1", title: "P1", status: "active", variants: [], contentHash: "h1", syncedAt: new Date().toISOString() },
    ]);

    const app = await buildServer({
      store: new InMemoryRuntimeStore(),
      merchantRegistry: registry,
      catalogProduct,
    });
    try {
      const { statusCode } = await postWebhook(app, WEBHOOK_ROUTES.shopRedact, "shop/redact", shopRedactBody());
      expect(statusCode).toBe(200);
      // Hard-deleted (deleteTenant), not merely tombstoned — even with the WRITE-plane flag off, since
      // teardown is a compliance action wired unconditionally.
      expect(await catalogProduct.listByTenant(TENANT, { includeDeleted: true })).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("boots successfully with CATALOG_BACKFILL_ENABLED off, regardless of admin-token custody", async () => {
    process.env.CATALOG_BACKFILL_ENABLED = "false";
    const app = await buildServer({ store: new InMemoryRuntimeStore() });
    try {
      const res = await app.inject({ method: "GET", url: "/health" });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  // Final-review fix (whole-branch review, 2026-08-23) — Task 13 wired `reconcileDeps.catalogProduct`
  // (the durable delta WRITE plane) into composition but never wired the paired clobber-fix field
  // `catalogProductAdminSource`. Left alone, turning CATALOG_BACKFILL_ENABLED on by itself (exactly what
  // the OLD version of this test proved "boots fine either way") would silently reintroduce the Task 6/7
  // clobber the moment a real Bulk-Ops backfill populated a rich row. The fix makes the two fields
  // STRUCTURALLY paired: `buildServer` now refuses to boot when the rich write-plane is wired without its
  // admin-shape read source.
  it("FAILS FAST at composition when CATALOG_BACKFILL_ENABLED=true but the admin-shape source cannot be built (ADMIN_TOKEN_CUSTODY_ENABLED off) — the trap can no longer boot silently", async () => {
    process.env.CATALOG_BACKFILL_ENABLED = "true";
    delete process.env.ADMIN_TOKEN_CUSTODY_ENABLED;
    await expect(buildServer({ store: new InMemoryRuntimeStore() })).rejects.toThrow(/catalogProductAdminSource/i);
  });

  it("boots and wires the paired admin-shape source when BOTH CATALOG_BACKFILL_ENABLED and ADMIN_TOKEN_CUSTODY_ENABLED are on (the safe, paired posture)", async () => {
    process.env.CATALOG_BACKFILL_ENABLED = "true";
    process.env.ADMIN_TOKEN_CUSTODY_ENABLED = "true";
    const fakeAdminTokens: AdminTokenStore = {
      put: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
      async read() {
        return { status: "missing" };
      },
      async refresh() {},
    };

    const app = await buildServer({ store: new InMemoryRuntimeStore(), adminTokens: fakeAdminTokens });
    try {
      const res = await app.inject({ method: "GET", url: "/health" });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
