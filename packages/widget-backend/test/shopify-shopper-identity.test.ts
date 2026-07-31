import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { createEnvSecrets } from "@palup/platform-ports";
import {
  signAppProxyParams,
  verifyShopifyAppProxyShopper,
  normalizeAppProxyQuery,
  SHOPIFY_APP_PROXY_SECRET_SCOPE,
  SHOPIFY_APP_PROXY_SECRET_NAME,
  type AppProxyParams,
} from "../src/shopify-shopper-identity.js";

// Reference implementation of Shopify's DOCUMENTED App Proxy signature algorithm (shopify.dev
// "Authenticate app proxies", retrieved 2026-08-01): drop `signature`; each param as `key=value` with
// multi-values joined by ','; sort lexicographically; concatenate with NO delimiter; HMAC-SHA256 keyed by
// the app shared secret; hex. Written from the spec (not importing our code) so it catches drift between
// our signer and the documented steps. NOTE: it is the SAME algorithm as production, so it proves
// self-consistency + spec-transcription match — NOT that our transcription matches Shopify's LIVE bytes.
// True conformance needs a GOLDEN VECTOR captured from real App-Proxy traffic (a live-cutover artifact).
function shopifyReferenceSign(secret: string, params: Record<string, string | string[]>): string {
  const s = Object.keys(params)
    .filter((k) => k !== "signature")
    .sort()
    .map((k) => `${k}=${Array.isArray(params[k]) ? (params[k] as string[]).join(",") : params[k]}`)
    .join("");
  return createHmac("sha256", secret).update(s).digest("hex");
}

// ADR-0017 T2: the Shopify App-Proxy shopper verifier. Deterministic + testable NOW (the exact Shopify
// wire format is spike-gated, T2b — see the honesty note in shopify-shopper-identity.ts); this suite
// proves the security invariants against our OWN self-consistent sign/verify routine.

const SECRET = "app-proxy-shared-secret";
const secrets = createEnvSecrets(JSON.stringify({ [SHOPIFY_APP_PROXY_SECRET_SCOPE]: { [SHOPIFY_APP_PROXY_SECRET_NAME]: SECRET } }));
const NOW = 1_700_000_000;
const resolveTenant = (shop: string): string | undefined => (shop === "acme-store.myshopify.com" ? "acme" : shop === "brandx.myshopify.com" ? "brandx" : undefined);

function signedParams(overrides: Partial<AppProxyParams> = {}): AppProxyParams {
  const base: AppProxyParams = {
    shop: "acme-store.myshopify.com",
    logged_in_customer_id: "48291",
    timestamp: String(NOW),
    path_prefix: "/apps/palup",
    ...overrides,
  };
  const signature = signAppProxyParams(SECRET, base);
  return { ...base, signature };
}

