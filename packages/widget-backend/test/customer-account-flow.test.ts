import { describe, it, expect } from "vitest";
import { generateKeyPairSync, createSign } from "node:crypto";
import { InMemoryRuntimeStore, createEnvSecrets, createShopperTokenIdentity } from "@palup/platform-ports";
import { createCustomerGrantStore, CAA_GRANT_KEY_SCOPE, CAA_GRANT_KEY_NAME } from "../src/customer-grant-store.js";
import {
  startCustomerLogin,
  completeCustomerCallback,
  redeemHandoff,
  CAA_APP_SCOPE,
  CAA_PENDING_COLLECTION,
} from "../src/customer-account-flow.js";

// ADR-0018 tasks 4-5 security core. A fake fetch serves per-shop OIDC discovery + JWKS + token responses;
// id_tokens are minted with a REAL RS256 keypair so verifyIdToken runs real crypto end-to-end.

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KID = "k1";
const JWKS = { keys: [{ ...(publicKey.export({ format: "jwk" }) as object), kid: KID, alg: "RS256", use: "sig" }] };
const NOW = 1_700_000_000;
const b64url = (o: unknown) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");
function mintIdToken(claims: Record<string, unknown>): string {
  const head = b64url({ alg: "RS256", kid: KID, typ: "JWT" });
  const body = b64url(claims);
  const s = createSign("RSA-SHA256");
  s.update(`${head}.${body}`);
  s.end();
  return `${head}.${body}.${s.sign(privateKey).toString("base64url")}`;
}

const SHOPS = {
  acme: { tenant: "acme", domain: "acme-store.myshopify.com", issuer: "https://shopify.com/authentication/111", clientId: "acme-client" },
  brandx: { tenant: "brandx", domain: "brandx-store.myshopify.com", issuer: "https://shopify.com/authentication/222", clientId: "brandx-client" },
};
const cfgFor = (s: { issuer: string }) => ({ issuer: s.issuer, authorization_endpoint: `${s.issuer}/oauth/authorize`, token_endpoint: `${s.issuer}/oauth/token`, jwks_uri: `${s.issuer}/.well-known/jwks.json` });
const CFG_BY_HOST: Record<string, unknown> = { [SHOPS.acme.domain]: cfgFor(SHOPS.acme), [SHOPS.brandx.domain]: cfgFor(SHOPS.brandx) };

type FetchFn = typeof globalThis.fetch;
/** idToken is what the (single) token endpoint returns; discovery + JWKS are served for any shop. */
const makeFetch = (idToken: string, over: { tokenOk?: boolean } = {}): FetchFn =>
  (async (url: unknown) => {
    const u = String(url);
    if (u.endsWith("/.well-known/openid-configuration")) {
      const host = new URL(u).hostname;
      const cfg = CFG_BY_HOST[host];
      return cfg ? { ok: true, status: 200, json: async () => cfg } : { ok: false, status: 404, json: async () => ({}) };
    }
    if (u.endsWith("/.well-known/jwks.json")) return { ok: true, status: 200, json: async () => JWKS };
    if (u.endsWith("/oauth/token")) return { ok: over.tokenOk !== false, status: over.tokenOk === false ? 400 : 200, json: async () => ({ access_token: "at", refresh_token: "rt", id_token: idToken, expires_in: 900, scope: "openid" }) };
    return { ok: false, status: 404, json: async () => ({}) };
  }) as unknown as FetchFn;

function harness() {
  const store = new InMemoryRuntimeStore();
  const secrets = createEnvSecrets(
    JSON.stringify({
      [CAA_GRANT_KEY_SCOPE]: { [CAA_GRANT_KEY_NAME]: "grant-key" },
      acme: { caa_client_id: SHOPS.acme.clientId, caa_client_secret: "acme-secret" },
      brandx: { caa_client_id: SHOPS.brandx.clientId, caa_client_secret: "brandx-secret" },
    }),
  );
  const grants = createCustomerGrantStore(store, secrets);
  const SHOPPER_SECRET = "shopper-token-secret";
  const callbackDeps = (fetchFn: FetchFn, over: { audit?: (e: { tenant: string; shopperId: string; scope?: string }) => Promise<void>; killCheck?: (t: string) => Promise<boolean> } = {}) => ({
    store,
    fetchFn,
    grants,
    clientIdFor: (t: string) => secrets.get(t, "caa_client_id"),
    clientSecretFor: (t: string) => secrets.get(t, "caa_client_secret"),
    killCheck: over.killCheck ?? (async () => false),
    redirectUri: "https://widget.palup.ai/auth/customer/callback",
    shopperTokenSecret: SHOPPER_SECRET,
    shopperTokenTtlSeconds: 3600,
    now: () => NOW,
    audit: over.audit ?? (async () => {}),
  });
  const loginDeps = (fetchFn: FetchFn, over: { killCheck?: (t: string) => Promise<boolean> } = {}) => ({
    store,
    fetchFn,
    clientIdFor: (t: string) => secrets.get(t, "caa_client_id"),
    killCheck: over.killCheck ?? (async () => false),
    redirectUri: "https://widget.palup.ai/auth/customer/callback",
    scope: "openid email customer-account-api:full",
    now: () => NOW,
  });
  const readPending = async (state: string) => store.get<{ nonce: string; tenant: string }>({ tenantId: CAA_APP_SCOPE }, CAA_PENDING_COLLECTION, state);
  return { store, secrets, grants, SHOPPER_SECRET, callbackDeps, loginDeps, readPending };
}

