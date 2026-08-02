import type { CustomerGrantStore, StoredGrant } from "./customer-grant-store.js";
import { discoverOidc, exchangeRefreshToken } from "./shopify-customer-account-identity.js";

// ADR-0018 task 7 — server-side token refresh + logout. A DECORATOR over the CustomerGrantStore: `get()`
// transparently refreshes a near-expiry grant using its refresh_token, so the commerce read adapter
// (task 8) calls `grants.get()` UNCHANGED and receives a live access token — the refresh logic lives here,
// not in the adapter. Key invariants:
//   • The ORIGINAL `grantedAt` is preserved across refreshes, so the capped session lifetime is measured
//     from the initial authorization — refresh can NEVER extend a session indefinitely.
//   • A failed / absent refresh returns the STALE grant, so the adapter's own expiry check reauths (fail
//     closed, never a silent stale-token read).
//   • put / delete / ready pass through unchanged.

const DAY = 86_400;

export interface RefreshDeps {
  shopDomainForTenant: (tenant: string) => string | undefined;
  clientIdFor: (tenant: string) => Promise<string | undefined>;
  clientSecretFor: (tenant: string) => Promise<string | undefined>;
  fetchFn?: typeof globalThis.fetch;
  now?: () => number;
  /** Refresh when the access token expires within this many seconds (default 120). */
  refreshSkewSeconds?: number;
  /** Capped session lifetime measured from the ORIGINAL grant (default 30d) — beyond it, reauth. */
  maxGrantAgeSeconds?: number;
}

export function createRefreshingGrantStore(inner: CustomerGrantStore, deps: RefreshDeps): CustomerGrantStore {
  const fetchFn = deps.fetchFn ?? globalThis.fetch;
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const skew = deps.refreshSkewSeconds ?? 120;
  const maxAge = deps.maxGrantAgeSeconds ?? 30 * DAY;

  async function refresh(tenant: string, shopperId: string, grant: StoredGrant): Promise<StoredGrant | null> {
    if (!grant.refreshToken) return null;
    const shopDomain = deps.shopDomainForTenant(tenant);
    if (!shopDomain) return null;
    const cfg = await discoverOidc(shopDomain, fetchFn);
    if (!cfg) return null;
    const clientId = await deps.clientIdFor(tenant);
    if (!clientId) return null;
    const clientSecret = await deps.clientSecretFor(tenant);
    const t = await exchangeRefreshToken(cfg, { refreshToken: grant.refreshToken, clientId, clientSecret }, fetchFn);
    if (!t) return null;
    // NB: a refresh is RENEWAL of the already-audited grant (unchanged authorization/scope), not a new
    // grant or a revocation, so it is intentionally not per-event audited here (it would be high-frequency,
    // low-signal, and this path is dead until task 8 wires it). Whether the go-live wiring wants a
    // refresh counter / telemetry is decided there — the audited lifecycle events are grant + revoke.
    const refreshed: StoredGrant = {
      accessToken: t.access_token,
      refreshToken: t.refresh_token ?? grant.refreshToken, // Shopify may rotate; keep the old if not returned
      expiresAt: typeof t.expires_in === "number" ? now() + t.expires_in : undefined,
      scope: t.scope ?? grant.scope,
      grantedAt: grant.grantedAt, // PRESERVE — capped lifetime is from the ORIGINAL authorization
    };
    await inner.put(tenant, shopperId, refreshed);
    return refreshed;
  }

  return {
    ready: () => inner.ready(),
    put: (t, s, g) => inner.put(t, s, g),
    delete: (t, s) => inner.delete(t, s),
    async get(tenant, shopperId) {
      const grant = await inner.get(tenant, shopperId);
      if (!grant) return null;
      if (now() - grant.grantedAt > maxAge) return null; // capped session lifetime ⇒ reauth (refresh can't extend it)
      if (grant.expiresAt === undefined || grant.expiresAt - now() > skew) return grant; // still fresh
      const refreshed = await refresh(tenant, shopperId, grant);
      return refreshed ?? grant; // refresh failed ⇒ stale grant ⇒ adapter's expiry check reauths
    },
  };
}

/**
 * Logout / kill / incident: DELETE the local grant FIRST — the meaningful, immediate, authoritative server
 * action (PalUp can no longer use the credential). There is NO Shopify token-revocation endpoint
 * (ADR-0018 spike: only an `end_session` BROWSER flow, which the widget drives — task 10), so nothing
 * further can be revoked server-side. Then AUDIT the revocation (NN#5 — it's the execution of the
 * `oauth_granted` reversalPath, so it must be on the immutable log). DELETE-FIRST ordering (opposite of
 * the create path): the credential is already gone, so a failed audit must NOT strand a live credential —
 * but the revocation still can't be silently dropped, so a failure is logged as a witness outside the DB.
 * The audit sink is a required param so every caller (route + incident sweep) records the revocation.
 */
export async function logoutGrant(grants: CustomerGrantStore, tenant: string, shopperId: string, audit: () => Promise<void>): Promise<void> {
  await grants.delete(tenant, shopperId);
  try {
    await audit();
  } catch {
    console.warn("[caa] oauth_revoked audit write failed — grant WAS deleted; revocation not persisted to the audit chain");
  }
}