describe("verifyShopifyAppProxyShopper (T2)", () => {
  it("valid sig + non-empty cid + shop→tenant ⇒ namespaced shopper principal", async () => {
    const p = await verifyShopifyAppProxyShopper(signedParams(), { expectedTenant: "acme", resolveTenant, secrets, nowSec: () => NOW });
    expect(p).toEqual({ kind: "shopper", shopperId: "shopify:acme:48291", source: "shopify", verified: true });
  });

  it("a tampered signature ⇒ anonymous", async () => {
    const params = signedParams();
    params.signature = params.signature!.slice(0, -2) + (params.signature!.slice(-2) === "aa" ? "bb" : "aa");
    const p = await verifyShopifyAppProxyShopper(params, { expectedTenant: "acme", resolveTenant, secrets, nowSec: () => NOW });
    expect(p).toEqual({ kind: "anonymous" });
  });

  it("a tampered param (customer id swapped post-signing) ⇒ anonymous (signature no longer matches)", async () => {
    const params = signedParams();
    params.logged_in_customer_id = "99999"; // forged after signing — signature was computed over "48291"
    const p = await verifyShopifyAppProxyShopper(params, { expectedTenant: "acme", resolveTenant, secrets, nowSec: () => NOW });
    expect(p).toEqual({ kind: "anonymous" });
  });

  it("empty/absent logged_in_customer_id ⇒ anonymous (browsing, not logged in)", async () => {
    for (const cid of ["", undefined]) {
      const params = signedParams({ logged_in_customer_id: cid });
      const p = await verifyShopifyAppProxyShopper(params, { expectedTenant: "acme", resolveTenant, secrets, nowSec: () => NOW });
      expect(p).toEqual({ kind: "anonymous" });
    }
  });

  it("F5 — a stale timestamp ⇒ anonymous", async () => {
    const params = signedParams({ timestamp: String(NOW - 301) }); // > default 300s max age
    const p = await verifyShopifyAppProxyShopper(params, { expectedTenant: "acme", resolveTenant, secrets, nowSec: () => NOW });
    expect(p).toEqual({ kind: "anonymous" });
  });

  it("F5 — a FUTURE timestamp beyond skew tolerance ⇒ anonymous", async () => {
    const params = signedParams({ timestamp: String(NOW + 61) }); // > default 60s future skew
    const p = await verifyShopifyAppProxyShopper(params, { expectedTenant: "acme", resolveTenant, secrets, nowSec: () => NOW });
    expect(p).toEqual({ kind: "anonymous" });
  });

  it("F5 — a timestamp within tolerance (slightly past or slightly future) is accepted", async () => {
    const past = await verifyShopifyAppProxyShopper(signedParams({ timestamp: String(NOW - 100) }), { expectedTenant: "acme", resolveTenant, secrets, nowSec: () => NOW });
    expect(past.kind).toBe("shopper");
    const future = await verifyShopifyAppProxyShopper(signedParams({ timestamp: String(NOW + 30) }), { expectedTenant: "acme", resolveTenant, secrets, nowSec: () => NOW });
    expect(future.kind).toBe("shopper");
  });

  it("cross-shop mismatch (shop resolves to a DIFFERENT tenant than the verified widget tenant) ⇒ anonymous", async () => {
    const params = signedParams({ shop: "brandx.myshopify.com" });
    // brandx.myshopify.com resolves to tenant "brandx", but this session is for the verified tenant "acme".
    const p = await verifyShopifyAppProxyShopper(params, { expectedTenant: "acme", resolveTenant, secrets, nowSec: () => NOW });
    expect(p).toEqual({ kind: "anonymous" });
  });

  it("an unresolvable shop domain ⇒ anonymous", async () => {
    const params = signedParams({ shop: "unknown-store.myshopify.com" });
    const p = await verifyShopifyAppProxyShopper(params, { expectedTenant: "acme", resolveTenant, secrets, nowSec: () => NOW });
    expect(p).toEqual({ kind: "anonymous" });
  });

  it("F6 — namespace validation: a customer id that isn't purely numeric ⇒ anonymous", async () => {
    const params = signedParams({ logged_in_customer_id: "123;drop" });
    const p = await verifyShopifyAppProxyShopper(params, { expectedTenant: "acme", resolveTenant, secrets, nowSec: () => NOW });
    expect(p).toEqual({ kind: "anonymous" });
  });

  it("F6 — namespace validation: a resolved tenant containing invalid characters ⇒ anonymous", async () => {
    const weirdResolve = (): string | undefined => "acme:evil"; // a malicious/misconfigured tenant id with a colon
    const params = signedParams();
    const p = await verifyShopifyAppProxyShopper(params, { expectedTenant: "acme:evil", resolveTenant: weirdResolve, secrets, nowSec: () => NOW });
    expect(p).toEqual({ kind: "anonymous" });
  });

  it("no signature param ⇒ anonymous", async () => {
    const { signature: _drop, ...rest } = signedParams();
    const p = await verifyShopifyAppProxyShopper(rest, { expectedTenant: "acme", resolveTenant, secrets, nowSec: () => NOW });
    expect(p).toEqual({ kind: "anonymous" });
  });

  it("no app secret configured ⇒ anonymous (fails closed, never throws)", async () => {
    const unconfigured = createEnvSecrets(undefined);
    const p = await verifyShopifyAppProxyShopper(signedParams(), { expectedTenant: "acme", resolveTenant, secrets: unconfigured, nowSec: () => NOW });
    expect(p).toEqual({ kind: "anonymous" });
  });

  it("never throws on garbage input", async () => {
    const garbage = { shop: 123 as unknown as string, signature: "x" } as AppProxyParams;
    await expect(verifyShopifyAppProxyShopper(garbage, { expectedTenant: "acme", resolveTenant, secrets, nowSec: () => NOW })).resolves.toEqual({ kind: "anonymous" });
  });
});

