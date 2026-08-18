import { createHash, randomBytes, createPublicKey, createVerify } from "node:crypto";
import type { Principal } from "@palup/platform-ports";
import { buildShopifyShopperId } from "@palup/platform-ports";

// Shopify Customer Account API (CAA) OAuth adapter (ADR-0018, task 3) — a Shopify-specific ADAPTER behind
// the portable IdentityPort/Principal (ADR-0001): node:crypto + a plain fetch client, NO Shopify SDK,
// HTTPS only. It produces the SAME {kind:'shopper', source:'shopify', shopperId} Principal as the
// App-Proxy adapter (shopify-shopper-identity.ts), so ONE Shopify customer resolves to ONE shopperId
// across both paths. This module is the PURE/injectable core — PKCE, OIDC discovery, code→token
// exchange, id_token validation, subject normalization; the routes + encrypted token storage live in
// server.ts + the GrantStore (ADR-0018 tasks 4-7). Every failure fails CLOSED (null / anonymous), never
// throws. Wire facts pinned at the ADR-0018 spike (shopify.dev + the live OIDC metadata, 2026-08-02):
// Authorization Code + PKCE(S256), confidential client (client_secret via Basic auth), RS256 id_tokens,
// per-shop issuer https://shopify.com/authentication/<shop-id> discovered dynamically.

const b64url = (buf: Buffer): string => buf.toString("base64url");

// The DISCOVERY doc is fetched from the merchant's store host (SSRF guard). Mirrors shopify-grounding.ts.
const SHOP_HOST = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i;
// The id_token ISSUER never moves off Shopify's own identity host — pinned to `shopify.com` /
// `*.shopify.com` (the `iss` a store with a BRANDED customer-account domain still returns, e.g.
// `https://shopify.com/authentication/<shop-id>`; verified live against Allbirds, 2026-08-18). This pin
// alone gives NO protection against a spoofed discovery doc, because verifyIdToken's expectedIssuer is
// derived from that same doc — see isTrustedEndpointUrl below for the endpoint-host trust model.
const SHOPIFY_IDENTITY_HOST = /^([a-z0-9-]+\.)*shopify\.com$/i;
/** True iff `u` is https AND its host is Shopify's own identity host. Used ONLY for the issuer pin. */
const isShopifyIdentityUrl = (u: string): boolean => {
  try {
    const url = new URL(u);
    return url.protocol === "https:" && SHOPIFY_IDENTITY_HOST.test(url.hostname);
  } catch {
    return false;
  }
};

