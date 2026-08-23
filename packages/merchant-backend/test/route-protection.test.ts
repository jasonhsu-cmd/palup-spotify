import { describe, it, expect } from "vitest";
import { InMemoryRuntimeStore, type MerchantIdentityPort, type MerchantPrincipal } from "@palup/platform-ports";
import { buildServer } from "../src/server.js";

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

const AUTH_EXEMPT_PATHS = ["/health"];

describe("every registered route is protected by construction", () => {
  it("401s every route except the explicit /health exemption when no token is presented", async () => {
    const app = await buildServer({ store: new InMemoryRuntimeStore(), identity });
    await app.ready();

    expect(app.registeredRoutes.length).toBeGreaterThan(0);
    // Sanity: this suite must actually be exercising more than just /health, or the loop below would
    // pass vacuously as new routes land without ever having been added to this test.
    expect(app.registeredRoutes.some((r) => r.url !== "/health")).toBe(true);

    for (const route of app.registeredRoutes) {
      const res = await app.inject({ method: route.method, url: route.url });
      if (AUTH_EXEMPT_PATHS.includes(route.url)) {
        expect(res.statusCode, `${route.method} ${route.url} (exempt) should be 200`).toBe(200);
      } else {
        expect(res.statusCode, `${route.method} ${route.url} should be 401 with no token — got ${res.statusCode}`).toBe(401);
      }
    }

    await app.close();
  });
});
