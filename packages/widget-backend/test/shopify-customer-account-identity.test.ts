import { describe, it, expect } from "vitest";
import { generateKeyPairSync, createSign, createHash } from "node:crypto";
import {
  generateCodeVerifier,
  deriveCodeChallenge,
  buildAuthorizeUrl,
  discoverOidc,
  exchangeCode,
  exchangeRefreshToken,
  fetchJwks,
  verifyIdToken,
  verifyIdTokenToPrincipal,
  normalizeCustomerSubject,
  type OidcConfig,
  type Jwks,
} from "../src/shopify-customer-account-identity.js";

// ADR-0018 task 3: the Customer Account API OAuth adapter core. These tests mint REAL RS256 JWTs with a
// throwaway keypair and verify against the matching JWKS, so verifyIdToken is exercised as real crypto
// (signature + alg-confusion + issuer/aud/nonce/exp), not a stub.

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KID = "test-kid-1";
const JWKS: Jwks = { keys: [{ ...(publicKey.export({ format: "jwk" }) as object), kid: KID, alg: "RS256", use: "sig" }] };

const ISS = "https://shopify.com/authentication/72199635021";
const AUD = "test-client-id";
const NONCE = "test-nonce-abc";
const NOW = 1_700_000_000;
const b64url = (o: unknown): string => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");

function mintIdToken(claims: Record<string, unknown>, o: { kid?: string; alg?: string; sign?: boolean; key?: import("node:crypto").KeyObject } = {}): string {
  const header = b64url({ alg: o.alg ?? "RS256", kid: o.kid ?? KID, typ: "JWT" });
  const payload = b64url(claims);
  const signingInput = `${header}.${payload}`;
  if (o.sign === false) return `${signingInput}.`; // unsigned (alg:none style)
  const s = createSign("RSA-SHA256");
  s.update(signingInput);
  s.end();
  return `${signingInput}.${s.sign(o.key ?? privateKey).toString("base64url")}`;
}
const validClaims = (over: Record<string, unknown> = {}) => ({ sub: "48291", iss: ISS, aud: AUD, exp: NOW + 300, iat: NOW - 10, nonce: NONCE, ...over });
const opts = (over = {}) => ({ jwks: JWKS, expectedIssuer: ISS, expectedAudience: AUD, expectedNonce: NONCE, nowSec: () => NOW, ...over });

describe("PKCE (S256)", () => {
  it("challenge = base64url(sha256(verifier)) and the verifier is URL-safe", () => {
    const v = generateCodeVerifier();
    expect(v).toMatch(/^[A-Za-z0-9_-]+$/); // no +,/,= — url-safe
    expect(v.length).toBeGreaterThanOrEqual(43);
    expect(deriveCodeChallenge(v)).toBe(createHash("sha256").update(v).digest().toString("base64url"));
  });
});

describe("buildAuthorizeUrl", () => {
  it("carries every OAuth2+PKCE param incl. code_challenge_method=S256", () => {
    const cfg: OidcConfig = { issuer: ISS, authorization_endpoint: `${ISS}/oauth/authorize`, token_endpoint: `${ISS}/oauth/token`, jwks_uri: `${ISS}/.well-known/jwks.json` };
    const url = new URL(buildAuthorizeUrl(cfg, { clientId: AUD, redirectUri: "https://widget.palup.ai/auth/customer/callback", scope: "openid email customer-account-api:full", state: "st8", nonce: NONCE, codeChallenge: "chal" }));
    expect(url.origin + url.pathname).toBe(`${ISS}/oauth/authorize`);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe(AUD);
    expect(url.searchParams.get("redirect_uri")).toBe("https://widget.palup.ai/auth/customer/callback");
    expect(url.searchParams.get("scope")).toBe("openid email customer-account-api:full");
    expect(url.searchParams.get("state")).toBe("st8");
    expect(url.searchParams.get("nonce")).toBe(NONCE);
    expect(url.searchParams.get("code_challenge")).toBe("chal");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });
});