/** https hostname of `u`, lowercased, or null if `u` isn't a valid https URL. */
const httpsHost = (u: string): string | null => {
  try {
    const url = new URL(u);
    return url.protocol === "https:" ? url.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
};

/**
 * True iff `u` is a TRUSTED OIDC endpoint (authorize/token/jwks — NOT the issuer, which stays pinned to
 * shopify.com always). Trusted means https AND its host is EITHER:
 *  (a) Shopify's own identity host (`*.shopify.com`) — the default `*.myshopify.com` store case, OR
 *  (b) a store's own BRANDED customer-account domain (e.g. `accounts.allbirds.com`) — accepted only when
 *      `cfg`'s authorization_endpoint, token_endpoint, AND jwks_uri all agree on that SAME single host.
 * Case (b)'s trust anchor is `cfg` itself, per discoverOidc: `cfg` only ever comes from ONE HTTPS fetch of
 * `https://{shopDomain}/.well-known/openid-configuration`, made against the shop's OWN SSRF-guarded
 * `*.myshopify.com` host (never an attacker-chosen host — see SHOP_HOST above). Whatever that ONE document
 * consistently names for all three endpoints is authoritative for that shop; a document (or a since-
 * tampered cfg) that names a DIFFERENT host for even one of the three endpoints fails this check and is
 * rejected — so this is NOT "accept any https URL", it is "accept only what this shop's own discovery
 * doc named, and only when it named it consistently."
 */
const isTrustedEndpointUrl = (u: string, cfg?: Pick<OidcConfig, "authorization_endpoint" | "token_endpoint" | "jwks_uri">): boolean => {
  const host = httpsHost(u);
  if (!host) return false;
  if (SHOPIFY_IDENTITY_HOST.test(host)) return true;
  if (!cfg) return false;
  const authHost = httpsHost(cfg.authorization_endpoint);
  const tokenHost = httpsHost(cfg.token_endpoint);
  const jwksHost = httpsHost(cfg.jwks_uri);
  return authHost === host && tokenHost === host && jwksHost === host;
};

// --- PKCE (RFC 7636, S256) --------------------------------------------------------------------------
/** High-entropy code verifier (32 random bytes → 43-char base64url). */
export function generateCodeVerifier(): string {
  return b64url(randomBytes(32));
}
/** S256 challenge = base64url(SHA-256(verifier)). */
export function deriveCodeChallenge(verifier: string): string {
  return b64url(createHash("sha256").update(verifier).digest());
}
/** Anti-CSRF state / OIDC nonce — single-use random values. */
export function randomToken(bytes = 32): string {
  return b64url(randomBytes(bytes));
}

// --- OIDC discovery (per-shop, dynamic — never hardcode endpoints) ----------------------------------
export interface OidcConfig {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

/**
 * Fetch + validate a shop's OIDC discovery doc from `https://{shopDomain}/.well-known/openid-configuration`.
 * The returned `issuer` is the per-shop `https://shopify.com/authentication/<shop-id>` used to PIN
 * id_token `iss` to THIS shop (ADR-0018 hardening #2) — the issuer MUST be host-pinned to shopify.com
 * (`isShopifyIdentityUrl`), even for a branded-domain store (#127). The authorize/token/jwks endpoints
 * MUST be https AND trusted (`isTrustedEndpointUrl`): either shopify.com-pinned (default `*.myshopify.com`
 * stores), or — for a store with its own branded customer-account domain (e.g. `accounts.allbirds.com`) —
 * the ONE host this doc consistently names for all three. Returns null on any failure, including a doc
 * that names an inconsistent/untrusted host for any endpoint — the caller fails closed to anonymous.
 */
export async function discoverOidc(
  shopDomain: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
  timeoutMs = 4000,
): Promise<OidcConfig | null> {
  if (!SHOP_HOST.test(shopDomain)) return null;
  try {
    const res = await fetchFn(`https://${shopDomain}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const j = (await res.json()) as Partial<OidcConfig>;
    const cfg: OidcConfig = {
      issuer: j.issuer as string,
      authorization_endpoint: j.authorization_endpoint as string,
      token_endpoint: j.token_endpoint as string,
      jwks_uri: j.jwks_uri as string,
    };
    // Issuer stays pinned to shopify.com — it never moves to a branded domain (#127).
    if (typeof cfg.issuer !== "string" || !isShopifyIdentityUrl(cfg.issuer)) return null;
    // Endpoints: shopify.com OR this shop's own single, self-consistent branded account domain.
    if (![cfg.authorization_endpoint, cfg.token_endpoint, cfg.jwks_uri].every((v) => typeof v === "string" && isTrustedEndpointUrl(v, cfg))) return null;
    return cfg;
  } catch {
    return null;
  }
}

// --- Authorize URL ----------------------------------------------------------------------------------
export interface AuthorizeParams {
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string;
  nonce: string;
  codeChallenge: string;
}

/** Build the authorize redirect URL (Authorization Code + PKCE S256). */
export function buildAuthorizeUrl(cfg: OidcConfig, p: AuthorizeParams): string {
  const u = new URL(cfg.authorization_endpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", p.clientId);
  u.searchParams.set("redirect_uri", p.redirectUri);
  u.searchParams.set("scope", p.scope);
  u.searchParams.set("state", p.state);
  u.searchParams.set("nonce", p.nonce);
  u.searchParams.set("code_challenge", p.codeChallenge);
  u.searchParams.set("code_challenge_method", "S256");
  return u.toString();
}

// --- Code → token exchange (confidential client) ----------------------------------------------------
export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token: string;
  expires_in?: number;
  token_type?: string;
}

/**
 * Exchange an authorization code for tokens against THIS shop's token endpoint. Confidential client:
 * the client_secret is sent in the `Authorization: Basic` header (per shopify.dev), PLUS the PKCE
 * code_verifier. HTTPS only. Returns null on any non-2xx / malformed response (caller fails closed).
 * Never logs the code_verifier / client_secret / tokens.
 */
export async function exchangeCode(
  cfg: OidcConfig,
  params: { code: string; codeVerifier: string; clientId: string; clientSecret?: string; redirectUri: string },
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
  timeoutMs = 4000,
): Promise<TokenResponse | null> {
  // Re-assert the host trust here (defense in depth — this fn takes a raw cfg) BEFORE sending the secret.
  // Shopify.com OR this shop's own branded domain, IFF cfg's endpoints agree on it (isTrustedEndpointUrl).
  if (!isTrustedEndpointUrl(cfg.token_endpoint, cfg)) return null;
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    redirect_uri: params.redirectUri,
    client_id: params.clientId,
    code_verifier: params.codeVerifier,
  });
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
  if (params.clientSecret) headers["authorization"] = "Basic " + Buffer.from(`${params.clientId}:${params.clientSecret}`).toString("base64");
  try {
    // redirect:"error" — a 3xx must NOT bounce the client_secret off the pinned host.
    const res = await fetchFn(cfg.token_endpoint, { method: "POST", headers, body: body.toString(), redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const j = (await res.json()) as Partial<TokenResponse>;
    if (typeof j.id_token !== "string" || typeof j.access_token !== "string") return null;
    return j as TokenResponse;
  } catch {
    return null;
  }
}

/** A refresh_token grant returns a new access token (and possibly a rotated refresh token); it does NOT
 * return an id_token (identity was already established at authorization — ADR-0018 task 7). */
export interface RefreshResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
}

/**
 * Exchange a refresh_token for a fresh access token (confidential client — client_secret via Basic auth).
 * Same host-pin + https + redirect:"error" discipline as `exchangeCode`. Null on any non-2xx / malformed
 * response (⇒ the caller reauths). Never logs the refresh_token / client_secret / tokens.
 */
export async function exchangeRefreshToken(
  cfg: OidcConfig,
  params: { refreshToken: string; clientId: string; clientSecret?: string },
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
  timeoutMs = 4000,
): Promise<RefreshResponse | null> {
  if (!isTrustedEndpointUrl(cfg.token_endpoint, cfg)) return null;
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: params.refreshToken, client_id: params.clientId });
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
  if (params.clientSecret) headers["authorization"] = "Basic " + Buffer.from(`${params.clientId}:${params.clientSecret}`).toString("base64");
  try {
    const res = await fetchFn(cfg.token_endpoint, { method: "POST", headers, body: body.toString(), redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const j = (await res.json()) as Partial<RefreshResponse>;
    if (typeof j.access_token !== "string") return null;
    return j as RefreshResponse;
  } catch {
    return null;
  }
}

// --- id_token validation (RS256 via the shop's JWKS) ------------------------------------------------
export interface Jwk {
  kid?: string;
  kty?: string;
  n?: string;
  e?: string;
  alg?: string;
  use?: string;
}
export interface Jwks {
  keys: Jwk[];
}
export interface IdTokenClaims {
  sub?: string;
  iss?: string;
  aud?: string | string[];
  exp?: number;
  iat?: number;
  nonce?: string;
}

/**
 * Fetch the shop's JWKS (https only). Null on failure → caller fails closed (never verifies open). The
 * JWKS is the SOLE trust anchor for verifyIdToken — host-pin it (shopify.com OR, IFF `cfg` is passed and
 * its endpoints agree, this shop's own branded domain — see isTrustedEndpointUrl), and refuse a 3xx bounce.
 * `cfg` is optional ONLY for callers that pre-validated the host themselves; production callers pass the
 * SAME `cfg` that named this `jwksUri`, so the trust check matches discoverOidc's decision for this shop.
 */
export async function fetchJwks(
  jwksUri: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
  timeoutMs = 4000,
  cfg?: Pick<OidcConfig, "authorization_endpoint" | "token_endpoint" | "jwks_uri">,
): Promise<Jwks | null> {
  if (!isTrustedEndpointUrl(jwksUri, cfg)) return null;
  try {
    const res = await fetchFn(jwksUri, { redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const j = (await res.json()) as Partial<Jwks>;
    if (!j || !Array.isArray(j.keys)) return null;
    return j as Jwks;
  } catch {
    return null;
  }
}

export interface VerifyIdTokenOptions {
  jwks: Jwks;
  expectedIssuer: string;
  expectedAudience: string;
  expectedNonce: string;
  nowSec?: () => number;
  maxSkewSeconds?: number;
}

/**
 * Verify a Customer-Account id_token and return its claims, or null (fail closed). Checks, in order:
 * RS256 only (alg-confusion / `none` / HS256 defense), signature via the JWKS key matched by `kid`
 * (unknown kid ⇒ null), `iss` == the flow shop's issuer (pinned — ADR-0018 #2), `aud` == our client_id,
 * `exp` not passed + `iat` not in the future (skew-tolerant), and `nonce` == the flow's nonce. NEVER throws.
 */
export function verifyIdToken(idToken: string, opts: VerifyIdTokenOptions): IdTokenClaims | null {
  try {
    const parts = idToken.split(".");
    if (parts.length !== 3) return null;
    const [h, p, s] = parts;
    if (!h || !p || !s) return null; // the length check above does not narrow a destructure
    const header = JSON.parse(Buffer.from(h, "base64url").toString("utf8")) as { alg?: string; kid?: string };
    if (header.alg !== "RS256" || !header.kid) return null; // only RS256 with a kid — no `none`, no HS256 (alg confusion)
    const jwk = opts.jwks.keys.find((k) => k.kid === header.kid && k.kty === "RSA");
    if (!jwk) return null; // unknown kid ⇒ fail closed
    let pub;
    try {
      pub = createPublicKey({ key: jwk as unknown as JsonWebKey, format: "jwk" });
    } catch {
      return null;
    }
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${h}.${p}`);
    verifier.end();
    if (!verifier.verify(pub, Buffer.from(s, "base64url"))) return null; // bad signature

    const claims = JSON.parse(Buffer.from(p, "base64url").toString("utf8")) as IdTokenClaims;
    const now = (opts.nowSec ?? (() => Math.floor(Date.now() / 1000)))();
    const skew = opts.maxSkewSeconds ?? 60;
    if (claims.iss !== opts.expectedIssuer) return null; // issuer pinned to the flow's shop
    const aud = claims.aud;
    const audOk = aud === opts.expectedAudience || (Array.isArray(aud) && aud.includes(opts.expectedAudience));
    if (!audOk) return null;
    if (typeof claims.exp !== "number" || now - skew >= claims.exp) return null; // expired
    if (typeof claims.iat === "number" && claims.iat - skew > now) return null; // issued in the future
    if (!claims.nonce || claims.nonce !== opts.expectedNonce) return null; // replay / cross-flow
    if (typeof claims.sub !== "string" || !claims.sub) return null;
    return claims;
  } catch {
    return null; // malformed base64/JSON etc. — never throw
  }
}

// --- Subject → shopperId ----------------------------------------------------------------------------
/**
 * Normalize the id_token `sub` to the numeric legacy customer id App-Proxy uses, so CAA and App-Proxy
 * yield the IDENTICAL shopperId for the same customer. Accepts a bare numeric id or a Shopify GID
 * (`gid://shopify/Customer/<id>`) / any `.../Customer/<digits>` form; anything else ⇒ undefined (the exact
 * sub format is observed at build per ADR-0018). Does NOT loosen buildShopifyShopperId's `/^\d+$/`.
 */
export function normalizeCustomerSubject(sub: string): string | undefined {
  if (/^\d+$/.test(sub)) return sub;
  const m = /\/Customer\/(\d+)(?:[/?#]|$)/.exec(sub);
  return m ? m[1] : undefined;
}

/**
 * Map verified id_token claims → a Principal for the given tenant. Fails closed to anonymous.
 *
 * CALLER CONTRACT (tenant ↔ issuer binding — cross-tenant isolation): `tenant` and the `expectedIssuer`
 * used to verify the token MUST both be derived from the SAME source — the tenant's OWN shop discovery
 * (resolve `tenant` → its `*.myshopify.com` domain → that shop's OIDC `issuer`). Passing a `tenant` that
 * doesn't correspond to the token's shop would mint `shopify:<wrong-tenant>:<sub>`. The core can't
 * resolve tenant→shop, so the route (ADR-0018 task 5) owns this binding and MUST test it (a token from
 * shop A must never mint under tenant B).
 */
export function caaClaimsToPrincipal(tenant: string, claims: IdTokenClaims): Principal {
  const numeric = typeof claims.sub === "string" ? normalizeCustomerSubject(claims.sub) : undefined;
  const shopperId = numeric ? buildShopifyShopperId(tenant, numeric) : undefined;
  if (!shopperId) return { kind: "anonymous" };
  return { kind: "shopper", shopperId, source: "shopify", verified: true };
}

/** Convenience: validate an id_token and map it to a Principal in one call (id_token → Principal|anonymous). */
export function verifyIdTokenToPrincipal(idToken: string, tenant: string, opts: VerifyIdTokenOptions): Principal {
  const claims = verifyIdToken(idToken, opts);
  return claims ? caaClaimsToPrincipal(tenant, claims) : { kind: "anonymous" };
}
