import { describe, it, expect, vi } from "vitest";
import { createHmac } from "node:crypto";
import Fastify from "fastify";
import { InMemoryRuntimeStore, createInMemoryMerchantRegistry } from "@palup/platform-ports";
import type { RuntimeStatePort } from "@palup/platform-ports";
import {
  registerShopifyInstallRoutes,
  startInstall,
  completeInstall,
  tenantIdForShop,
  INSTALL_STATE_COOKIE,
  type ShopifyInstallDeps,
  type MerchantCredentialSink,
} from "../src/routes/shopify-install.js";

// Task 5 (ADR-0022 F6/F7) — capturing and custodying the parent Admin offline token at install, under the
// Task-4 AdminTokenStore, WITHOUT weakening the existing confused-deputy defence: custody must only happen
// once the callback's own shop has been proven to match the shop the (signed, single-use) `state` nonce was
// minted for. That binding already exists in `completeInstallInner` (shopify-install.ts:385-386, sourced
// from the server-side pending record keyed by `state`) — this file exercises it with the NEW `adminTokens`
// seam layered on top, rather than inventing a second check.

const APP_SECRET = "app-client-secret-never-logged";
const CLIENT_ID = "client-123";
const REDIRECT_URI = "https://widget.palup.ai/shopify/callback";
const SHOP = "acme-store.myshopify.com";
const OTHER_SHOP = "beta-store.myshopify.com";
const PARENT_TOKEN = "shpat_ADMIN_PARENT_TOKEN_NEVER_LOGGED";
const DELEGATE_TOKEN = "shpca_DELEGATE_TOKEN_NEVER_LOGGED";
const AUTH_CODE = "authorization-code-never-logged";
const GRANTED_SCOPES = "unauthenticated_read_product_listings";
const REFRESH_TOKEN = "shrt_REFRESH_TOKEN_NEVER_LOGGED";

function sign(query: Record<string, string>, secret = APP_SECRET): string {
  const sp = new URLSearchParams();
  for (const k of Object.keys(query).filter((x) => x !== "hmac" && x !== "signature").sort((a, b) => a.localeCompare(b))) {
    sp.append(k, query[k]);
  }
  return createHmac("sha256", secret).update(sp.toString().replace(/\+/g, "%20")).digest("hex");
}

function qs(query: Record<string, string>, opts: { hmac?: string | null } = {}): string {
  const hmac = opts.hmac === null ? undefined : (opts.hmac ?? sign(query));
  const sp = new URLSearchParams(query);
  if (hmac !== undefined) sp.set("hmac", hmac);
  return sp.toString();
}

function credentialSink(): MerchantCredentialSink {
  return { async put() {} };
}

/** A minimal, directly-constructed dep set (no server composition root, no env vars) so this file owns the
 *  `adminTokens` seam explicitly, per the brief. */
