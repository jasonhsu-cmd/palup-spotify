import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mintMerchantSession } from "@palup/identity-shopify";
import { buildServer } from "../src/server.js";

// Task 4: the DEFAULT (no-opts) composition root. `store`/`identity` stay injectable for every other
// suite (auth.test.ts, rbac.test.ts, route-protection.test.ts all inject fakes so they never need a
// real DATABASE_URL/Shopify secret) — this file is the ONLY one that exercises the real path:
// `buildServer()` with NO opts must fall through to `createRuntimeStore()` (@palup/state-postgres) +
// `createShopifyAppBridgeIdentity({...})` (@palup/identity-shopify) reading the Shopify app secret via
// the secrets port (never env-inline literal).
//
// Kept deterministic and DB/network-free: with no DATABASE_URL set, `createRuntimeStore()` resolves to
// the in-memory adapter (its own documented mock-path fallback) — never a real Postgres connection —
// and with no PALUP_SECRETS/SHOPIFY_APP_CLIENT_ID set, the real Shopify identity adapter still
// constructs (it reads secrets lazily, not at construction) and fails closed to 401 for good measure.
const ENV_KEYS = ["DATABASE_URL", "PALUP_SECRETS", "SHOPIFY_APP_CLIENT_ID", "PALUP_REQUIRE_DATABASE_URL"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("buildServer() composition root (no opts)", () => {
  it("constructs without throwing on the mock path and /health works", async () => {
    const app = await buildServer();
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("still fail-closes /me with no bearer token — the real identity adapter, not a bypass", async () => {
    const app = await buildServer();
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/me" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("wires the real Shopify identity end-to-end: a session minted against the secrets-port-backed app secret authenticates", async () => {
    // Simulates the Shopify app secret arriving via the secrets port's env-JSON adapter (createEnvSecrets)
    // rather than a hardcoded/env-inline literal — this is the SAME PALUP_SECRETS convention widget-backend
    // already uses (server.ts:416) for the identical secret name.
    const sessionSecret = "test-session-secret";
    process.env.PALUP_SECRETS = JSON.stringify({
      __shopify_app__: { palup_merchant_session_secret: sessionSecret },
    });
    process.env.SHOPIFY_APP_CLIENT_ID = "test-client-id";

    const app = await buildServer();
    await app.ready();

    const token = mintMerchantSession(
      sessionSecret,
      { merchantId: "t1", userId: "shopify:t1:u1", role: "owner", authLevel: "session", sid: "s1" },
      1800,
    );
    const res = await app.inject({ method: "GET", url: "/me", headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ merchantId: "t1", role: "owner" });
    await app.close();
  });
});