// Run a login for a shop and return the generated `state` + the pending nonce.
async function login(h: ReturnType<typeof harness>, shop: { tenant: string; domain: string }) {
  const r = await startCustomerLogin(h.loginDeps(makeFetch("")), { tenant: shop.tenant, shopDomain: shop.domain });
  expect(r).not.toBeNull();
  const state = new URL(r!.authorizeUrl).searchParams.get("state")!;
  const pending = await h.readPending(state);
  return { state, nonce: pending!.nonce };
}

describe("startCustomerLogin", () => {
  it("builds an authorize URL for the shop's issuer + persists pending-auth keyed by state", async () => {
    const h = harness();
    const r = await startCustomerLogin(h.loginDeps(makeFetch("")), { tenant: "acme", shopDomain: SHOPS.acme.domain });
    const url = new URL(r!.authorizeUrl);
    expect(url.origin + url.pathname).toBe(`${SHOPS.acme.issuer}/oauth/authorize`);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("client_id")).toBe(SHOPS.acme.clientId);
    expect(await h.readPending(url.searchParams.get("state")!)).toMatchObject({ tenant: "acme", shopDomain: SHOPS.acme.domain });
  });
  it("no CAA client for the tenant ⇒ null", async () => {
    const h = harness();
    expect(await startCustomerLogin(h.loginDeps(makeFetch("")), { tenant: "no-such", shopDomain: "x.myshopify.com" })).toBeNull();
  });
});