describe("verifyIdToken (RS256 via JWKS)", () => {
  it("a valid token ⇒ claims", () => {
    expect(verifyIdToken(mintIdToken(validClaims()), opts())?.sub).toBe("48291");
  });
  it("valid ⇒ Principal shopify:<tenant>:<numericId>", () => {
    expect(verifyIdTokenToPrincipal(mintIdToken(validClaims()), "acme", opts())).toEqual({ kind: "shopper", shopperId: "shopify:acme:48291", source: "shopify", verified: true });
  });
  it("aud as an array containing our client_id ⇒ valid", () => {
    expect(verifyIdToken(mintIdToken(validClaims({ aud: ["other", AUD] })), opts())?.sub).toBe("48291");
  });

  // --- each failure path fails CLOSED to null ---
  it("wrong issuer ⇒ null (issuer pinned to the flow's shop)", () => {
    expect(verifyIdToken(mintIdToken(validClaims({ iss: "https://shopify.com/authentication/999" })), opts())).toBeNull();
  });
  it("wrong audience ⇒ null", () => {
    expect(verifyIdToken(mintIdToken(validClaims({ aud: "someone-else" })), opts())).toBeNull();
  });
  it("wrong / missing nonce ⇒ null (replay / cross-flow)", () => {
    expect(verifyIdToken(mintIdToken(validClaims({ nonce: "different" })), opts())).toBeNull();
    expect(verifyIdToken(mintIdToken(validClaims({ nonce: undefined })), opts())).toBeNull();
  });
  it("expired ⇒ null", () => {
    expect(verifyIdToken(mintIdToken(validClaims({ exp: NOW - 61 })), opts())).toBeNull();
  });
  it("issued in the future ⇒ null", () => {
    expect(verifyIdToken(mintIdToken(validClaims({ iat: NOW + 120 })), opts())).toBeNull();
  });
  it("tampered signature ⇒ null", () => {
    const t = mintIdToken(validClaims());
    const bad = t.slice(0, -2) + (t.slice(-2) === "aa" ? "bb" : "aa");
    expect(verifyIdToken(bad, opts())).toBeNull();
  });
  it("signed by a DIFFERENT key (not in the JWKS) ⇒ null", () => {
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
    expect(verifyIdToken(mintIdToken(validClaims(), { key: other.privateKey }), opts())).toBeNull();
  });
  it("alg=none (unsigned) ⇒ null", () => {
    expect(verifyIdToken(mintIdToken(validClaims(), { alg: "none", sign: false }), opts())).toBeNull();
  });
  it("alg=HS256 (algorithm confusion) ⇒ null even with an otherwise-valid RS256 signature", () => {
    expect(verifyIdToken(mintIdToken(validClaims(), { alg: "HS256" }), opts())).toBeNull();
  });
  it("unknown kid ⇒ null", () => {
    expect(verifyIdToken(mintIdToken(validClaims(), { kid: "not-in-jwks" }), opts())).toBeNull();
  });
  it("malformed token (not 3 parts) ⇒ null; never throws", () => {
    expect(verifyIdToken("a.b", opts())).toBeNull();
    expect(verifyIdToken("garbage", opts())).toBeNull();
  });
  it("verifyIdTokenToPrincipal on any invalid token ⇒ anonymous", () => {
    expect(verifyIdTokenToPrincipal(mintIdToken(validClaims({ iss: "https://evil" })), "acme", opts())).toEqual({ kind: "anonymous" });
  });
  it("a non-numeric / unresolvable sub ⇒ anonymous (buildShopifyShopperId guard holds)", () => {
    expect(verifyIdTokenToPrincipal(mintIdToken(validClaims({ sub: "not-a-customer" })), "acme", opts())).toEqual({ kind: "anonymous" });
  });
});

describe("normalizeCustomerSubject", () => {
  it("bare numeric ⇒ itself", () => expect(normalizeCustomerSubject("48291")).toBe("48291"));
  it("Shopify GID ⇒ the numeric id", () => {
    expect(normalizeCustomerSubject("gid://shopify/Customer/48291")).toBe("48291");
    expect(normalizeCustomerSubject("gid://shopify/Customer/48291?foo=1")).toBe("48291");
  });
  it("non-numeric / empty ⇒ undefined", () => {
    expect(normalizeCustomerSubject("abc")).toBeUndefined();
    expect(normalizeCustomerSubject("")).toBeUndefined();
  });
});

