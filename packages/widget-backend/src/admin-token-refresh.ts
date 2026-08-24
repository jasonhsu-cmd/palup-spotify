import type { AdminTokenStore, AdminTokenWrite } from "@palup/state-postgres";

// Task 5 (ADR-0022 F6) — a single-flight, audited refresh helper for the Shopify Admin offline token, built
// ABOVE Task 4's `AdminTokenStore` (`packages/state-postgres/src/admin-token-store.ts`), which explicitly
// leaves single-flight coordination to its caller (that file's header: "SINGLE-FLIGHT for concurrent
// refreshes is NOT this store's job… a caller that needs 'only one refresh in flight per tenant' builds
// that above this layer (Task 5)"). This module is that layer.
//
// Task 6 (ADR-0023) — the verified Shopify mechanics (spec §10.1): the public-app offline Admin token is
// EXPIRING (`expires_in=3600`) and comes with a `refresh_token` (`refresh_token_expires_in`=90d). A refresh
// is performed SERVER-SIDE via the stored `refresh_token` — no user involved — and each refresh mints a
// FRESH token+refresh_token pair while Shopify RETIRES the prior ones. So this module now (a) passes the
// stored `refreshToken` into `exchange` (it is the credential the refresh grant needs), and (b) fails closed
// — never a hot-path fetch — when there is no usable refresh_token to refresh with (F-H): absent (a
// pre-schema/legacy custodied row, e.g. `palup-skincare-jason`) or lapsed (past its own 90d expiry).
//
// THE PROPERTIES THIS FILE EXISTS TO HOLD:
//   1. SINGLE-FLIGHT, per tenant. If a token needs refreshing and N callers ask concurrently, exactly ONE
//      `exchange` call happens; every caller (the one that started it and every one that piggy-backed) gets
//      the SAME resulting token. A per-tenant `Map<tenantId, Promise<string>>` is the whole mechanism: the
//      first caller for a tenant creates and registers the in-flight promise, every later concurrent caller
//      for that SAME tenant finds and awaits it instead of starting a second exchange, and the entry is
//      removed (via `.finally`) the moment it settles — success or failure — so the NEXT call (once nothing
//      is in flight) always re-checks the store rather than replaying a stale result forever. THIS IS ALSO A
//      CORRECTNESS GUARD, not only a cost one (F-B): Shopify retires the prior refresh_token on every
//      refresh, so two concurrent, uncoordinated refreshes for the same tenant would race to consume it —
//      the loser would mint against an already-retired refresh_token and strand the tenant needing re-auth.
//   2. FAIL CLOSED on `unreadable`. A `status: "unreadable"` read is a decryption/corruption failure, not
//      an ordinary expiry — treating it as "needs refresh" would silently paper over a broken credential by
//      minting a brand-new one on its behalf. This is ALSO treated as re-auth-required (F-H, Task 6): it
//      throws the same `AdminTokenReauthRequiredError` as a missing/lapsed refresh_token, so a caller (a sync
//      job) can catch ONE error type and halt that tenant's sync, rather than crashing the whole loop on an
//      ordinary `Error` — matching every OTHER "unreadable" read in this codebase (e.g. `MerchantCredentialRead`'s
//      twin union) that refuses to be treated as `missing`.
//   3. FAIL CLOSED on a missing/lapsed refresh_token, or an unreadable stored token (F-H, Task 6).
//      `AdminTokenReauthRequiredError` is a DISTINCT, exported error type so a caller (a sync job, Task 7/9)
//      can catch it specifically and halt that tenant's sync with a clear signal, rather than crashing the
//      whole loop on an ordinary `Error`.
//
// `exchange` and `shopDomainOf` are BOTH injected, not implemented here: this module knows nothing about
// HOW a fresh Admin token is obtained (the exact refresh_token-grant HTTP request/response shape, or a test
// double) or how a tenantId maps to a shop domain (that is the merchant registry's concern, not this
// file's). Keeping both as narrow injected functions means this module has no Shopify wire-format knowledge
// and no port dependency beyond `AdminTokenStore` itself.
//
// NOT WIRED IN — composition (server.ts) is Task 7/9's job. This file only exists behind its own test seams.

/** What a successful token exchange/refresh yields. `expiresAt` is optional, mirroring `AdminTokenStore`'s
 *  own optional field (admin-token-store.ts) — a non-expiring offline token legitimately has none, though
 *  under the verified §10.1 mechanics the PUBLIC-APP offline token always has one. `refreshToken`/
 *  `refreshTokenExpiresAt` are likewise optional on the TYPE (so a caller/test that only cares about the
 *  access token can omit them), but a real refresh_token-grant response always returns a fresh pair
 *  (Shopify mints and retires on every refresh) — an `exchange` that returns neither is trusted verbatim by
 *  this module, which stores exactly what it is given (F-B: no fabrication, no carrying the old value
 *  forward under a new call). */
export interface AdminTokenExchangeResult {
  accessToken: string;
  expiresAt?: string;
  refreshToken?: string;
  refreshTokenExpiresAt?: string;
}

