import { describe, it, expect } from "vitest";
import { createEnvSecrets } from "@palup/platform-ports";
import { resolveShopifyStore, parseStoreDomains, SHOPIFY_TOKEN_SECRET } from "../src/merchant-store.js";

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

describe("parseStoreDomains", () => {
  it("parses a JSON map and tolerates malformed input", () => {
    expect(parseStoreDomains(JSON.stringify(domains))).toMatchObject(domains);
    expect(Object.keys(parseStoreDomains("not json"))).toEqual([]);
    expect(Object.keys(parseStoreDomains(undefined))).toEqual([]);
  });
});
