import { describe, it, expect, vi } from "vitest";
import { createHmac } from "node:crypto";
import Fastify from "fastify";
import { InMemoryRuntimeStore, createInMemoryMerchantRegistry } from "@palup/platform-ports";
import type { RuntimeStatePort } from "@palup/platform-ports";
import { registerShopifyInstallRoutes, tenantIdForShop, type ShopifyInstallDeps, type MerchantCredentialSink } from "../src/routes/shopify-install.js";

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
function makeDeps(overrides: Partial<ShopifyInstallDeps> = {}): ShopifyInstallDeps {
  const fetchImpl = (async (url: unknown, init?: unknown) => {
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

  return {
    store: new InMemoryRuntimeStore(),
    registry: createInMemoryMerchantRegistry(),
    credentials: credentialSink(),
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

  it("without an `adminTokens` dep, install still succeeds unchanged (additive / back-compat)", async () => {
    const deps = makeDeps(); // no adminTokens
    const app = await buildApp(deps);
    const { state, cookie } = await begin(app);
    const res = await callback(app, { state, cookie });
    expect(res.statusCode).toBe(200);
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

describe("Task 13 (forward-carry from Task 5) — admin-token custody failure is NON-FATAL to install", () => {
  it("adminTokens.put throwing does NOT fail the install — the delegate token is stored, the install succeeds, and admin_token.custody_failed is audited", async () => {
    const store: RuntimeStatePort = new InMemoryRuntimeStore();
    const credentials: MerchantCredentialSink & { puts: Array<{ tenantId: string; token: string }> } = {
      puts: [],
      async put(tenantId, token) {
        credentials.puts.push({ tenantId, token });
      },
    };
    const put = vi.fn(async () => {
      throw new Error("admin-cred key not provisioned");
    });
    const deps = makeDeps({ store, credentials, adminTokens: { put } });
    const app = await buildApp(deps);
    const { state, cookie } = await begin(app);
    const res = await callback(app, { state, cookie });

    // The install as a whole SUCCEEDS despite the admin-token custody failure.
    expect(res.statusCode).toBe(200);
    expect(put).toHaveBeenCalledTimes(1);
    // The delegate token was already safely custodied before the admin-token attempt, and stays custodied.
    expect(credentials.puts).toHaveLength(1);
    expect(credentials.puts[0]!.token).toBe(DELEGATE_TOKEN);

    // A corrective audit entry records the residual — the install's success does not silently overclaim
    // that Admin-token custody also succeeded.
    const tenantId = credentials.puts[0]!.tenantId;
    const audits = await store.readAudit({ tenantId });
    const failure = audits.find((a) => a.action === "admin_token.custody_failed");
    expect(failure).toBeTruthy();
    expect(failure!.decision).toMatchObject({ complete: false });
    // Never leak the parent Admin token into the audit trail.
    expect(JSON.stringify(failure)).not.toContain(PARENT_TOKEN);
  });

  it("without adminTokens configured at all, install behaves exactly as before (no custody attempted, no audit entry)", async () => {
    const store: RuntimeStatePort = new InMemoryRuntimeStore();
    const deps = makeDeps({ store }); // no adminTokens
    const app = await buildApp(deps);
    const { state, cookie } = await begin(app);
    const res = await callback(app, { state, cookie });
    expect(res.statusCode).toBe(200);

    const audits = await store.readAudit({ tenantId: tenantIdForShop(SHOP) });
    expect(audits.some((a) => a.action === "admin_token.custody_failed")).toBe(false);
  });
});
