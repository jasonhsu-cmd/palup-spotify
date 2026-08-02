import type { RuntimeStatePort, Principal } from "@palup/platform-ports";
import { mintShopperToken } from "@palup/platform-ports";
import {
  discoverOidc,
  buildAuthorizeUrl,
  exchangeCode,
  fetchJwks,
  verifyIdTokenToPrincipal,
  generateCodeVerifier,
  deriveCodeChallenge,
  randomToken,
} from "./shopify-customer-account-identity.js";
import type { CustomerGrantStore } from "./customer-grant-store.js";

// Customer Account API OAuth flow orchestration (ADR-0018 tasks 4-5). Pure/injectable so the security
// invariants are testable without Fastify. The routes in server.ts are thin wrappers around these.
//
// Pending-auth + handoff live in an APP-SCOPED RuntimeState collection (tenantId="__shopify_app__"),
// because /auth/customer/callback is a top-level Shopify redirect carrying only code/state/error — no
// widget Bearer, so NO tenant is available from the request (ADR-0018 hardening #1). The tenant lives
// INSIDE the pending-auth VALUE (set at login from the verified widget tenant) and is authoritative
// downstream. The random `state` key is unguessable + single-use.

export const CAA_APP_SCOPE = "__shopify_app__";
export const CAA_PENDING_COLLECTION = "caa_pending";
export const CAA_HANDOFF_COLLECTION = "caa_handoff";
const PENDING = CAA_PENDING_COLLECTION;
const HANDOFF = CAA_HANDOFF_COLLECTION;
const APP_CTX = { tenantId: CAA_APP_SCOPE } as const;

/** Per-shop client creds live in the tenant-scoped SecretsPort (per-shop client model — ADR-0018 spike). */
export const CAA_CLIENT_ID_NAME = "caa_client_id";
export const CAA_CLIENT_SECRET_NAME = "caa_client_secret";

interface PendingAuth {
  codeVerifier: string;
  nonce: string;
  tenant: string;
  shopDomain: string;
  createdAt: number;
}

export interface StartLoginDeps {
  store: RuntimeStatePort;
  fetchFn: typeof globalThis.fetch;
  clientIdFor: (tenant: string) => Promise<string | undefined>;
  /** True when this tenant/agent is halted — no new credential custody may begin during a kill (NN#4). */
  killCheck: (tenant: string) => Promise<boolean>;
  redirectUri: string;
  scope: string;
  now: () => number; // unix seconds
  pendingTtlSeconds?: number;
}

/**
 * Begin an OAuth login for a VERIFIED widget tenant + its shop. Returns the authorize URL to 302 to, or
 * null (⇒ the route 404s / no-ops) if the tenant has no CAA client, is killed, or discovery/store fails.
 * Persists the pending-auth record keyed by a fresh random `state`. Never throws (a store fault ⇒ null).
 */
export async function startCustomerLogin(deps: StartLoginDeps, args: { tenant: string; shopDomain: string }): Promise<{ authorizeUrl: string } | null> {
  try {
    if (await deps.killCheck(args.tenant)) return null; // halted ⇒ don't start a new credential flow
    const clientId = await deps.clientIdFor(args.tenant);
    if (!clientId) return null;
    const cfg = await discoverOidc(args.shopDomain, deps.fetchFn);
    if (!cfg) return null;
    const codeVerifier = generateCodeVerifier();
    const state = randomToken();
    const nonce = randomToken();
    const pending: PendingAuth = { codeVerifier, nonce, tenant: args.tenant, shopDomain: args.shopDomain, createdAt: deps.now() };
    await deps.store.put(APP_CTX, PENDING, state, pending, { ttlSeconds: deps.pendingTtlSeconds ?? 300 });
    return {
      authorizeUrl: buildAuthorizeUrl(cfg, { clientId, redirectUri: deps.redirectUri, scope: deps.scope, state, nonce, codeChallenge: deriveCodeChallenge(codeVerifier) }),
    };
  } catch {
    return null;
  }
}

export interface CallbackDeps {
  store: RuntimeStatePort;
  fetchFn: typeof globalThis.fetch;
  grants: CustomerGrantStore;
  clientIdFor: (tenant: string) => Promise<string | undefined>;
  clientSecretFor: (tenant: string) => Promise<string | undefined>;
  /** True when this tenant/agent is halted — refuse to accrue new credential custody during a kill (NN#4). */
  killCheck: (tenant: string) => Promise<boolean>;
  redirectUri: string;
  shopperTokenSecret: string;
  shopperTokenTtlSeconds: number;
  now: () => number;
  handoffTtlSeconds?: number;
  /** REQUIRED grant audit sink (ADR-0018 task 9, NN#5). Written BEFORE the grant is stored; if it throws,
   * the flow fails closed and NO grant is custodied (an unauditable credential must never persist). */
  audit: (e: { tenant: string; shopperId: string; scope?: string }) => Promise<void>;
}

