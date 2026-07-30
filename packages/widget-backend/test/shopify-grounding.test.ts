import { describe, it, expect } from "vitest";
import { mapStorefrontToContext, createShopifyGroundingAdapter, storefrontFetch, STOREFRONT_API_VERSION, type StorefrontData } from "../src/shopify-grounding.js";

const SAMPLE: StorefrontData = {
  shop: {
    name: "Acme Skincare",
    refundPolicy: { body: "30-day returns on unopened items." },
    shippingPolicy: { body: "Free US shipping over $50." },
  },
  products: {
    nodes: [
      { id: "gid://shopify/Product/1", title: "Gentle Cleanser", description: "Sulfate-free.", tags: ["cleanser"], priceRange: { minVariantPrice: { amount: "18.00", currencyCode: "USD" } } },
      { id: "gid://shopify/Product/2", title: "EU Serum", priceRange: { minVariantPrice: { amount: "24.00", currencyCode: "EUR" } } },
    ],
  },
};

describe("mapStorefrontToContext", () => {
  it("maps Storefront data onto GroundingContext, stamping the REQUESTED tenant", () => {
    const ctx = mapStorefrontToContext("acme", SAMPLE);
    expect(ctx.tenantId).toBe("acme"); // requested tenant, never from the response
    expect(ctx.brandName).toBe("Acme Skincare");
    expect(ctx.products).toHaveLength(2);
    expect(ctx.products[0]).toMatchObject({ id: "gid://shopify/Product/1", title: "Gentle Cleanser", price: "$18.00", description: "Sulfate-free.", tags: ["cleanser"] });
    expect(ctx.products[1].price).toBe("24.00 EUR"); // non-USD formatting
    expect(ctx.products[1].description).toBe(""); // missing description → empty, never invented
    expect(ctx.policy.returns).toContain("30-day");
    expect(ctx.policy.shipping).toContain("Free US shipping");
  });

  it("degrades to a safe-empty-ish context on sparse data (no invented fields)", () => {
    const ctx = mapStorefrontToContext("t", {});
    expect(ctx.tenantId).toBe("t");
    expect(ctx.products).toEqual([]);
    expect(ctx.policy).toEqual({ returns: "", shipping: "" });
  });
});

describe("createShopifyGroundingAdapter", () => {
  it("fetches + maps via the injected fetch (the wire works when a real fetch exists)", async () => {
    const adapter = createShopifyGroundingAdapter({ shopDomain: "acme.myshopify.com", accessToken: "tok" }, async () => SAMPLE);
    const ctx = await adapter.getContext("acme");
    expect(ctx.brandName).toBe("Acme Skincare");
    expect(ctx.products).toHaveLength(2);
  });

  it("bounds merchant-supplied text (prompt bloat / injection surface)", () => {
    const ctx = mapStorefrontToContext("t", {
      shop: { name: "n" },
      products: { nodes: [{ id: "1", title: "T".repeat(500), description: "D".repeat(2000), tags: Array.from({ length: 50 }, (_, i) => `t${i}`) }] },
    });
    expect(ctx.products[0].title.length).toBe(200);
    expect(ctx.products[0].description.length).toBe(600);
    expect(ctx.products[0].tags!.length).toBe(20);
  });
});

describe("storefrontFetch (verified Storefront API 2026-07 call)", () => {
  const creds = { shopDomain: "acme.myshopify.com", accessToken: "shptok_secret" };

  function fakeFetch(handler: (url: string, init: any) => { ok?: boolean; status?: number; json: () => Promise<unknown> }) {
    const calls: Array<{ url: string; init: any }> = [];
    const fn = (async (url: string, init: any) => {
      calls.push({ url, init });
      const r = handler(url, init);
      return { ok: r.ok ?? true, status: r.status ?? 200, json: r.json } as Response;
    }) as unknown as typeof globalThis.fetch;
    return { fn, calls };
  }

  it("POSTs the verified query to the versioned endpoint with the Storefront token header", async () => {
    const { fn, calls } = fakeFetch(() => ({ json: async () => ({ data: SAMPLE }) }));
    const data = await storefrontFetch(fn)(creds);
    expect(calls[0].url).toBe(`https://acme.myshopify.com/api/${STOREFRONT_API_VERSION}/graphql.json`);
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers["X-Shopify-Storefront-Access-Token"]).toBe("shptok_secret");
    const body = JSON.parse(calls[0].init.body);
    expect(body.query).toContain("products(first: $first)");
    expect(body.query).toContain("refundPolicy { body }");
    expect(body.variables.first).toBe(250);
    expect(data.shop!.name).toBe("Acme Skincare");
  });

  it("throws on a non-2xx response (→ caching wrapper degrades, never serves garbage)", async () => {
    const { fn } = fakeFetch(() => ({ ok: false, status: 401, json: async () => ({}) }));
    await expect(storefrontFetch(fn)(creds)).rejects.toThrow(/401/);
  });

  it("throws on a GraphQL errors payload", async () => {
    const { fn } = fakeFetch(() => ({ json: async () => ({ errors: [{ message: "bad token" }] }) }));
    await expect(storefrontFetch(fn)(creds)).rejects.toThrow(/bad token/);
  });
});