/**
 * Task 6 (ADR-0023, F-H) — thrown instead of ever attempting an `exchange` when this tenant's admin token
 * cannot be refreshed without a human re-authorizing the app: no refresh_token was ever custodied (a
 * pre-schema/legacy row), the custodied refresh_token has lapsed (past its own 90d expiry), the stored row is
 * missing entirely, or the stored row is unreadable (a decryption/corruption failure — not an ordinary
 * expiry, but still something only a reinstall/reauth fixes). A caller (a sync job) MUST catch this
 * specifically and halt that tenant's sync — never crash the whole loop, and never fall back to a stale or
 * synthetic token on the hot path.
 */
export class AdminTokenReauthRequiredError extends Error {
  constructor(
    public readonly tenantId: string,
    reason: string,
  ) {
    super(`admin token re-auth required for tenant "${tenantId}": ${reason}`);
    this.name = "AdminTokenReauthRequiredError";
  }
}

export interface AdminTokenRefresherDeps {
  /** The Task-4 store. Only `read` and `refresh` are used — `put`/`delete` are none of this module's
   *  business, mirroring the least-privilege narrowing `ShopifyInstallDeps.adminTokens` already applies. */
  tokens: Pick<AdminTokenStore, "read" | "refresh">;
  /**
   * Obtain a fresh Admin token for this tenant/shop by performing the Shopify refresh_token grant
   * (spec §10.1) with the CALLER-SUPPLIED `refreshToken` — the one already custodied for this tenant. This
   * module never invents or reuses a refresh_token of its own; it only ever passes through what `read`
   * returned. Caller-supplied — see the header note on why this module does not implement Shopify wire
   * mechanics itself.
   */
  exchange: (tenantId: string, shopDomain: string, refreshToken: string) => Promise<AdminTokenExchangeResult>;
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

/**
 * Task 6 (F-H) — true when the custodied `refresh_token`'s own (90d) expiry has already passed. Mirrors
 * `expiringSoon`'s posture on the edge cases, for the same reasons: ABSENT means "no expiry recorded",
 * which is never treated as lapsed here (the separate "no refresh_token at all" case is checked by the
 * caller against `refreshToken` itself, not this function) — and a malformed/unparseable value fails CLOSED
 * (treated as lapsed), never open. Unlike `expiringSoon` there is no skew window: this is a hard 90-day
 * boundary Shopify enforces server-side, not a proactive-refresh heuristic this module owns.
 */
function refreshTokenLapsed(refreshTokenExpiresAt: string | undefined, nowMs: number): boolean {
  if (refreshTokenExpiresAt === undefined) return false;
  const expMs = Date.parse(refreshTokenExpiresAt);
  if (!Number.isFinite(expMs)) return true;
  return expMs <= nowMs;
}

export interface AdminTokenRefresher {
  /**
   * Return a token for `tenantId` that is not (as far as this module can tell) about to expire, refreshing
   * it first if needed. Concurrent calls for the SAME tenant while a refresh is in flight all resolve to the
   * ONE refresh's result (single-flight, F6). Throws `AdminTokenReauthRequiredError` if the stored token is
   * `unreadable`, missing, or has no live refresh_token (F-H) — never a hot-path fallback to a stale or
   * synthetic value.
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
      throw new AdminTokenReauthRequiredError(
        tenantId,
        `admin token unreadable (${cur.reason}) — reinstall required; refusing to treat a decryption/corruption ` +
          "failure as an ordinary expiry",
      );
    }
    // Task 6 (F-H) — everything past this point NEEDS a refresh (either the row is missing entirely, or the
    // access token is expiring/expired). A refresh can only proceed with a live, custodied refresh_token —
    // fail closed with a distinguishable re-auth error otherwise, BEFORE any exchange/network attempt.
    if (cur.status === "missing") {
      throw new AdminTokenReauthRequiredError(tenantId, "no admin token custodied — install/reauth required");
    }
    if (!cur.refreshToken) {
      throw new AdminTokenReauthRequiredError(
        tenantId,
        "no refresh_token custodied for this row (pre-schema/legacy custody) — reinstall required",
      );
    }
    if (refreshTokenLapsed(cur.refreshTokenExpiresAt, now())) {
      throw new AdminTokenReauthRequiredError(tenantId, "refresh_token has lapsed (past its 90-day expiry) — reinstall required");
    }
    const refreshToken = cur.refreshToken;

    let p = inflight.get(tenantId);
    if (!p) {
      p = (async () => {
        const shop = await deps.shopDomainOf(tenantId);
        // Refresh via the STORED refresh_token (spec §10.1) — never invented, never reused across tenants.
        const next = await deps.exchange(tenantId, shop, refreshToken);
        const write: AdminTokenWrite = {
          token: next.accessToken,
          expiresAt: next.expiresAt,
          refreshToken: next.refreshToken,
          refreshTokenExpiresAt: next.refreshTokenExpiresAt,
        };
        // F-B: ONE audited, atomic replace of BOTH the access token and the refresh_token — Shopify retires
        // the prior pair on every refresh, so this store call must never retain either old value (and
        // `AdminTokenStore.refresh` builds a fresh row rather than merging, so it does not).
        await deps.tokens.refresh(tenantId, write, { actor: "system:admin-token-refresh" });
        return next.accessToken;
      })().finally(() => inflight.delete(tenantId));
      inflight.set(tenantId, p);
    }
    return p;
  }

  return { getFreshAdminToken };
}