function makeDeps(overrides: Partial<ShopifyInstallDeps> = {}, capture?: { accessTokenBody?: string }): ShopifyInstallDeps {
  const fetchImpl = (async (url: unknown, init?: unknown) => {
    const u = String(url);
    if (u.endsWith("/admin/oauth/access_token")) {
      if (capture) capture.accessTokenBody = String((init as { body?: unknown } | undefined)?.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          access_token: PARENT_TOKEN,
          scope: GRANTED_SCOPES,
          expires_in: 3600,
          refresh_token: REFRESH_TOKEN,
          refresh_token_expires_in: 7776000,
        }),
      };
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

  return {
    store: new InMemoryRuntimeStore(),
    registry: createInMemoryMerchantRegistry(),
    credentials: credentialSink(),
    // unified-cutover-cleanup (2026-08-24): `adminTokens` is now REQUIRED on `ShopifyInstallDeps` (it is the
    // sole credential this install produces), so every caller of `makeDeps` needs a value here even when it
    // does not care about custody — a no-op default that never inspects what it was given.
    adminTokens: { put: async () => {} },
    clientSecret: async () => APP_SECRET,
    fetchFn: fetchImpl,
    clientId: CLIENT_ID,
    redirectUri: REDIRECT_URI,
    requestedScopes: GRANTED_SCOPES,
    delegateScopes: [GRANTED_SCOPES],
    region: "us",
    killCheck: async () => false,
    now: () => Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

async function buildApp(deps: ShopifyInstallDeps) {
  const app = Fastify();
  registerShopifyInstallRoutes(app, deps);
  await app.ready();
  return app;
}

function cookieFrom(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers["set-cookie"];
  const first = Array.isArray(raw) ? raw[0] : (raw as string | undefined);
  return String(first).split(";")[0];
}

async function begin(app: Awaited<ReturnType<typeof buildApp>>, shop = SHOP) {
  const res = await app.inject({ method: "GET", url: `/shopify/install?${qs({ shop, timestamp: String(Math.floor(Date.now() / 1000)) })}` });
  const state = new URL(res.headers.location as string).searchParams.get("state")!;
  return { state, cookie: cookieFrom(res as unknown as { headers: Record<string, unknown> }) };
}

async function callback(app: Awaited<ReturnType<typeof buildApp>>, args: { state: string; cookie: string; shop?: string }) {
  const query: Record<string, string> = {
    code: AUTH_CODE,
    host: "aG9zdA",
    shop: args.shop ?? SHOP,
    state: args.state,
    timestamp: String(Math.floor(Date.now() / 1000)),
  };
  return app.inject({ method: "GET", url: `/shopify/callback?${qs(query)}`, headers: { cookie: args.cookie } });
}

describe("Task 5 — install captures + custodies the parent Admin token (F6/F7)", () => {
  it("custodies grant.accessToken under the admin-token sink on install (F7 shop-binding checked)", async () => {
    const put = vi.fn(async () => {});
    const deps = makeDeps({ adminTokens: { put } });
    const app = await buildApp(deps);
    const { state, cookie } = await begin(app);
    const res = await callback(app, { state, cookie });
    expect(res.statusCode).toBe(200);

    expect(put).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledWith(expect.any(String), PARENT_TOKEN, expect.objectContaining({ actor: "system:shopify-install" }));
    // The DELEGATE token must never reach the admin-token sink — only the parent.
    expect(put.mock.calls[0]?.[1]).not.toBe(DELEGATE_TOKEN);
  });

  it("Task 6 (ADR-0023): requests the EXPIRING offline token (expiring=1) and custodies refresh_token + both expiries", async () => {
    const put = vi.fn(async () => {});
    const capture: { accessTokenBody?: string } = {};
    const deps = makeDeps({ adminTokens: { put } }, capture);
    const app = await buildApp(deps);
    const { state, cookie } = await begin(app);
    const res = await callback(app, { state, cookie });
    expect(res.statusCode).toBe(200);

    // The token exchange itself requested the expiring offline token.
    const body = new URLSearchParams(capture.accessTokenBody);
    expect(body.get("expiring")).toBe("1");

    expect(put).toHaveBeenCalledTimes(1);
    const [, token, opts] = put.mock.calls[0]! as [string, string, { actor: string; expiresAt?: string; refreshToken?: string; refreshTokenExpiresAt?: string }];
    expect(token).toBe(PARENT_TOKEN);
    expect(opts.refreshToken).toBe(REFRESH_TOKEN);
    expect(typeof opts.expiresAt).toBe("string");
    expect(typeof opts.refreshTokenExpiresAt).toBe("string");
  });

  it("Task 6: never logs the refresh_token, even on a successful custody", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const put = vi.fn(async () => {});
      const deps = makeDeps({ adminTokens: { put } });
      const app = await buildApp(deps);
      const { state, cookie } = await begin(app);
      await callback(app, { state, cookie });
      const seen = [...warn.mock.calls, ...log.mock.calls].flat().map(String).join("\n");
      expect(seen).not.toContain(REFRESH_TOKEN);
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
  });

  it("does NOT custody when the grant's shop != the state shop (confused-deputy, F7)", async () => {
    const put = vi.fn(async () => {});
    const deps = makeDeps({ adminTokens: { put } });
    const app = await buildApp(deps);
    // `state` is minted for SHOP; the callback claims OTHER_SHOP.
    const { state, cookie } = await begin(app, SHOP);
    const res = await callback(app, { state, cookie, shop: OTHER_SHOP });
    expect(res.statusCode).toBe(400); // refused (shop_mismatch) — the existing binding check
    expect(put).not.toHaveBeenCalled();
  });

  it("never logs grant.accessToken, even on a successful custody", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const put = vi.fn(async () => {});
      const deps = makeDeps({ adminTokens: { put } });
      const app = await buildApp(deps);
      const { state, cookie } = await begin(app);
      await callback(app, { state, cookie });
      const seen = [...warn.mock.calls, ...log.mock.calls].flat().map(String).join("\n");
      expect(seen).not.toContain(PARENT_TOKEN);
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
  });
});

// Task 7 review (Critical, ADR-0023 D1), now UNCONDITIONAL (unified-cutover-cleanup, 2026-08-24): the
// `CATALOG_UNIFIED`/`catalogUnified` flag these tests used to gate on is deleted — there is no more
// non-fatal/degraded-sync-plane branch to regression-pin, because the delegate token that branch's fallback
// depended on is never minted. An Admin-token custody failure is FATAL, always, with no flag to flip.
describe("admin-token custody failure is FATAL to install (ADR-0023 D1, unconditional since unified-cutover-cleanup)", () => {
  /** Drive startInstall/completeInstall directly (no Fastify/app.inject) so the assertions can be made
   *  against the exact `InstallComplete` value, not just the rendered HTTP status. */
  async function driveInstall(deps: ShopifyInstallDeps, shop = SHOP) {
    const startQuery = { shop, timestamp: String(Math.floor(Date.now() / 1000)) };
    const start = await startInstall(deps, { ...startQuery, hmac: sign(startQuery) });
    if (!start.ok) throw new Error(`startInstall unexpectedly refused: ${JSON.stringify(start)}`);
    const query = { code: AUTH_CODE, host: "aG9zdA", shop, state: start.state, timestamp: String(Math.floor(Date.now() / 1000)) };
    const signedQuery = { ...query, hmac: sign(query) };
    const cookieHeader = `${INSTALL_STATE_COOKIE}=${start.state}`;
    return completeInstall(deps, signedQuery, cookieHeader);
  }

  it("adminTokens.put rejecting: the install FAILS with admin_token_custody_failed and no merchant row is created", async () => {
    const registry = createInMemoryMerchantRegistry();
    const createSpy = vi.spyOn(registry, "create");
    const put = vi.fn(async () => {
      throw new Error("KMS unavailable");
    });
    const deps = makeDeps({ registry, adminTokens: { put } });

    const result = await driveInstall(deps);

    expect(result).toEqual({ ok: false, failed: "admin_token_custody_failed" });
    expect(put).toHaveBeenCalledTimes(1);
    // The merchant must NOT be left registered/active with zero Shopify credentials.
    expect(createSpy).not.toHaveBeenCalled();
    const rec = await registry.lookupByShopDomain(SHOP, { includeInactive: true });
    expect(rec).toBeNull();
  });

  it("the failure still logs + best-effort-audits admin_token.custody_failed before returning fatal", async () => {
    const store: RuntimeStatePort = new InMemoryRuntimeStore();
    const put = vi.fn(async () => {
      throw new Error("KMS unavailable");
    });
    const deps = makeDeps({ store, adminTokens: { put } });

    const result = await driveInstall(deps);
    expect(result).toEqual({ ok: false, failed: "admin_token_custody_failed" });

    const audits = await store.readAudit({ tenantId: tenantIdForShop(SHOP) });
    const failure = audits.find((a) => a.action === "admin_token.custody_failed");
    expect(failure).toBeTruthy();
    expect(failure!.decision).toMatchObject({ complete: false });
    expect(JSON.stringify(failure)).not.toContain(PARENT_TOKEN);
  });
});
