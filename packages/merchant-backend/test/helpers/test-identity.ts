import type { MerchantIdentityPort, MerchantRole } from "@palup/platform-ports";

// W5 Task 3 (review-mandated fix M1): shared test-identity double for route tests. Mirrors the exact
// identity-fake pattern already used inline by test/route-protection.test.ts and
// test/activity-route.test.ts — a real (not no-op) authenticate that only accepts the literal
// bearer token "good", extracted here so multiple route-test files can share it without re-deriving
// the pattern. `authorize` always returns true (RBAC-by-role is exercised elsewhere; this double
// exists to unblock authentication, not to test the permission matrix).

/** Builds a `MerchantIdentityPort` double whose `authenticate("good")` resolves to a
 * `merchant_user` principal for `merchantId` (default role "owner"), and `{ kind: "anonymous" }`
 * for anything else (including no credential). */
export function makeTestIdentity(merchantId: string, role: MerchantRole = "owner"): MerchantIdentityPort {
  return {
    authenticate: async (cred) =>
      cred === "good"
        ? { kind: "merchant_user", merchantId, userId: "u1", role, authLevel: "session", sessionId: "s1" }
        : { kind: "anonymous" },
    authorize: () => true,
  };
}

/** The literal bearer header for the "good" credential `makeTestIdentity` accepts. NOTE: this is
 * NOT the merchantId — the tenant comes from the principal `makeTestIdentity` was built with, not
 * from the token itself. */
export function bearer(): { authorization: string } {
  return { authorization: "Bearer good" };
}
