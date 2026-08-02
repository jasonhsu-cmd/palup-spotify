import { describe, it, expect } from "vitest";
import { InMemoryRuntimeStore, createEnvSecrets } from "@palup/platform-ports";
import { createCustomerGrantStore, CAA_GRANT_KEY_SCOPE, CAA_GRANT_KEY_NAME, type StoredGrant } from "../src/customer-grant-store.js";
import { createRefreshingGrantStore, logoutGrant } from "../src/refreshing-grant-store.js";

// ADR-0018 task 7 — the refreshing grant-store decorator.

const ISSUER = "https://shopify.com/authentication/111";
const CFG = { issuer: ISSUER, authorization_endpoint: `${ISSUER}/oauth/authorize`, token_endpoint: `${ISSUER}/oauth/token`, jwks_uri: `${ISSUER}/.well-known/jwks.json` };
const SHOP = "acme-store.myshopify.com";
const NOW = 1_700_000_000;

type FetchFn = typeof globalThis.fetch;
function makeFetch(opts: { refresh?: unknown; refreshStatus?: number; onCall?: () => void } = {}): FetchFn {
  return (async (url: unknown) => {
    opts.onCall?.();
    const u = String(url);
    if (u.endsWith("/.well-known/openid-configuration")) return { ok: true, status: 200, json: async () => CFG };
    if (u.endsWith("/oauth/token")) {
      const status = opts.refreshStatus ?? 200;
      return { ok: status < 400, status, json: async () => opts.refresh ?? { access_token: "NEW-AT", refresh_token: "NEW-RT", expires_in: 3600 } };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  }) as unknown as FetchFn;
}

function harness(fetchFn: FetchFn, over: { now?: () => number; skew?: number; maxAge?: number } = {}) {
  const store = new InMemoryRuntimeStore();
  const secrets = createEnvSecrets(JSON.stringify({ [CAA_GRANT_KEY_SCOPE]: { [CAA_GRANT_KEY_NAME]: "gk" }, acme: { caa_client_id: "cid", caa_client_secret: "csec" } }));
  const inner = createCustomerGrantStore(store, secrets);
  const refreshing = createRefreshingGrantStore(inner, {
    shopDomainForTenant: (t) => (t === "acme" ? SHOP : undefined),
    clientIdFor: (t) => secrets.get(t, "caa_client_id"),
    clientSecretFor: (t) => secrets.get(t, "caa_client_secret"),
    fetchFn,
    now: over.now ?? (() => NOW),
    refreshSkewSeconds: over.skew,
    maxGrantAgeSeconds: over.maxAge,
  });
  return { store, inner, refreshing };
}
const put = (h: ReturnType<typeof harness>, g: Partial<StoredGrant>) => h.inner.put("acme", "shopify:acme:1", { accessToken: "AT", grantedAt: NOW, ...g });
const get = (h: ReturnType<typeof harness>) => h.refreshing.get("acme", "shopify:acme:1");

describe("createRefreshingGrantStore", () => {
  it("a still-fresh grant is returned as-is, WITHOUT a refresh call", async () => {
    let calls = 0;
    const h = harness(makeFetch({ onCall: () => calls++ }));
    await put(h, { accessToken: "AT", refreshToken: "RT", expiresAt: NOW + 3600 });
    expect((await get(h))?.accessToken).toBe("AT");
    expect(calls).toBe(0);
  });

  it("a near-expiry grant is REFRESHED; grantedAt is preserved; the new grant is persisted", async () => {
    const h = harness(makeFetch({ refresh: { access_token: "NEW-AT", refresh_token: "NEW-RT", expires_in: 3600 } }));
    await put(h, { accessToken: "OLD-AT", refreshToken: "OLD-RT", expiresAt: NOW + 30, grantedAt: NOW - 100 }); // within default 120s skew
    const g = await get(h);
    expect(g).toMatchObject({ accessToken: "NEW-AT", refreshToken: "NEW-RT", expiresAt: NOW + 3600, grantedAt: NOW - 100 });
    expect((await h.inner.get("acme", "shopify:acme:1"))?.accessToken).toBe("NEW-AT"); // persisted
  });

  it("capped session lifetime: a grant older than maxGrantAge ⇒ null (reauth), even if refreshable", async () => {
    const h = harness(makeFetch(), { maxAge: 3600 });
    await put(h, { accessToken: "AT", refreshToken: "RT", expiresAt: NOW + 30, grantedAt: NOW - 7200 }); // 2h old > 1h cap
    expect(await get(h)).toBeNull();
  });

  it("a refresh that FAILS ⇒ the stale grant is returned (adapter's expiry check then reauths — fail closed)", async () => {
    const h = harness(makeFetch({ refreshStatus: 400 }));
    await put(h, { accessToken: "OLD-AT", refreshToken: "RT", expiresAt: NOW + 30 });
    expect((await get(h))?.accessToken).toBe("OLD-AT");
  });

  it("a near-expiry grant with NO refresh token ⇒ returned stale, no refresh attempted", async () => {
    let calls = 0;
    const h = harness(makeFetch({ onCall: () => calls++ }));
    await put(h, { accessToken: "OLD-AT", expiresAt: NOW + 30 }); // no refreshToken
    expect((await get(h))?.accessToken).toBe("OLD-AT");
    expect(calls).toBe(0);
  });

  it("put / delete / ready pass through", async () => {
    const h = harness(makeFetch());
    expect(await h.refreshing.ready()).toBe(true);
    await put(h, { accessToken: "AT", expiresAt: NOW + 3600 });
    await h.refreshing.delete("acme", "shopify:acme:1");
    expect(await h.inner.get("acme", "shopify:acme:1")).toBeNull();
  });
});

describe("logoutGrant", () => {
  it("deletes the local grant AND audits the revocation (delete happens before the audit) — NN#5", async () => {
    const h = harness(makeFetch());
    await put(h, { accessToken: "AT", refreshToken: "RT", expiresAt: NOW + 3600 });
    let grantAtAuditTime: unknown = "unset";
    await logoutGrant(h.inner, "acme", "shopify:acme:1", async () => {
      grantAtAuditTime = await h.inner.get("acme", "shopify:acme:1"); // delete-first ⇒ already gone when audited
    });
    expect(grantAtAuditTime).toBeNull(); // audit ran, and the grant was already deleted
    expect(await h.inner.get("acme", "shopify:acme:1")).toBeNull();
  });

  it("a THROWING audit does NOT strand the credential (already deleted) and does not throw", async () => {
    const h = harness(makeFetch());
    await put(h, { accessToken: "AT", expiresAt: NOW + 3600 });
    await expect(logoutGrant(h.inner, "acme", "shopify:acme:1", async () => { throw new Error("audit down"); })).resolves.toBeUndefined();
    expect(await h.inner.get("acme", "shopify:acme:1")).toBeNull(); // deleted regardless
  });
});