// --- network helpers (injectable fetch) -------------------------------------------------------------
type FetchFn = typeof globalThis.fetch;
const okFetch = (data: unknown): FetchFn => (async () => ({ ok: true, status: 200, json: async () => data })) as unknown as FetchFn;
const errFetch = (status: number): FetchFn => (async () => ({ ok: false, status, json: async () => ({}) })) as unknown as FetchFn;

describe("discoverOidc", () => {
  const good = { issuer: ISS, authorization_endpoint: `${ISS}/oauth/authorize`, token_endpoint: `${ISS}/oauth/token`, jwks_uri: `${ISS}/.well-known/jwks.json` };
  it("valid https config on a myshopify host ⇒ OidcConfig", async () => {
    expect(await discoverOidc("acme.myshopify.com", okFetch(good))).toEqual(good);
  });
  it("a non-myshopify host ⇒ null (never fetched — SSRF guard)", async () => {
    let called = false;
    const spy: FetchFn = (async () => { called = true; return { ok: true, status: 200, json: async () => good }; }) as unknown as FetchFn;
    expect(await discoverOidc("evil.example.com", spy)).toBeNull();
    expect(called).toBe(false);
  });
  it("any non-https endpoint in the doc ⇒ null", async () => {
    expect(await discoverOidc("acme.myshopify.com", okFetch({ ...good, token_endpoint: "http://shopify.com/authentication/1/oauth/token" }))).toBeNull();
  });
  it("an endpoint on a non-shopify.com host (even https) ⇒ null — host-pinned, not just https", async () => {
    expect(await discoverOidc("acme.myshopify.com", okFetch({ ...good, jwks_uri: "https://attacker.example/jwks.json" }))).toBeNull();
    expect(await discoverOidc("acme.myshopify.com", okFetch({ ...good, token_endpoint: "https://evil.example/token" }))).toBeNull();
    expect(await discoverOidc("acme.myshopify.com", okFetch({ ...good, issuer: "https://shopify.com.attacker.example/x" }))).toBeNull();
  });
  it("non-2xx ⇒ null", async () => {
    expect(await discoverOidc("acme.myshopify.com", errFetch(404))).toBeNull();
  });
});

describe("exchangeCode", () => {
  const cfg: OidcConfig = { issuer: ISS, authorization_endpoint: `${ISS}/oauth/authorize`, token_endpoint: `${ISS}/oauth/token`, jwks_uri: `${ISS}/.well-known/jwks.json` };
  it("confidential client ⇒ POSTs client_secret via Basic auth + code_verifier; returns tokens", async () => {
    let captured: { url: unknown; opts: { headers?: Record<string, string>; body?: string } } | undefined;
    const cap: FetchFn = (async (url: unknown, o: unknown) => {
      captured = { url, opts: o as { headers?: Record<string, string>; body?: string } };
      return { ok: true, status: 200, json: async () => ({ access_token: "at", refresh_token: "rt", id_token: "it", expires_in: 3600 }) };
    }) as unknown as FetchFn;
    const res = await exchangeCode(cfg, { code: "c", codeVerifier: "v", clientId: AUD, clientSecret: "secret", redirectUri: "https://widget.palup.ai/cb" }, cap);
    expect(res).toEqual({ access_token: "at", refresh_token: "rt", id_token: "it", expires_in: 3600 });
    expect(captured!.opts.headers!["authorization"]).toBe("Basic " + Buffer.from(`${AUD}:secret`).toString("base64"));
    expect(captured!.opts.body).toContain("code_verifier=v");
    expect(captured!.opts.body).toContain("grant_type=authorization_code");
  });
  it("a non-https OR non-shopify.com token endpoint ⇒ null (never sends the secret)", async () => {
    for (const ep of ["http://shopify.com/authentication/1/oauth/token", "https://attacker.example/token"]) {
      let called = false;
      const spy: FetchFn = (async () => { called = true; return { ok: true, status: 200, json: async () => ({ access_token: "a", id_token: "b" }) }; }) as unknown as FetchFn;
      expect(await exchangeCode({ ...cfg, token_endpoint: ep }, { code: "c", codeVerifier: "v", clientId: AUD, clientSecret: "secret", redirectUri: "x" }, spy)).toBeNull();
      expect(called).toBe(false); // secret never left the process
    }
  });
  it("a response missing id_token ⇒ null", async () => {
    expect(await exchangeCode(cfg, { code: "c", codeVerifier: "v", clientId: AUD, redirectUri: "x" }, okFetch({ access_token: "at" }))).toBeNull();
  });
});

