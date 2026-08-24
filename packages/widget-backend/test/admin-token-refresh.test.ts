import { describe, it, expect, vi } from "vitest";
import type { AdminTokenStore, AdminTokenRead } from "@palup/state-postgres";
import { makeAdminTokenRefresher } from "../src/admin-token-refresh.js";

// Task 5 (ADR-0022 F6) — a single-flight, audited Admin-token refresh helper layered ABOVE Task 4's
// AdminTokenStore (which explicitly leaves single-flight to the caller — admin-token-store.ts header).
// The two properties this file exists to hold:
//   1. SINGLE-FLIGHT: N concurrent callers for the SAME tenant, while a refresh is needed, trigger exactly
//      ONE `exchange` call — never N.
//   2. FAIL CLOSED: an `unreadable` token THROWS. It is never silently treated as "needs refresh" (which
//      would paper over a decryption/corruption failure as an ordinary expiry) and never falls back to
//      anything on the hot path.

function fakeStore(overrides: Partial<AdminTokenStore> = {}): AdminTokenStore & { refreshCalls: Array<{ tenantId: string; token: string; opts: unknown }> } {
  const refreshCalls: Array<{ tenantId: string; token: string; opts: unknown }> = [];
  return {
    refreshCalls,
    put: vi.fn(async () => {}),
    read: vi.fn(async () => ({ status: "missing" }) as AdminTokenRead),
    refresh: vi.fn(async (tenantId: string, token: string, opts: unknown) => {
      refreshCalls.push({ tenantId, token, opts });
    }),
    delete: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("Task 5 — makeAdminTokenRefresher (F6 single-flight + audited refresh)", () => {
  it("a fresh (not-expiring-soon) token is returned directly, with NO exchange call", async () => {
    const tokens = fakeStore({
      read: vi.fn(async () => ({ status: "found", token: "fresh-token", expiresAt: new Date(Date.now() + 3_600_000).toISOString() }) as AdminTokenRead),
    });
    const exchange = vi.fn(async () => ({ accessToken: "new-token" }));
    const { getFreshAdminToken } = makeAdminTokenRefresher({ tokens, exchange, shopDomainOf: async () => "acme-store.myshopify.com" });

    const result = await getFreshAdminToken("acme-store");
    expect(result).toBe("fresh-token");
    expect(exchange).not.toHaveBeenCalled();
    expect(tokens.refresh).not.toHaveBeenCalled();
  });

  it("a token with no expiresAt (non-expiring offline token) is returned directly", async () => {
    const tokens = fakeStore({ read: vi.fn(async () => ({ status: "found", token: "non-expiring" }) as AdminTokenRead) });
    const exchange = vi.fn(async () => ({ accessToken: "new-token" }));
    const { getFreshAdminToken } = makeAdminTokenRefresher({ tokens, exchange, shopDomainOf: async () => "acme-store.myshopify.com" });
    expect(await getFreshAdminToken("acme-store")).toBe("non-expiring");
    expect(exchange).not.toHaveBeenCalled();
  });

  it("an EXPIRING-SOON token triggers exactly ONE exchange for TWO concurrent callers (single-flight)", async () => {
    const tokens = fakeStore({
      read: vi.fn(async () => ({ status: "found", token: "stale-token", expiresAt: new Date(Date.now() - 1000).toISOString() }) as AdminTokenRead),
    });
    let resolveExchange!: (v: { accessToken: string; expiresAt?: string }) => void;
    const exchange = vi.fn(
      () =>
        new Promise<{ accessToken: string; expiresAt?: string }>((resolve) => {
          resolveExchange = resolve;
        }),
    );
    const shopDomainOf = vi.fn(async () => "acme-store.myshopify.com");
    const { getFreshAdminToken } = makeAdminTokenRefresher({ tokens, exchange, shopDomainOf });

    const p1 = getFreshAdminToken("acme-store");
    const p2 = getFreshAdminToken("acme-store");
    // Let both callers reach the in-flight check before the exchange resolves.
    await Promise.resolve();
    await Promise.resolve();
    expect(exchange).toHaveBeenCalledTimes(1);
    resolveExchange({ accessToken: "refreshed-token", expiresAt: "2027-01-01T00:00:00.000Z" });

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe("refreshed-token");
    expect(r2).toBe("refreshed-token");
    expect(exchange).toHaveBeenCalledTimes(1);
    expect(tokens.refresh).toHaveBeenCalledTimes(1);
    expect(tokens.refresh).toHaveBeenCalledWith(
      "acme-store",
      "refreshed-token",
      expect.objectContaining({ actor: "system:admin-token-refresh", expiresAt: "2027-01-01T00:00:00.000Z" }),
    );
  });

  it("a SUBSEQUENT call after the in-flight refresh settles triggers a NEW exchange, not a stale cached one", async () => {
    let call = 0;
    const tokens = fakeStore({
      read: vi.fn(async () => ({ status: "found", token: "stale-token", expiresAt: new Date(Date.now() - 1000).toISOString() }) as AdminTokenRead),
    });
    const exchange = vi.fn(async () => {
      call += 1;
      return { accessToken: `refreshed-${call}` };
    });
    const { getFreshAdminToken } = makeAdminTokenRefresher({ tokens, exchange, shopDomainOf: async () => "acme-store.myshopify.com" });

    expect(await getFreshAdminToken("acme-store")).toBe("refreshed-1");
    expect(await getFreshAdminToken("acme-store")).toBe("refreshed-2");
    expect(exchange).toHaveBeenCalledTimes(2);
  });

  it("DIFFERENT tenants refresh independently — one tenant's in-flight refresh never blocks or merges with another's", async () => {
    const tokens = fakeStore({
      read: vi.fn(async () => ({ status: "found", token: "stale-token", expiresAt: new Date(Date.now() - 1000).toISOString() }) as AdminTokenRead),
    });
    const exchange = vi.fn(async (tenantId: string) => ({ accessToken: `token-for-${tenantId}` }));
    const { getFreshAdminToken } = makeAdminTokenRefresher({ tokens, exchange, shopDomainOf: async (t: string) => `${t}.myshopify.com` });

    const [a, b] = await Promise.all([getFreshAdminToken("acme-store"), getFreshAdminToken("beta-store")]);
    expect(a).toBe("token-for-acme-store");
    expect(b).toBe("token-for-beta-store");
    expect(exchange).toHaveBeenCalledTimes(2);
  });

  it("an UNREADABLE token THROWS — never a hot-path fallback, and never calls exchange", async () => {
    const tokens = fakeStore({ read: vi.fn(async () => ({ status: "unreadable", reason: "undecryptable" }) as AdminTokenRead) });
    const exchange = vi.fn(async () => ({ accessToken: "should-not-be-called" }));
    const { getFreshAdminToken } = makeAdminTokenRefresher({ tokens, exchange, shopDomainOf: async () => "acme-store.myshopify.com" });

    await expect(getFreshAdminToken("acme-store")).rejects.toThrow(/unreadable/i);
    expect(exchange).not.toHaveBeenCalled();
    expect(tokens.refresh).not.toHaveBeenCalled();
  });

  it("respects an injected clock + skew window for the expiring-soon boundary", async () => {
    const fixedNow = Date.parse("2026-01-01T00:00:00.000Z");
    const tokens = fakeStore({
      read: vi.fn(async () => ({ status: "found", token: "boundary-token", expiresAt: "2026-01-01T00:04:00.000Z" }) as AdminTokenRead), // 4 min out
    });
    const exchange = vi.fn(async () => ({ accessToken: "refreshed" }));
    // 5-minute skew ⇒ a token expiring in 4 minutes counts as expiring soon ⇒ refresh triggers.
    const { getFreshAdminToken } = makeAdminTokenRefresher({
      tokens,
      exchange,
      shopDomainOf: async () => "acme-store.myshopify.com",
      now: () => fixedNow,
      skewMs: 5 * 60_000,
    });
    expect(await getFreshAdminToken("acme-store")).toBe("refreshed");
    expect(exchange).toHaveBeenCalledTimes(1);
  });
});
