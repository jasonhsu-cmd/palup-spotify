import { describe, it, expect, beforeAll } from "vitest";
import { InMemoryRuntimeStore, type MerchantIdentityPort, type MerchantPrincipal } from "@palup/platform-ports";
import { buildServer } from "../src/server.js";
import { ensureConsoleBuilt } from "./helpers/ensure-console-built.js";

// STRUCTURAL guard, not a behavioral one: this exists so that a FUTURE route registered directly on
// `app` (outside the `merchantPlane` encapsulated context in server.ts) — e.g. a webhook handler
// copying the /health pattern, or a W1-API route landing in the wrong block — fails THIS test, not
// silently ships unprotected. It enumerates every route Fastify actually registered (via `onRoute`,
// exposed as `app.registeredRoutes`) rather than a hand-maintained list of expected routes, so it can't
// go stale by omission the way a fixed route list could.
//
// The identity fake below CAN authenticate a valid bearer ("good") — deliberately not a no-op
// always-deny identity — so a 401 in this test proves the absent-token path is refused, not that
// authentication is unconditionally broken.
const owner: MerchantPrincipal = { kind: "merchant_user", merchantId: "t1", userId: "u1", role: "owner", authLevel: "session", sessionId: "s1" };
const identity: MerchantIdentityPort = {
  authenticate: async (cred) => (cred === "good" ? owner : { kind: "anonymous" }),
  authorize: () => true,
};

beforeAll(() => {
  ensureConsoleBuilt();
}, 120_000);

// Public-by-design app-shell routes: the merchant-console SPA. No merchant/customer DATA lives here —
// see server.ts's "Merchant-console SPA" block — so it's correct for these to be unauthenticated.
const AUTH_EXEMPT_PATHS = ["/health", "/", "/index.html"];

// Static-asset wildcard route(s) registered by `@fastify/static` for the SPA's hashed `assets/*.js|css`
// chunks. This loop proves every route by literally `inject`ing its own registered URL PATTERN string
// (e.g. `/approvals/:id` is requested as the literal string `/approvals/:id`, which find-my-way still
// matches — the `:id` segment just captures the literal text ":id"). That trick doesn't work for a
// trailing `*` wildcard the same way: requesting the literal string `/assets/*` matches the route (the
// `*` segment captures the literal text "*"), but the underlying file-server then 404s on a file that
// doesn't exist, which is not a meaningful public/gated signal either way. So wildcard routes are
// EXPLICITLY enumerated here and skipped by this loop's binary 200-or-401 check — they're proven
// public by `console-serve.test.ts`'s dedicated request against a REAL asset path instead. Explicit
// (not "any URL containing *") so a brand-new wildcard route must be added here on purpose or the
// assertion below fails loudly instead of silently skipping it.
const PUBLIC_WILDCARD_ROUTES = ["/assets/*"];

// Every DATA route this service serves as of this test (excludes params-only path segments like
// `/approvals/:id`, which the generic loop below already exercises structurally) — named explicitly so
// a future mistake that adds one of these to AUTH_EXEMPT_PATHS (making a real data route public) fails
// THIS list, not just the generic loop, which would otherwise pass vacuously once the route is (wrongly)
// exempted.
// `/approvals/:id`-shaped routes need a CONCRETE id (not the literal ":id" pattern) so `app.inject`
// actually routes to the real handler and gets the 401 from `requireMerchant`'s preHandler — not a
// 404 from some other mismatch. The exact id value doesn't matter: `requireMerchant` runs and rejects
// before any handler ever looks it up.
const KNOWN_DATA_ROUTES: { method: string; url: string }[] = [
  { method: "GET", url: "/approvals" },
  { method: "GET", url: "/approvals/p1" },
  { method: "POST", url: "/approvals/p1/approve" },
  { method: "POST", url: "/approvals/p1/reject" },
  { method: "GET", url: "/rules" },
  { method: "GET", url: "/home/summary" },
  { method: "PUT", url: "/home/goal" },
  { method: "GET", url: "/kill" },
  { method: "POST", url: "/unkill" },
  { method: "GET", url: "/audit" },
  { method: "GET", url: "/activity" },
  { method: "GET", url: "/events" },
  { method: "GET", url: "/me" },
  { method: "GET", url: "/_probe/money" },
  { method: "POST", url: "/_internal/run-winback" },
  { method: "POST", url: "/_internal/run-insights" },
  { method: "GET", url: "/learned" },
  { method: "POST", url: "/learned" },
  { method: "POST", url: "/learned/l1/pin" },
  { method: "DELETE", url: "/learned/l1" },
  { method: "GET", url: "/learned/export" },
];

describe("every registered route is protected by construction", () => {
  it("401s every route except the explicit public-SPA exemptions when no token is presented", async () => {
    const app = await buildServer({ store: new InMemoryRuntimeStore(), identity });
    await app.ready();

    expect(app.registeredRoutes.length).toBeGreaterThan(0);
    // Sanity: this suite must actually be exercising more than just /health, or the loop below would
    // pass vacuously as new routes land without ever having been added to this test.
    expect(app.registeredRoutes.some((r) => r.url !== "/health")).toBe(true);

    // A NEW wildcard route must be deliberately added to PUBLIC_WILDCARD_ROUTES (and proven public
    // elsewhere) — it can't just be silently skipped by accident.
    const uncoveredWildcards = app.registeredRoutes.filter(
      (r) => r.url.includes("*") && !PUBLIC_WILDCARD_ROUTES.includes(r.url),
    );
    expect(uncoveredWildcards, "a new wildcard route must be added to PUBLIC_WILDCARD_ROUTES and proven public").toEqual([]);

    for (const route of app.registeredRoutes) {
      if (PUBLIC_WILDCARD_ROUTES.includes(route.url)) continue;
      const res = await app.inject({ method: route.method, url: route.url });
      if (AUTH_EXEMPT_PATHS.includes(route.url)) {
        expect(res.statusCode, `${route.method} ${route.url} (exempt) should be 200`).toBe(200);
      } else {
        expect(res.statusCode, `${route.method} ${route.url} should be 401 with no token — got ${res.statusCode}`).toBe(401);
      }
    }

    await app.close();
  });

  it("no known DATA route is ever in the public-SPA exemption list", () => {
    for (const { url } of KNOWN_DATA_ROUTES) {
      expect(AUTH_EXEMPT_PATHS, `${url} must never be exempt from auth`).not.toContain(url);
    }
  });

  it("every known DATA route 401s without a token", async () => {
    const app = await buildServer({ store: new InMemoryRuntimeStore(), identity });
    await app.ready();

    for (const { method, url } of KNOWN_DATA_ROUTES) {
      const res = await app.inject({ method, url });
      expect(res.statusCode, `${method} ${url} should be 401 with no token — got ${res.statusCode}`).toBe(401);
    }

    await app.close();
  });
});