describe("exchangeRefreshToken", () => {
  const cfg: OidcConfig = { issuer: ISS, authorization_endpoint: `${ISS}/oauth/authorize`, token_endpoint: `${ISS}/oauth/token`, jwks_uri: `${ISS}/.well-known/jwks.json` };
  it("confidential client ⇒ POSTs grant_type=refresh_token + Basic auth; returns new tokens (no id_token)", async () => {
    let captured: { headers?: Record<string, string>; body?: string } | undefined;
    const cap: FetchFn = (async (_url: unknown, o: unknown) => {
      captured = o as { headers?: Record<string, string>; body?: string };
      return { ok: true, status: 200, json: async () => ({ access_token: "NAT", refresh_token: "NRT", expires_in: 3600 }) };
    }) as unknown as FetchFn;
    expect(await exchangeRefreshToken(cfg, { refreshToken: "RT", clientId: AUD, clientSecret: "secret" }, cap)).toEqual({ access_token: "NAT", refresh_token: "NRT", expires_in: 3600 });
    expect(captured!.headers!["authorization"]).toBe("Basic " + Buffer.from(`${AUD}:secret`).toString("base64"));
    expect(captured!.body).toContain("grant_type=refresh_token");
    expect(captured!.body).toContain("refresh_token=RT");
  });
  it("a non-shopify token endpoint (https attacker) ⇒ null, never sends the secret", async () => {
    let called = false;
    const spy: FetchFn = (async () => { called = true; return { ok: true, status: 200, json: async () => ({}) }; }) as unknown as FetchFn;
    expect(await exchangeRefreshToken({ ...cfg, token_endpoint: "https://attacker.example/token" }, { refreshToken: "RT", clientId: AUD, clientSecret: "s" }, spy)).toBeNull();
    expect(called).toBe(false);
  });
  it("a non-2xx / a response with no access_token ⇒ null", async () => {
    expect(await exchangeRefreshToken(cfg, { refreshToken: "RT", clientId: AUD }, errFetch(400))).toBeNull();
    expect(await exchangeRefreshToken(cfg, { refreshToken: "RT", clientId: AUD }, okFetch({ refresh_token: "x" }))).toBeNull();
  });
});

describe("fetchJwks", () => {
  it("shopify.com https + {keys:[...]} ⇒ Jwks; http ⇒ null", async () => {
    expect(await fetchJwks(`${ISS}/.well-known/jwks.json`, okFetch(JWKS))).toEqual(JWKS);
    expect(await fetchJwks("http://shopify.com/authentication/1/jwks.json", okFetch(JWKS))).toBeNull();
  });
  it("a non-shopify.com jwks uri (https attacker) ⇒ null, never fetched (sole trust anchor)", async () => {
    let called = false;
    const spy: FetchFn = (async () => { called = true; return { ok: true, status: 200, json: async () => JWKS }; }) as unknown as FetchFn;
    expect(await fetchJwks("https://attacker.example/jwks.json", spy)).toBeNull();
    expect(called).toBe(false);
  });
});

