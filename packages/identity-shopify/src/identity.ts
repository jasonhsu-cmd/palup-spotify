// The Shopify App Bridge identity adapter — the factory that satisfies MerchantIdentityPort and owns the
// first-hit exchange flow (ADR-0011 Dec 1, IAM §1/§9). The full chain, fail-closed at every step:
//   establishSession(shopifySessionToken):
//     1. verifyShopifySessionToken (sig/aud/exp/nbf/iss-dest)          — else refuse (no exchange)
//     2. jtiGuard.useOnce(jti)                                          — single-use exchange
//     3. exchangeSessionToken(online)                                  — proves identity, reads role
//     4. registry.lookupByShopDomain(dest-derived host)                — TENANT FROM VERIFIED CLAIMS,
//        (default fail-closed: suspended/uninstalled ⇒ null ⇒ refuse)    NEVER client input
//     5. mapShopifyRole(associated_user, override)                     — PalUp's 5-role RBAC
//     6. mintMerchantSession(...)                                      — the PalUp session
//   authenticate(credential): verifyMerchantSession — the subsequent-request path.
import {
  can, buildShopifyShopperId,
  type MerchantIdentityPort, type MerchantPrincipal, type MerchantAuthResult, type Permission,
  type SecretsPort, type MerchantRegistryPort,
} from "@palup/platform-ports";
import { verifyShopifySessionToken } from "./session-token.js";
import { exchangeSessionToken } from "./token-exchange.js";
import { mapShopifyRole, type RoleOverrideSource } from "./role-map.js";
import { mintMerchantSession, verifyMerchantSession } from "./palup-session.js";
import type { JtiReplayGuard } from "./jti-guard.js";

// App-wide config names — cross-ref widget-backend/src/shopify-install-identity.ts (re-declared, not
// imported, to keep this adapter free of a service dependency). The app client secret is APP-scoped:
// one secret signs every merchant's session token.
const SHOPIFY_APP_SECRET_SCOPE = "__shopify_app__";
const SHOPIFY_APP_CLIENT_SECRET_NAME = "shopify_app_client_secret";
const PALUP_SESSION_SECRET_NAME = "palup_merchant_session_secret";
const DEFAULT_SESSION_TTL = 1800;

export interface ShopifyIdentityDeps {
  clientId: string;
  secrets: SecretsPort;
  registry: MerchantRegistryPort;
  jtiGuard: JtiReplayGuard;
  roleOverrides?: RoleOverrideSource;
  fetchFn?: typeof fetch;
  sessionTtlSeconds?: number;
  nowSec?: () => number;
}
export type EstablishResult =
  | { ok: true; principal: MerchantPrincipal; palupSessionToken: string }
  | { ok: false; reason: string };

export function createShopifyAppBridgeIdentity(
  deps: ShopifyIdentityDeps,
): MerchantIdentityPort & { establishSession(shopifySessionToken: string | undefined): Promise<EstablishResult> } {
  const now = deps.nowSec ?? (() => Math.floor(Date.now() / 1000));
  const fetchFn = deps.fetchFn ?? fetch;
  const ttl = deps.sessionTtlSeconds ?? DEFAULT_SESSION_TTL;
  const appSecret = () => deps.secrets.get(SHOPIFY_APP_SECRET_SCOPE, SHOPIFY_APP_CLIENT_SECRET_NAME);
  const sessionSecret = () => deps.secrets.get(SHOPIFY_APP_SECRET_SCOPE, PALUP_SESSION_SECRET_NAME);

  return {
    async authenticate(credential): Promise<MerchantAuthResult> {
      return verifyMerchantSession(await sessionSecret(), credential, now());
    },
    authorize(principal, permission: Permission): boolean {
      return can(principal, permission); // default-deny PDP (anonymous ⇒ false)
    },
    async establishSession(shopifySessionToken): Promise<EstablishResult> {
      const clientSecret = await appSecret();
      const v = verifyShopifySessionToken({ token: shopifySessionToken, clientSecret, clientId: deps.clientId, nowSec: now() });
      if (!v.ok) return { ok: false, reason: v.reason };
      // single-use exchange (ADR-0011): a captured, still-valid token cannot be exchanged twice
      if (!(await deps.jtiGuard.useOnce(v.claims.jti, v.claims.exp))) return { ok: false, reason: "session token already exchanged" };
      const exchanged = await exchangeSessionToken(
        { shopDomain: v.shopDomain, clientId: deps.clientId, clientSecret: clientSecret!, sessionToken: shopifySessionToken!, tokenType: "online" },
        fetchFn,
      );
      if (!exchanged) return { ok: false, reason: "token exchange failed" };
      // TENANT FROM VERIFIED CLAIMS: resolve the PalUp tenant from the dest-derived shop host (default
      // fail-closed lookup ⇒ suspended/uninstalled merchant resolves to null ⇒ refuse). Never a header.
      const merchant = await deps.registry.lookupByShopDomain(v.shopDomain);
      if (!merchant) return { ok: false, reason: "merchant not active for shop" };
      const userId = buildShopifyShopperId(merchant.tenantId, v.claims.sub) ?? `shopify:${merchant.tenantId}:${v.claims.sub}`;
      const override = deps.roleOverrides ? await deps.roleOverrides.lookup(merchant.tenantId, userId) : undefined;
      const role = mapShopifyRole({ associatedUser: exchanged.associatedUser, override });
      const secret = await sessionSecret();
      if (!secret) return { ok: false, reason: "session secret not configured (fail-closed)" };
      const principal: MerchantPrincipal = {
        kind: "merchant_user", merchantId: merchant.tenantId, userId, role,
        authLevel: "session", sessionId: v.claims.sid,
      };
      const palupSessionToken = mintMerchantSession(
        secret, { merchantId: principal.merchantId, userId, role, authLevel: "session", sid: v.claims.sid }, ttl, now(),
      );
      return { ok: true, principal, palupSessionToken };
    },
  };
}
