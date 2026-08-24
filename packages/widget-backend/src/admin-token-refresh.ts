import type { AdminTokenStore } from "@palup/state-postgres";

// Task 5 (ADR-0022 F6) — a single-flight, audited refresh helper for the Shopify Admin offline token, built
// ABOVE Task 4's `AdminTokenStore` (`packages/state-postgres/src/admin-token-store.ts`), which explicitly
// leaves single-flight coordination to its caller (that file's header: "SINGLE-FLIGHT for concurrent
// refreshes is NOT this store's job… a caller that needs 'only one refresh in flight per tenant' builds
// that above this layer (Task 5)"). This module is that layer.
//
// THE TWO PROPERTIES THIS FILE EXISTS TO HOLD:
//   1. SINGLE-FLIGHT, per tenant. If a token needs refreshing and N callers ask concurrently, exactly ONE
//      `exchange` call happens; every caller (the one that started it and every one that piggy-backed) gets
//      the SAME resulting token. A per-tenant `Map<tenantId, Promise<string>>` is the whole mechanism: the
//      first caller for a tenant creates and registers the in-flight promise, every later concurrent caller
//      for that SAME tenant finds and awaits it instead of starting a second exchange, and the entry is
//      removed (via `.finally`) the moment it settles — success or failure — so the NEXT call (once nothing
//      is in flight) always re-checks the store rather than replaying a stale result forever.
//   2. FAIL CLOSED on `unreadable`. A `status: "unreadable"` read is a decryption/corruption failure, not
//      an ordinary expiry — treating it as "needs refresh" would silently paper over a broken credential by
//      minting a brand-new one on its behalf. This throws instead, matching every OTHER "unreadable" read in
//      this codebase (e.g. `MerchantCredentialRead`'s twin union) that refuses to be treated as `missing`.
//
// `exchange` and `shopDomainOf` are BOTH injected, not implemented here: this module knows nothing about
// HOW a fresh Admin token is obtained (a fresh OAuth authorization-code round trip, a Shopify token-rotation
// endpoint, or a test double) or how a tenantId maps to a shop domain (that is the merchant registry's
// concern, not this file's). Keeping both as narrow injected functions means this module has no Shopify
// wire-format knowledge and no port dependency beyond `AdminTokenStore` itself.
//
// NOT WIRED IN — composition (server.ts) is Task 13's job. This file only exists behind its own test seams.

/** What a successful token exchange/rotation yields. `expiresAt` is optional, mirroring `AdminTokenStore`'s
 *  own optional field (admin-token-store.ts) and `InstallGrant.expiresAt` (Task 5's other half, in
 *  shopify-install-identity.ts) — a non-expiring offline token legitimately has none. */
export interface AdminTokenExchangeResult {
  accessToken: string;
  expiresAt?: string;
}

export interface AdminTokenRefresherDeps {
  /** The Task-4 store. Only `read` and `refresh` are used — `put`/`delete` are none of this module's
   *  business, mirroring the least-privilege narrowing `ShopifyInstallDeps.adminTokens` already applies. */
  tokens: Pick<AdminTokenStore, "read" | "refresh">;
  /** Obtain a fresh Admin token for this tenant/shop. Caller-supplied — see the header note on why this
   *  module does not implement Shopify wire mechanics itself. */
  exchange: (tenantId: string, shopDomain: string) => Promise<AdminTokenExchangeResult>;
  /** Resolve a tenantId to the shop domain `exchange` needs. Caller-supplied for the same reason. */
  shopDomainOf: (tenantId: string) => Promise<string>;
  /** Injectable clock, epoch ms — the same knob the rest of this codebase's testable-time code takes
   *  (e.g. `ShopifyInstallDeps.now`). Defaults to `Date.now`. */
  now?: () => number;
  /**
   * How far ahead of an actual expiry to treat a token as "expiring soon" and refresh it proactively,
   * rather than waiting for it to go fully stale and fail a live request first. Five minutes by default —
   * generous enough to absorb one exchange round trip plus normal clock skew between this process and
   * Shopify's, without being so large that a token gets refreshed many multiples of its real remaining
   * life. Callers with a different risk tolerance can override it.
   */
  skewMs?: number;
}

const DEFAULT_SKEW_MS = 5 * 60_000;

/**
 * True when `expiresAt` is close enough to `nowMs` (within `skewMs`) — or already past — that the token
 * should be refreshed before being handed out. An ABSENT `expiresAt` (a non-expiring offline token, or any
 * token whose caller never supplied one) is never "expiring soon" — there is nothing to compare against, and
 * treating "no expiry recorded" as "refresh constantly" would defeat the entire point of caching. A
 * malformed/unparseable `expiresAt`, by contrast, fails CLOSED toward refreshing — the alternative (treating
 * an unparseable value as "far away, don't refresh") could hand out a token this module can no longer
 * reason about the freshness of at all.
 */
function expiringSoon(expiresAt: string | undefined, nowMs: number, skewMs: number): boolean {
  if (expiresAt === undefined) return false;
  const expMs = Date.parse(expiresAt);
  if (!Number.isFinite(expMs)) return true;
  return expMs - nowMs <= skewMs;
}

export interface AdminTokenRefresher {
  /**
   * Return a token for `tenantId` that is not (as far as this module can tell) about to expire, refreshing
   * it first if needed. Concurrent calls for the SAME tenant while a refresh is in flight all resolve to the
   * ONE refresh's result (single-flight, F6). Throws if the stored token is `unreadable` — never a hot-path
   * fallback to a stale or synthetic value.
   */
  getFreshAdminToken(tenantId: string): Promise<string>;
}

/**
 * Build the refresher. A fresh `inflight` map is created per call to `makeAdminTokenRefresher` — callers
 * that want single-flight coordination shared across multiple call sites must share the ONE returned
 * `getFreshAdminToken`, not construct the refresher twice.
 */
export function makeAdminTokenRefresher(deps: AdminTokenRefresherDeps): AdminTokenRefresher {
  const inflight = new Map<string, Promise<string>>();
  const now = deps.now ?? (() => Date.now());
  const skewMs = deps.skewMs ?? DEFAULT_SKEW_MS;

  async function getFreshAdminToken(tenantId: string): Promise<string> {
    const cur = await deps.tokens.read(tenantId);
    if (cur.status === "found" && !expiringSoon(cur.expiresAt, now(), skewMs)) return cur.token;
    if (cur.status === "unreadable") {
      throw new Error(
        `admin token unreadable for tenant "${tenantId}" (${cur.reason}) — reinstall required; refusing to ` +
          "treat a decryption/corruption failure as an ordinary expiry",
      );
    }

    let p = inflight.get(tenantId);
    if (!p) {
      p = (async () => {
        const shop = await deps.shopDomainOf(tenantId);
        const next = await deps.exchange(tenantId, shop);
        await deps.tokens.refresh(tenantId, next.accessToken, { actor: "system:admin-token-refresh", expiresAt: next.expiresAt });
        return next.accessToken;
      })().finally(() => inflight.delete(tenantId));
      inflight.set(tenantId, p);
    }
    return p;
  }

  return { getFreshAdminToken };
}