// --- #127: branded customer-account domain (issuer stays shopify.com; endpoints move to the shop's own
// account domain — verified live against Allbirds, 2026-08-18: issuer=https://shopify.com/authentication/
// 11044168, token_endpoint=https://accounts.allbirds.com/authentication/oauth/token). ---------------------
describe("branded customer-account domain (#127)", () => {
  const brandedCfg: OidcConfig = {
    issuer: ISS,
    authorization_endpoint: "https://accounts.brand.com/authentication/oauth/authorize",
    token_endpoint: "https://accounts.brand.com/authentication/oauth/token",
    jwks_uri: "https://accounts.brand.com/authentication/oauth/.well-known/jwks.json",
  };

  it("discoverOidc: issuer=shopify.com but authorize/token/jwks all on the shop's OWN branded domain ⇒ resolves (not null)", async () => {
    expect(await discoverOidc("acme.myshopify.com", okFetch(brandedCfg))).toEqual(brandedCfg);
  });

  it("exchangeCode against the branded token_endpoint ⇒ allowed (sends the secret)", async () => {
    let called = false;
    const cap: FetchFn = (async () => { called = true; return { ok: true, status: 200, json: async () => ({ access_token: "at", id_token: "it" }) }; }) as unknown as FetchFn;
    const res = await exchangeCode(brandedCfg, { code: "c", codeVerifier: "v", clientId: AUD, clientSecret: "s", redirectUri: "https://widget.palup.ai/cb" }, cap);
    expect(res).toEqual({ access_token: "at", id_token: "it" });
    expect(called).toBe(true);
  });

  it("exchangeRefreshToken against the branded token_endpoint ⇒ allowed", async () => {
    const cap: FetchFn = okFetch({ access_token: "NAT" });
    expect(await exchangeRefreshToken(brandedCfg, { refreshToken: "RT", clientId: AUD, clientSecret: "s" }, cap)).toEqual({ access_token: "NAT" });
  });

  it("fetchJwks against the branded jwks_uri, given the discovered cfg ⇒ allowed", async () => {
    expect(await fetchJwks(brandedCfg.jwks_uri, okFetch(JWKS), undefined, brandedCfg)).toEqual(JWKS);
  });

  it("fetchJwks against a branded-domain jwks_uri WITHOUT the corroborating cfg ⇒ null (no anchor to trust it)", async () => {
    expect(await fetchJwks(brandedCfg.jwks_uri, okFetch(JWKS))).toBeNull();
  });

  it("a custom-domain ISSUER (not shopify.com) ⇒ discoverOidc rejects — issuer never moves off shopify.com", async () => {
    expect(await discoverOidc("acme.myshopify.com", okFetch({ ...brandedCfg, issuer: "https://accounts.brand.com/authentication/11044168" }))).toBeNull();
  });

  it("spoof still rejected: an endpoint host the shop's OWN discovery doc did NOT consistently name ⇒ null", async () => {
    // token_endpoint diverges from the branded host the OTHER two endpoints agree on.
    expect(await discoverOidc("acme.myshopify.com", okFetch({ ...brandedCfg, token_endpoint: "https://evil.example.com/token" }))).toBeNull();
    // jwks_uri diverges instead.
    expect(await discoverOidc("acme.myshopify.com", okFetch({ ...brandedCfg, jwks_uri: "https://evil.example.com/jwks.json" }))).toBeNull();
    // a non-https endpoint on the (otherwise consistent) branded domain is still refused.
    expect(await discoverOidc("acme.myshopify.com", okFetch({ ...brandedCfg, token_endpoint: "http://accounts.brand.com/authentication/oauth/token" }))).toBeNull();
  });

  it("exchangeCode refuses a token_endpoint the passed-in cfg does not itself corroborate (defense in depth)", async () => {
    let called = false;
    const spy: FetchFn = (async () => { called = true; return { ok: true, status: 200, json: async () => ({ access_token: "a", id_token: "b" }) }; }) as unknown as FetchFn;
    const tamperedCfg: OidcConfig = { ...brandedCfg, token_endpoint: "https://evil.example.com/token" };
    expect(await exchangeCode(tamperedCfg, { code: "c", codeVerifier: "v", clientId: AUD, clientSecret: "s", redirectUri: "x" }, spy)).toBeNull();
    expect(called).toBe(false); // secret never left the process
  });

  it("default *.myshopify.com discovery is unaffected: all endpoints on shopify.com resolve exactly as before", async () => {
    const good = { issuer: ISS, authorization_endpoint: `${ISS}/oauth/authorize`, token_endpoint: `${ISS}/oauth/token`, jwks_uri: `${ISS}/.well-known/jwks.json` };
    expect(await discoverOidc("acme.myshopify.com", okFetch(good))).toEqual(good);
  });
});