// T2b (ADR-0017): conform to the DOCUMENTED Shopify App Proxy signature format and cite it. The verifier
// must accept a signature computed exactly the way Shopify computes it — including the multi-value comma
// join — otherwise a real signed request with any repeated query param would fail-closed to anonymous.
describe("T2b — conformance to the documented Shopify App Proxy signature format", () => {
  it("our signAppProxyParams == the documented reference (single-value params)", () => {
    const base = { shop: "acme-store.myshopify.com", logged_in_customer_id: "48291", timestamp: String(NOW), path_prefix: "/apps/palup" };
    expect(signAppProxyParams(SECRET, base)).toBe(shopifyReferenceSign(SECRET, base));
  });

  it("our signAppProxyParams == the documented reference WITH a repeated (multi-value) param joined by ','", () => {
    const base: AppProxyParams = { shop: "acme-store.myshopify.com", logged_in_customer_id: "48291", timestamp: String(NOW), ids: ["7", "9"] };
    expect(signAppProxyParams(SECRET, base)).toBe(shopifyReferenceSign(SECRET, base as Record<string, string | string[]>));
  });

  it("verify accepts a request signed the DOCUMENTED way (single-value)", async () => {
    const base = { shop: "acme-store.myshopify.com", logged_in_customer_id: "48291", timestamp: String(NOW), path_prefix: "/apps/palup" };
    const params: AppProxyParams = { ...base, signature: shopifyReferenceSign(SECRET, base) };
    const p = await verifyShopifyAppProxyShopper(params, { expectedTenant: "acme", resolveTenant, secrets, nowSec: () => NOW });
    expect(p).toEqual({ kind: "shopper", shopperId: "shopify:acme:48291", source: "shopify", verified: true });
  });

  it("verify accepts a request with a REPEATED param (Shopify signs it comma-joined) — not dropped", async () => {
    const base: Record<string, string | string[]> = { shop: "acme-store.myshopify.com", logged_in_customer_id: "48291", timestamp: String(NOW), path_prefix: "/apps/palup", ids: ["7", "9"] };
    const params: AppProxyParams = { ...base, signature: shopifyReferenceSign(SECRET, base) };
    const p = await verifyShopifyAppProxyShopper(params, { expectedTenant: "acme", resolveTenant, secrets, nowSec: () => NOW });
    expect(p.kind).toBe("shopper");
  });

  it("an array-valued logged_in_customer_id ⇒ anonymous (a semantic field must be single-valued, even if the signature covers the join)", async () => {
    const base: Record<string, string | string[]> = { shop: "acme-store.myshopify.com", logged_in_customer_id: ["48291", "99999"], timestamp: String(NOW), path_prefix: "/apps/palup" };
    const params: AppProxyParams = { ...base, signature: shopifyReferenceSign(SECRET, base) };
    const p = await verifyShopifyAppProxyShopper(params, { expectedTenant: "acme", resolveTenant, secrets, nowSec: () => NOW });
    expect(p).toEqual({ kind: "anonymous" });
  });

  it("array-valued shop / timestamp / signature ⇒ anonymous (every semantic field is single-value-guarded, even with a valid signature over the join)", async () => {
    // shop as an array (signature validly computed over the comma-joined value)
    const b1: Record<string, string | string[]> = { shop: ["acme-store.myshopify.com", "x"], logged_in_customer_id: "48291", timestamp: String(NOW) };
    const p1 = await verifyShopifyAppProxyShopper({ ...b1, signature: shopifyReferenceSign(SECRET, b1) }, { expectedTenant: "acme", resolveTenant, secrets, nowSec: () => NOW });
    expect(p1).toEqual({ kind: "anonymous" });
    // timestamp as an array ⇒ Number(array) is NaN ⇒ anonymous
    const b2: Record<string, string | string[]> = { shop: "acme-store.myshopify.com", logged_in_customer_id: "48291", timestamp: [String(NOW), String(NOW)] };
    const p2 = await verifyShopifyAppProxyShopper({ ...b2, signature: shopifyReferenceSign(SECRET, b2) }, { expectedTenant: "acme", resolveTenant, secrets, nowSec: () => NOW });
    expect(p2).toEqual({ kind: "anonymous" });
    // signature as an array ⇒ not a single hex string ⇒ anonymous
    const b3 = { shop: "acme-store.myshopify.com", logged_in_customer_id: "48291", timestamp: String(NOW) };
    const sig = shopifyReferenceSign(SECRET, b3);
    const p3 = await verifyShopifyAppProxyShopper({ ...b3, signature: [sig, sig] } as AppProxyParams, { expectedTenant: "acme", resolveTenant, secrets, nowSec: () => NOW });
    expect(p3).toEqual({ kind: "anonymous" });
  });

  describe("normalizeAppProxyQuery (the /shopper/session query → AppProxyParams boundary)", () => {
    it("keeps string and repeated-string (array) params; drops non-string junk", () => {
      const out = normalizeAppProxyQuery({ shop: "acme-store.myshopify.com", ids: ["7", "9"], signature: "abc", n: 123, obj: { x: 1 }, arrMixed: ["a", 2] });
      expect(out).toEqual({ shop: "acme-store.myshopify.com", ids: ["7", "9"], signature: "abc" });
    });

    it("a __proto__/constructor query key lands as an own property on a null-proto object — no pollution", () => {
      const raw = JSON.parse('{"__proto__":"x","constructor":"y","shop":"acme-store.myshopify.com"}'); // JSON.parse makes these OWN keys
      const out = normalizeAppProxyQuery(raw);
      expect(Object.getPrototypeOf(out)).toBeNull(); // still null-proto
      expect(out.shop).toBe("acme-store.myshopify.com");
      expect(({} as Record<string, unknown>).x).toBeUndefined(); // Object.prototype was not polluted
    });

    it("a request that routes through normalizeAppProxyQuery still verifies (round-trip with a repeated param)", async () => {
      const base: Record<string, string | string[]> = { shop: "acme-store.myshopify.com", logged_in_customer_id: "48291", timestamp: String(NOW), ids: ["7", "9"] };
      const rawQuery = { ...base, signature: shopifyReferenceSign(SECRET, base) };
      const params = normalizeAppProxyQuery(rawQuery);
      const p = await verifyShopifyAppProxyShopper(params, { expectedTenant: "acme", resolveTenant, secrets, nowSec: () => NOW });
      expect(p.kind).toBe("shopper");
    });
  });
});
