import { describe, it, expect, afterEach } from "vitest";
import { generateKeyPairSync, createSign } from "node:crypto";
import { InMemoryRuntimeStore, createEnvSecrets, mintShopperToken } from "@palup/platform-ports";
import { buildServer } from "../src/server.js";
import { createCustomerGrantStore, CAA_GRANT_KEY_SCOPE, CAA_GRANT_KEY_NAME } from "../src/customer-grant-store.js";
import { CAA_APP_SCOPE, CAA_PENDING_COLLECTION } from "../src/customer-account-flow.js";

// ADR-0018 tasks 4-5 route wiring. Security invariants are covered at the function level
// (customer-account-flow.test.ts); this proves the routes gate, authenticate, and round-trip correctly.

const ISSUER = "https://shopify.com/authentication/111";
const CLIENT_ID = "acme-client";
const SHOP = "acme-store.myshopify.com";
const CFG = { issuer: ISSUER, authorization_endpoint: `${ISSUER}/oauth/authorize`, token_endpoint: `${ISSUER}/oauth/token`, jwks_uri: `${ISSUER}/.well-known/jwks.json` };
const NOW = 1_700_000_000;

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KID = "k1";
const JWKS = { keys: [{ ...(publicKey.export({ format: "jwk" }) as object), kid: KID, alg: "RS256", use: "sig" }] };
const b64url = (o: unknown) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");
function mintIdToken(claims: Record<string, unknown>): string {
  const head = b64url({ alg: "RS256", kid: KID, typ: "JWT" });
  const body = b64url(claims);
  const s = createSign("RSA-SHA256");
  s.update(`${head}.${body}`);
  s.end();
  return `${head}.${body}.${s.sign(privateKey).toString("base64url")}`;
}

let currentIdToken = "";
const caaFetch = (async (url: unknown) => {
  const u = String(url);
  if (u.endsWith("/.well-known/openid-configuration")) return { ok: true, status: 200, json: async () => CFG };
  if (u.endsWith("/.well-known/jwks.json")) return { ok: true, status: 200, json: async () => JWKS };
  if (u.endsWith("/oauth/token")) return { ok: true, status: 200, json: async () => ({ access_token: "at", refresh_token: "rt", id_token: currentIdToken, expires_in: 900 }) };
  return { ok: false, status: 404, json: async () => ({}) };
}) as unknown as typeof globalThis.fetch;

const KEYS = ["WIDGET_TOKEN_SECRET", "WIDGET_AUTH_REQUIRED", "WIDGET_EMBED_KEYS", "SHOPPER_AUTH", "SHOPPER_TOKEN_SECRET", "SHOPIFY_STORES", "PALUP_SECRETS", "CAA_REDIRECT_URI"];
afterEach(() => KEYS.forEach((k) => delete process.env[k]));

