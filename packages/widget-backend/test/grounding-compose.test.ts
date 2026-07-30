import { describe, it, expect, afterEach } from "vitest";
import { InMemoryRuntimeStore, createEnvSecrets } from "@palup/platform-ports";
import { createGroundingPort } from "../src/model.js";
import { SHOPIFY_TOKEN_SECRET } from "../src/merchant-store.js";

// createGroundingPort routes per-tenant: Shopify when creds resolve, else fixtures — all behind the
// caching wrapper. During rollout no tenant has creds ⇒ everyone gets fixtures.
afterEach(() => delete process.env.SHOPIFY_STORES);

describe("createGroundingPort composition", () => {
  it("falls back to fixtures when a tenant has no Shopify credentials", async () => {
    const g = createGroundingPort(new InMemoryRuntimeStore(), createEnvSecrets(undefined));
    expect((await g.getContext("demo")).brandName).toBe("Auria"); // fixture
    expect((await g.getContext("northwind")).brandName).toBe("Northwind Coffee");
    expect((await g.getContext("unknown-tenant")).products).toEqual([]); // safe-empty
  });

  it("routes a credential-configured tenant to Shopify (injected fetch), fixtures for others", async () => {
    process.env.SHOPIFY_STORES = JSON.stringify({ acme: "acme.myshopify.com" });
    const secrets = createEnvSecrets(JSON.stringify({ acme: { [SHOPIFY_TOKEN_SECRET]: "shptok" } }));
    // Inject a fake Storefront fetch so the test never hits the network — proves the routing wires
    // real creds → the Shopify adapter → mapped GroundingContext.
    const g = createGroundingPort(new InMemoryRuntimeStore(), secrets, {
      shopifyFetch: async () => ({ shop: { name: "Acme Live" }, products: { nodes: [{ id: "1", title: "Live Product", priceRange: { minVariantPrice: { amount: "9.00", currencyCode: "USD" } } }] } }),
    });
    const acme = await g.getContext("acme");
    expect(acme.tenantId).toBe("acme");
    expect(acme.brandName).toBe("Acme Live"); // real store data, not a fixture
    expect(acme.products[0].title).toBe("Live Product");
    // a DIFFERENT, unconfigured tenant still gets its fixture (routing is per-tenant + isolated).
    expect((await g.getContext("demo")).brandName).toBe("Auria");
  });

  it("degrades to safe-empty when the live Shopify fetch fails (never crashes, never another tenant's data)", async () => {
    process.env.SHOPIFY_STORES = JSON.stringify({ acme: "acme.myshopify.com" });
    const secrets = createEnvSecrets(JSON.stringify({ acme: { [SHOPIFY_TOKEN_SECRET]: "shptok" } }));
    const g = createGroundingPort(new InMemoryRuntimeStore(), secrets, {
      shopifyFetch: async () => { throw new Error("Shopify Storefront API 401"); },
    });
    const acme = await g.getContext("acme");
    expect(acme.tenantId).toBe("acme");
    expect(acme.products).toEqual([]); // safe-empty via the caching wrapper's fail-closed
  });
});