export type CallbackResult =
  | { ok: true; handoffCode: string }
  | { ok: false; reason: "cancelled" | "error" };

/**
 * Complete the OAuth callback → a minted PalUp shopper session token, retrievable ONCE via `handoffCode`.
 * Fails closed (`{ok:false}`) on every error; the raw token is never returned in the redirect. Enforces:
 * error-branch first, single-use `state` (consumed before any network call), tenant↔issuer binding
 * (expectedIssuer derived from the pending record's OWN shop → a shop-A token can't mint under tenant B),
 * full id_token validation, and encrypted grant storage (no plaintext fallback).
 */
export async function completeCustomerCallback(deps: CallbackDeps, args: { code?: string; state?: string; error?: string }): Promise<CallbackResult> {
  // 1. OAuth error param FIRST — a declined consent is benign, not an error to surface.
  if (args.error) return { ok: false, reason: args.error === "access_denied" ? "cancelled" : "error" };
  if (typeof args.state !== "string" || !args.state || typeof args.code !== "string" || !args.code) return { ok: false, reason: "error" };
  const code = args.code;
  try {
    // 2. Single-use state: look up, then DELETE before any network call (replay-safe even on later failure).
    const pending = await deps.store.get<PendingAuth>(APP_CTX, PENDING, args.state);
    await deps.store.delete(APP_CTX, PENDING, args.state);
    if (!pending) return { ok: false, reason: "error" };
    const { tenant, shopDomain, codeVerifier, nonce } = pending;

    // 3. Kill-switch (NN#4): a halted tenant must not accrue a NEW durable credential.
    if (await deps.killCheck(tenant)) return { ok: false, reason: "error" };

    // 4. Re-discover THIS shop's OIDC — its issuer is the pin for id_token `iss` (tenant↔issuer binding).
    const cfg = await discoverOidc(shopDomain, deps.fetchFn);
    if (!cfg) return { ok: false, reason: "error" };
    const clientId = await deps.clientIdFor(tenant);
    if (!clientId) return { ok: false, reason: "error" };
    const clientSecret = await deps.clientSecretFor(tenant);

    // 5. Exchange the code against THIS shop's token endpoint (confidential client).
    const tokens = await exchangeCode(cfg, { code, codeVerifier, clientId, clientSecret, redirectUri: deps.redirectUri }, deps.fetchFn);
    if (!tokens) return { ok: false, reason: "error" };

    // 6. Validate the id_token (issuer pinned to THIS shop) → Principal for THIS tenant.
    const jwks = await fetchJwks(cfg.jwks_uri, deps.fetchFn);
    if (!jwks) return { ok: false, reason: "error" };
    const principal: Principal = verifyIdTokenToPrincipal(tokens.id_token, tenant, {
      jwks,
      expectedIssuer: cfg.issuer,
      expectedAudience: clientId,
      expectedNonce: nonce,
      nowSec: deps.now,
    });
    if (principal.kind !== "shopper") return { ok: false, reason: "error" };
    if (!(await deps.grants.ready())) return { ok: false, reason: "error" }; // no plaintext fallback

    // 7. AUDIT the grant BEFORE custodying it (NN#5). If the audit write throws, the outer catch fails the
    //    flow closed and NO grant is stored — an unauditable credential must never persist.
    const scope = (tokens as { scope?: string }).scope;
    await deps.audit({ tenant, shopperId: principal.shopperId, scope });

    // 8. Store the encrypted grant.
    await deps.grants.put(tenant, principal.shopperId, {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: typeof tokens.expires_in === "number" ? deps.now() + tokens.expires_in : undefined,
      scope,
      grantedAt: deps.now(),
    });

    // 9. Mint the PalUp session token; return it ONLY via a single-use handoff code (never in the redirect URL).
    const sessionToken = mintShopperToken(deps.shopperTokenSecret, principal.shopperId, "shopify", deps.shopperTokenTtlSeconds, deps.now());
    const handoffCode = randomToken();
    await deps.store.put(APP_CTX, HANDOFF, handoffCode, { token: sessionToken }, { ttlSeconds: deps.handoffTtlSeconds ?? 120 });
    return { ok: true, handoffCode };
  } catch {
    // Any store/audit/exchange fault ⇒ benign failure, no token minted or leaked (satisfies the never-throw
    // contract the route relies on to render the benign HTML instead of a 500).
    return { ok: false, reason: "error" };
  }
}

/** Redeem a handoff code for the minted session token, exactly once. */
export async function redeemHandoff(store: RuntimeStatePort, code: string): Promise<string | null> {
  if (!code) return null;
  const doc = await store.get<{ token?: string }>(APP_CTX, HANDOFF, code);
  await store.delete(APP_CTX, HANDOFF, code); // single-use
  return typeof doc?.token === "string" ? doc.token : null;
}