function enable(over: Record<string, string | undefined> = {}) {
  process.env.WIDGET_TOKEN_SECRET = "wsecret";
  process.env.WIDGET_AUTH_REQUIRED = "true";
  process.env.WIDGET_EMBED_KEYS = JSON.stringify({ "acme-key": "acme" });
  process.env.SHOPPER_AUTH = "true";
  process.env.SHOPPER_TOKEN_SECRET = "shopper-secret";
  process.env.SHOPIFY_STORES = JSON.stringify({ acme: SHOP });
  process.env.PALUP_SECRETS = JSON.stringify({ [CAA_GRANT_KEY_SCOPE]: { [CAA_GRANT_KEY_NAME]: "gk" }, acme: { caa_client_id: CLIENT_ID, caa_client_secret: "acme-secret" } });
  process.env.CAA_REDIRECT_URI = "https://widget.palup.ai/auth/customer/callback";
  for (const [k, v] of Object.entries(over)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  return buildServer({ store: new InMemoryRuntimeStore(), caaFetch });
}

async function widgetToken(app: Awaited<ReturnType<typeof buildServer>>) {
  return JSON.parse((await app.inject({ method: "GET", url: "/widget/token?key=acme-key" })).body).token as string;
}

describe("CAA routes — gating", () => {
  it("with SHOPPER_AUTH off ⇒ every /auth/customer route is 404 (inert)", async () => {
    const app = await enable({ SHOPPER_AUTH: undefined });
    for (const url of ["/auth/customer/login", "/auth/customer/callback?code=c&state=s"]) {
      expect((await app.inject({ method: "GET", url })).statusCode).toBe(404);
    }
    expect((await app.inject({ method: "POST", url: "/auth/customer/handoff", payload: { code: "x" } })).statusCode).toBe(404);
  });

  it("with no CAA_REDIRECT_URI ⇒ 404 (feature not fully configured)", async () => {
    const app = await enable({ CAA_REDIRECT_URI: undefined });
    expect((await app.inject({ method: "GET", url: "/auth/customer/login", headers: { authorization: "Bearer x" } })).statusCode).toBe(404);
  });
});

describe("CAA /auth/customer/login", () => {
  it("no widget token ⇒ 401", async () => {
    const app = await enable();
    expect((await app.inject({ method: "GET", url: "/auth/customer/login" })).statusCode).toBe(401);
  });

  it("valid widget token ⇒ 302 to the shop's authorize URL + pending-auth persisted", async () => {
    const app = await enable();
    const res = await app.inject({ method: "GET", url: "/auth/customer/login", headers: { authorization: `Bearer ${await widgetToken(app)}` } });
    expect(res.statusCode).toBe(302);
    const loc = new URL(res.headers.location as string);
    expect(loc.origin + loc.pathname).toBe(`${ISSUER}/oauth/authorize`);
    expect(loc.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
    expect(loc.searchParams.get("state")).toBeTruthy();
  });

  it("valid embed key via ?key= ⇒ 302 (the window.open path — no Authorization header)", async () => {
    const app = await enable();
    const res = await app.inject({ method: "GET", url: "/auth/customer/login?key=acme-key" });
    expect(res.statusCode).toBe(302);
    expect(new URL(res.headers.location as string).searchParams.get("client_id")).toBe(CLIENT_ID);
  });

  it("an unknown ?key and no Bearer ⇒ 401", async () => {
    const app = await enable();
    expect((await app.inject({ method: "GET", url: "/auth/customer/login?key=nope" })).statusCode).toBe(401);
  });
});

describe("CAA round-trip (login → callback → handoff)", () => {
  it("mints a shopper token retrievable once via /auth/customer/handoff", async () => {
    const store = new InMemoryRuntimeStore();
    process.env.WIDGET_TOKEN_SECRET = "wsecret";
    process.env.WIDGET_AUTH_REQUIRED = "true";
    process.env.WIDGET_EMBED_KEYS = JSON.stringify({ "acme-key": "acme" });
    process.env.SHOPPER_AUTH = "true";
    process.env.SHOPPER_TOKEN_SECRET = "shopper-secret";
    process.env.SHOPIFY_STORES = JSON.stringify({ acme: SHOP });
    process.env.PALUP_SECRETS = JSON.stringify({ [CAA_GRANT_KEY_SCOPE]: { [CAA_GRANT_KEY_NAME]: "gk" }, acme: { caa_client_id: CLIENT_ID, caa_client_secret: "acme-secret" } });
    process.env.CAA_REDIRECT_URI = "https://widget.palup.ai/auth/customer/callback";
    const app = await buildServer({ store, caaFetch });

    const login = await app.inject({ method: "GET", url: "/auth/customer/login", headers: { authorization: `Bearer ${await widgetToken(app)}` } });
    const state = new URL(login.headers.location as string).searchParams.get("state")!;
    const pending = await store.get<{ nonce: string }>({ tenantId: CAA_APP_SCOPE }, CAA_PENDING_COLLECTION, state);
    const realNow = Math.floor(Date.now() / 1000); // the route uses real Date.now, so the token must too
    currentIdToken = mintIdToken({ sub: "48291", iss: ISSUER, aud: CLIENT_ID, exp: realNow + 300, iat: realNow - 5, nonce: pending!.nonce });

    const cb = await app.inject({ method: "GET", url: `/auth/customer/callback?code=code-abc&state=${encodeURIComponent(state)}` });
    expect(cb.statusCode).toBe(200);
    expect(cb.headers["content-type"]).toContain("text/html");
    const handoffCode = JSON.parse(cb.body.match(/postMessage\((\{.*?\}),/)![1].replace(/\\u003c/g, "<")).handoffCode as string;
    expect(handoffCode).toBeTruthy();

    const redeem = await app.inject({ method: "POST", url: "/auth/customer/handoff", payload: { code: handoffCode } });
    expect(JSON.parse(redeem.body).token).toBeTruthy();
    // single-use — a second redeem is 404
    expect((await app.inject({ method: "POST", url: "/auth/customer/handoff", payload: { code: handoffCode } })).statusCode).toBe(404);
  });
});

describe("CAA /auth/customer/logout (task 7)", () => {
  it("404 when off; 401 without a shopper token", async () => {
    expect((await (await enable({ SHOPPER_AUTH: undefined })).inject({ method: "POST", url: "/auth/customer/logout", payload: {} })).statusCode).toBe(404);
    expect((await (await enable()).inject({ method: "POST", url: "/auth/customer/logout", payload: {} })).statusCode).toBe(401);
  });

  it("a valid shopper token ⇒ deletes that shopper's stored grant", async () => {
    const store = new InMemoryRuntimeStore();
    process.env.WIDGET_TOKEN_SECRET = "wsecret";
    process.env.WIDGET_AUTH_REQUIRED = "true";
    process.env.WIDGET_EMBED_KEYS = JSON.stringify({ "acme-key": "acme" });
    process.env.SHOPPER_AUTH = "true";
    process.env.SHOPPER_TOKEN_SECRET = "shopper-secret";
    process.env.SHOPIFY_STORES = JSON.stringify({ acme: SHOP });
    process.env.PALUP_SECRETS = JSON.stringify({ [CAA_GRANT_KEY_SCOPE]: { [CAA_GRANT_KEY_NAME]: "gk" }, acme: { caa_client_id: CLIENT_ID, caa_client_secret: "acme-secret" } });
    process.env.CAA_REDIRECT_URI = "https://widget.palup.ai/auth/customer/callback";
    const app = await buildServer({ store, caaFetch });
    const grants = createCustomerGrantStore(store, createEnvSecrets(process.env.PALUP_SECRETS));
    await grants.put("acme", "shopify:acme:48291", { accessToken: "AT", grantedAt: 1 });
    const shopperTok = mintShopperToken("shopper-secret", "shopify:acme:48291", "shopify", 3600);
    const res = await app.inject({ method: "POST", url: "/auth/customer/logout", headers: { "x-shopper-token": shopperTok } });
    expect(res.statusCode).toBe(200);
    expect(await grants.get("acme", "shopify:acme:48291")).toBeNull(); // grant deleted
  });
});
