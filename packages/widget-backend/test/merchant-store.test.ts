import { describe, it, expect } from "vitest";
import { createEnvSecrets } from "@palup/platform-ports";
import { resolveShopifyStore, parseStoreDomains, SHOPIFY_TOKEN_SECRET } from "../src/merchant-store.js";
import { resolveStorefrontCredential } from "../src/merchant-store.js";
import type { MerchantCredentialRead } from "@palup/state-postgres";

const domains = { acme: "acme-store.myshopify.com", brandx: "brandx.myshopify.com" };
const secrets = createEnvSecrets(JSON.stringify({ acme: { [SHOPIFY_TOKEN_SECRET]: "shptok_acme" } }));

describe("resolveShopifyStore", () => {
  it("returns creds only when BOTH domain and token resolve", async () => {
    expect(await resolveShopifyStore("acme", secrets, domains)).toEqual({
      shopDomain: "acme-store.myshopify.com",
      accessToken: "shptok_acme",
    });
  });

  it("returns undefined when the domain is configured but the token is missing (not fully configured)", async () => {
    expect(await resolveShopifyStore("brandx", secrets, domains)).toBeUndefined();
  });

  it("returns undefined for an unregistered tenant (→ caller falls back to fixtures)", async () => {
    expect(await resolveShopifyStore("nobody", secrets, domains)).toBeUndefined();
    expect(await resolveShopifyStore("", secrets, domains)).toBeUndefined();
  });

  it("is tenant-isolated — one tenant's token never resolves for another", async () => {
    // brandx has a domain but acme's token must NOT leak to it.
    const cross = createEnvSecrets(JSON.stringify({ acme: { [SHOPIFY_TOKEN_SECRET]: "shptok_acme" } }));
    expect(await resolveShopifyStore("brandx", cross, domains)).toBeUndefined();
  });

  it("does not resolve a domain for an inherited/prototype key", async () => {
    expect(await resolveShopifyStore("__proto__", secrets, domains)).toBeUndefined();
  });
});

const secretsWith = (map: Record<string, string>) => ({
  get: async (tenantId: string, name: string) => map[`${tenantId}:${name}`],
}) as any;
const credReadReturning = (r: MerchantCredentialRead) => async (_t: string) => r;
const readbackDomains = { demo: "demo-store.myshopify.com", acme: "acme.myshopify.com" };

describe("resolveStorefrontCredential", () => {
  it("readback ON + found → live creds from the custodied token", async () => {
    const out = await resolveStorefrontCredential("acme", {
      secrets: secretsWith({}), readbackEnabled: true,
      credRead: credReadReturning({ status: "found", token: "shpat_live" }), domains: readbackDomains,
    });
    expect(out).toEqual({ status: "live", creds: { shopDomain: "acme.myshopify.com", accessToken: "shpat_live" } });
  });

  it("readback ON + unreadable → refuse (never fixtures, never fallback)", async () => {
    const out = await resolveStorefrontCredential("acme", {
      secrets: secretsWith({ "acme:shopify_storefront_token": "shpat_fallback" }), // present, must be ignored
      readbackEnabled: true, credRead: credReadReturning({ status: "unreadable", reason: "undecryptable" }), domains: readbackDomains,
    });
    expect(out).toEqual({ status: "refuse", reason: "undecryptable" });
  });

  it("readback ON + missing → SecretsPort fallback (demo tenant keeps serving)", async () => {
    const out = await resolveStorefrontCredential("demo", {
      secrets: secretsWith({ "demo:shopify_storefront_token": "shpat_demo" }),
      readbackEnabled: true, credRead: credReadReturning({ status: "missing" }), domains: readbackDomains,
    });
    expect(out).toEqual({ status: "live", creds: { shopDomain: "demo-store.myshopify.com", accessToken: "shpat_demo" } });
  });

  it("readback ON + missing + no fallback token → fixtures", async () => {
    const out = await resolveStorefrontCredential("acme", {
      secrets: secretsWith({}), readbackEnabled: true, credRead: credReadReturning({ status: "missing" }), domains: readbackDomains,
    });
    expect(out).toEqual({ status: "fixtures" });
  });

  it("readback OFF → SecretsPort only, byte-behavior unchanged (never consults credRead, never refuses)", async () => {
    let credReadCalled = false;
    const out = await resolveStorefrontCredential("acme", {
      secrets: secretsWith({ "acme:shopify_storefront_token": "shpat_x" }),
      readbackEnabled: false, credRead: async () => { credReadCalled = true; return { status: "unreadable", reason: "undecryptable" }; }, domains: readbackDomains,
    });
    expect(out).toEqual({ status: "live", creds: { shopDomain: "acme.myshopify.com", accessToken: "shpat_x" } });
    expect(credReadCalled).toBe(false);
  });

  it("readback ON + found but NO shop domain → fixtures (can't ground; not a refusal)", async () => {
    const out = await resolveStorefrontCredential("unknown", {
      secrets: secretsWith({}), readbackEnabled: true,
      credRead: credReadReturning({ status: "found", token: "shpat_live" }), domains: readbackDomains,
    });
    expect(out).toEqual({ status: "fixtures" });
  });
});

describe("parseStoreDomains", () => {
  it("parses a JSON map and tolerates malformed input", () => {
    expect(parseStoreDomains(JSON.stringify(domains))).toMatchObject(domains);
    expect(Object.keys(parseStoreDomains("not json"))).toEqual([]);
    expect(Object.keys(parseStoreDomains(undefined))).toEqual([]);
  });
});
