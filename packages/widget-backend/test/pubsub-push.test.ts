import { describe, it, expect, vi } from "vitest";
import Fastify from "fastify";
import { registerPubSubPushRoute, PUBSUB_PUSH_ROUTE, type OidcVerifier } from "../src/routes/pubsub-push.js";

// P4 — the OIDC-gated Pub/Sub push route: verify-before-you-act, and the exact ack semantics. Injected
// verifier (no network); the live OIDC verification is staging-verified (UNVERIFIED-LIVE).
const SA = "pubsub-push@proj.iam.gserviceaccount.com";

function makeApp(over: Partial<{ verify: OidcVerifier; reconcile: (t: string) => Promise<void> }> = {}) {
  const reconciled: string[] = [];
  const f = Fastify();
  registerPubSubPushRoute(f, {
    verify: over.verify ?? (async (tok) => (tok === "good" ? { email: SA } : null)),
    expectedServiceAccount: SA,
    reconcile: over.reconcile ?? (async (t) => { reconciled.push(t); }),
  });
  return { f, reconciled };
}
const envelope = (tenantKey?: string) => ({ message: { attributes: tenantKey !== undefined ? { tenantKey } : {} } });
const post = (f: ReturnType<typeof Fastify>, headers: Record<string, string>, payload: unknown) =>
  f.inject({ method: "POST", url: PUBSUB_PUSH_ROUTE, headers, payload });

describe("P4 — Pub/Sub push route (OIDC-gated)", () => {
  it("valid OIDC + expected SA + tenantKey ⇒ reconciles and 204", async () => {
    const { f, reconciled } = makeApp();
    const res = await post(f, { authorization: "Bearer good" }, envelope("acme"));
    expect(res.statusCode).toBe(204);
    expect(reconciled).toEqual(["acme"]);
  });

  it("missing bearer ⇒ 401, no reconcile", async () => {
    const { f, reconciled } = makeApp();
    const res = await post(f, {}, envelope("acme"));
    expect(res.statusCode).toBe(401);
    expect(reconciled).toEqual([]);
  });

  it("valid Google signature but WRONG service account ⇒ 401 (Google-signed is necessary, not sufficient)", async () => {
    const { f, reconciled } = makeApp({ verify: async () => ({ email: "attacker@evil.iam.gserviceaccount.com" }) });
    const res = await post(f, { authorization: "Bearer good" }, envelope("acme"));
    expect(res.statusCode).toBe(401);
    expect(reconciled).toEqual([]);
  });

  it("verify throws (bad/expired token) ⇒ 401", async () => {
    const { f, reconciled } = makeApp({ verify: async () => { throw new Error("invalid token"); } });
    const res = await post(f, { authorization: "Bearer bad" }, envelope("acme"));
    expect(res.statusCode).toBe(401);
    expect(reconciled).toEqual([]);
  });

  it("valid OIDC but no tenantKey ⇒ 204 (ack + drop; retrying can't make it valid), no reconcile", async () => {
    const { f, reconciled } = makeApp();
    const res = await post(f, { authorization: "Bearer good" }, envelope());
    expect(res.statusCode).toBe(204);
    expect(reconciled).toEqual([]);
  });

  it("a reconcile failure ⇒ 500 so Pub/Sub retries (then dead-letters server-side)", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { f } = makeApp({ reconcile: async () => { throw new Error("db down"); } });
      const res = await post(f, { authorization: "Bearer good" }, envelope("acme"));
      expect(res.statusCode).toBe(500);
      expect(err.mock.calls.flat().join(" ")).toContain("catalog_reconcile_failed");
    } finally {
      err.mockRestore();
    }
  });
});
