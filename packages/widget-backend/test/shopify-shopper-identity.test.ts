import { describe, it, expect } from "vitest";
import { createEnvSecrets } from "@palup/platform-ports";
import {
  signAppProxyParams,
  verifyShopifyAppProxyShopper,
  SHOPIFY_APP_PROXY_SECRET_SCOPE,
  SHOPIFY_APP_PROXY_SECRET_NAME,
  type AppProxyParams,
} from "../src/shopify-shopper-identity.js";

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
