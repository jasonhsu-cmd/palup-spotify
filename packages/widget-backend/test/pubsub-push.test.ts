import { describe, it, expect, vi } from "vitest";
import Fastify from "fastify";
import { registerPubSubPushRoute, PUBSUB_PUSH_ROUTE, type OidcVerifier } from "../src/routes/pubsub-push.js";

// P4 — the OIDC-gated Pub/Sub push route: verify-before-you-act, and the exact ack semantics. Injected
// verifier (no network); the live OIDC verification is staging-verified (UNVERIFIED-LIVE).
const SA = "pubsub-push@proj.iam.gserviceaccount.com";

type Reconcile = (tenantId: string, opts?: { productIds?: string[]; reason?: "product" | "inventory" | "full" }) => Promise<void>;

function makeApp(over: Partial<{ verify: OidcVerifier; reconcile: Reconcile }> = {}) {
  const reconciled: Array<[string, { productIds?: string[]; reason?: "product" | "inventory" | "full" } | undefined]> = [];
  const f = Fastify();
  registerPubSubPushRoute(f, {
    verify: over.verify ?? (async (tok) => (tok === "good" ? { email: SA } : null)),
    expectedServiceAccount: SA,
    reconcile: over.reconcile ?? (async (t, o) => { reconciled.push([t, o]); }),
  });
  return { f, reconciled };
}
const envelope = (tenantKey?: string, data?: string) => ({
  message: { attributes: tenantKey !== undefined ? { tenantKey } : {}, ...(data !== undefined ? { data } : {}) },
});
/** Base64-JSON-encode a reconcile payload the way the publish adapter (`pubsub-queue.ts`) does. */
const encodeData = (payload: unknown) => Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
const post = (f: ReturnType<typeof Fastify>, headers: Record<string, string>, payload: unknown) =>
  f.inject({ method: "POST", url: PUBSUB_PUSH_ROUTE, headers, payload });

describe("P4 — Pub/Sub push route (OIDC-gated)", () => {
  it("valid OIDC + expected SA + tenantKey ⇒ reconciles and 204", async () => {
    const { f, reconciled } = makeApp();
    const res = await post(f, { authorization: "Bearer good" }, envelope("acme"));
    expect(res.statusCode).toBe(204);
    expect(reconciled).toEqual([["acme", undefined]]);
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

describe("S3 §C fix round 2 (coverage gap) — decoding `message.data` for targeting", () => {
  it("a valid base64-JSON body ⇒ reconcile receives the decoded {productIds, reason}", async () => {
    const { f, reconciled } = makeApp();
    const data = encodeData({ productIds: ["gid://shopify/Product/9"], reason: "product" });
    const res = await post(f, { authorization: "Bearer good" }, envelope("acme", data));
    expect(res.statusCode).toBe(204);
    expect(reconciled).toEqual([["acme", { productIds: ["gid://shopify/Product/9"], reason: "product" }]]);
  });

  it("malformed base64 ⇒ FAIL-SAFE to a full reconcile (opts undefined), no crash, no silent no-op", async () => {
    const { f, reconciled } = makeApp();
    // Not valid base64 at all (contains characters outside the alphabet plus odd padding); Buffer.from
    // does not throw on this (it silently drops bad chars), so the failure has to come from the JSON.parse
    // of whatever garbage bytes result — still covered by the same try/catch either way.
    const res = await post(f, { authorization: "Bearer good" }, envelope("acme", "%%%not-base64%%%"));
    expect(res.statusCode).toBe(204);
    expect(reconciled).toEqual([["acme", undefined]]);
  });

  it("valid base64 but INVALID JSON ⇒ FAIL-SAFE to a full reconcile (opts undefined)", async () => {
    const { f, reconciled } = makeApp();
    const data = Buffer.from("{not valid json", "utf8").toString("base64");
    const res = await post(f, { authorization: "Bearer good" }, envelope("acme", data));
    expect(res.statusCode).toBe(204);
    expect(reconciled).toEqual([["acme", undefined]]);
  });

  it("absent message.data ⇒ opts is undefined (still a full reconcile, not a crash)", async () => {
    const { f, reconciled } = makeApp();
    const res = await post(f, { authorization: "Bearer good" }, envelope("acme"));
    expect(res.statusCode).toBe(204);
    expect(reconciled).toEqual([["acme", undefined]]);
  });
});