describe("completeCustomerCallback", () => {
  it("happy path ⇒ handoff code that redeems the minted shopper token; grant stored encrypted", async () => {
    const h = harness();
    const { state, nonce } = await login(h, SHOPS.acme);
    const idToken = mintIdToken({ sub: "48291", iss: SHOPS.acme.issuer, aud: SHOPS.acme.clientId, exp: NOW + 300, iat: NOW - 5, nonce });
    const res = await completeCustomerCallback(h.callbackDeps(makeFetch(idToken)), { code: "code-abc", state });
    expect(res.ok).toBe(true);
    const token = await redeemHandoff(h.store, (res as { handoffCode: string }).handoffCode);
    expect(await createShopperTokenIdentity(h.SHOPPER_SECRET, () => NOW).authenticate(token!)).toEqual({ kind: "shopper", shopperId: "shopify:acme:48291", source: "shopify", verified: true });
    // grant persisted + decryptable
    expect(await h.grants.get("acme", "shopify:acme:48291")).toMatchObject({ accessToken: "at", refreshToken: "rt" });
  });

  it("CROSS-TENANT: a shop-A-issued id_token presented on a tenant-B (shop B) flow ⇒ error (issuer pinned to the flow's shop)", async () => {
    const h = harness();
    const { state, nonce } = await login(h, SHOPS.brandx); // pending record is for brandx / shop B
    // Attacker/mismatched token: validly signed, correct nonce + brandx aud, but iss = shop A.
    const idToken = mintIdToken({ sub: "999", iss: SHOPS.acme.issuer, aud: SHOPS.brandx.clientId, exp: NOW + 300, iat: NOW - 5, nonce });
    const res = await completeCustomerCallback(h.callbackDeps(makeFetch(idToken)), { code: "c", state });
    expect(res).toEqual({ ok: false, reason: "error" });
    expect(await h.grants.get("brandx", "shopify:brandx:999")).toBeNull(); // nothing minted under tenant B
  });

  it("declined consent (error=access_denied) ⇒ benign cancelled, no token", async () => {
    const h = harness();
    expect(await completeCustomerCallback(h.callbackDeps(makeFetch("")), { error: "access_denied", state: "x" })).toEqual({ ok: false, reason: "cancelled" });
  });
  it("any other OAuth error ⇒ generic error", async () => {
    const h = harness();
    expect(await completeCustomerCallback(h.callbackDeps(makeFetch("")), { error: "server_error" })).toEqual({ ok: false, reason: "error" });
  });
  it("missing code or state ⇒ error", async () => {
    const h = harness();
    expect((await completeCustomerCallback(h.callbackDeps(makeFetch("")), { state: "s" })).ok).toBe(false);
    expect((await completeCustomerCallback(h.callbackDeps(makeFetch("")), { code: "c" })).ok).toBe(false);
  });
  it("unknown state ⇒ error", async () => {
    const h = harness();
    expect((await completeCustomerCallback(h.callbackDeps(makeFetch("")), { code: "c", state: "never-issued" })).ok).toBe(false);
  });
  it("replayed state ⇒ second use fails (single-use, consumed before network)", async () => {
    const h = harness();
    const { state, nonce } = await login(h, SHOPS.acme);
    const idToken = mintIdToken({ sub: "48291", iss: SHOPS.acme.issuer, aud: SHOPS.acme.clientId, exp: NOW + 300, iat: NOW - 5, nonce });
    expect((await completeCustomerCallback(h.callbackDeps(makeFetch(idToken)), { code: "c", state })).ok).toBe(true);
    expect((await completeCustomerCallback(h.callbackDeps(makeFetch(idToken)), { code: "c", state })).ok).toBe(false);
  });
  it("a wrong-nonce id_token ⇒ error (replay/cross-flow)", async () => {
    const h = harness();
    const { state } = await login(h, SHOPS.acme);
    const idToken = mintIdToken({ sub: "48291", iss: SHOPS.acme.issuer, aud: SHOPS.acme.clientId, exp: NOW + 300, iat: NOW - 5, nonce: "not-the-pending-nonce" });
    expect((await completeCustomerCallback(h.callbackDeps(makeFetch(idToken)), { code: "c", state })).ok).toBe(false);
  });

  it("audits the grant (with the shopper id + scope) on success — NN#5", async () => {
    const h = harness();
    const { state, nonce } = await login(h, SHOPS.acme);
    const idToken = mintIdToken({ sub: "48291", iss: SHOPS.acme.issuer, aud: SHOPS.acme.clientId, exp: NOW + 300, iat: NOW - 5, nonce });
    const seen: Array<{ tenant: string; shopperId: string; scope?: string }> = [];
    const res = await completeCustomerCallback(h.callbackDeps(makeFetch(idToken), { audit: async (e) => void seen.push(e) }), { code: "c", state });
    expect(res.ok).toBe(true);
    expect(seen).toEqual([{ tenant: "acme", shopperId: "shopify:acme:48291", scope: "openid" }]);
  });

  it("a THROWING audit ⇒ error AND no grant custodied (an unauditable credential never persists) — NN#5", async () => {
    const h = harness();
    const { state, nonce } = await login(h, SHOPS.acme);
    const idToken = mintIdToken({ sub: "48291", iss: SHOPS.acme.issuer, aud: SHOPS.acme.clientId, exp: NOW + 300, iat: NOW - 5, nonce });
    const res = await completeCustomerCallback(h.callbackDeps(makeFetch(idToken), { audit: async () => { throw new Error("audit sink down"); } }), { code: "c", state });
    expect(res).toEqual({ ok: false, reason: "error" });
    expect(await h.grants.get("acme", "shopify:acme:48291")).toBeNull(); // grant NOT stored
  });

  it("a killed tenant ⇒ error, no grant (NN#4 — no credential accrual during a halt)", async () => {
    const h = harness();
    const { state, nonce } = await login(h, SHOPS.acme);
    const idToken = mintIdToken({ sub: "48291", iss: SHOPS.acme.issuer, aud: SHOPS.acme.clientId, exp: NOW + 300, iat: NOW - 5, nonce });
    const res = await completeCustomerCallback(h.callbackDeps(makeFetch(idToken), { killCheck: async () => true }), { code: "c", state });
    expect(res).toEqual({ ok: false, reason: "error" });
    expect(await h.grants.get("acme", "shopify:acme:48291")).toBeNull();
  });

  it("startCustomerLogin for a killed tenant ⇒ null (no flow begins)", async () => {
    const h = harness();
    expect(await startCustomerLogin(h.loginDeps(makeFetch(""), { killCheck: async () => true }), { tenant: "acme", shopDomain: SHOPS.acme.domain })).toBeNull();
  });
});

describe("redeemHandoff", () => {
  it("is single-use", async () => {
    const h = harness();
    const { state, nonce } = await login(h, SHOPS.acme);
    const idToken = mintIdToken({ sub: "1", iss: SHOPS.acme.issuer, aud: SHOPS.acme.clientId, exp: NOW + 300, iat: NOW - 5, nonce });
    const res = await completeCustomerCallback(h.callbackDeps(makeFetch(idToken)), { code: "c", state });
    const code = (res as { handoffCode: string }).handoffCode;
    expect(await redeemHandoff(h.store, code)).toBeTruthy();
    expect(await redeemHandoff(h.store, code)).toBeNull();
  });
});
