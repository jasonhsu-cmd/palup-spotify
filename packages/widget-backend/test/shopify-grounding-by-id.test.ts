import { describe, it, expect } from "vitest";
import { mapStorefrontToContext } from "../src/shopify-grounding.js";
import { storefrontFetchByIds } from "../src/shopify-grounding.js";
import type { ShopifyStoreCreds } from "../src/merchant-store.js";

const CREDS: ShopifyStoreCreds = { shopDomain: "acme.myshopify.com", accessToken: "shpat_test" };

function fetchReturning(nodes: unknown[]): typeof globalThis.fetch {
  return (async () =>
    new Response(JSON.stringify({ data: { nodes } }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof globalThis.fetch;
}

describe("S3 §C — fetchProductsById returns only the asked products (nodes(ids:))", () => {
  it("maps resolved Product nodes and drops null / non-product nodes", async () => {
    const fetchFn = fetchReturning([
      {
        id: "gid://shopify/Product/1",
        title: "Alpha",
        description: "d",
        tags: ["t"],
        availableForSale: true,
        priceRange: { minVariantPrice: { amount: "10.00", currencyCode: "USD" } },
        variants: { nodes: [{ id: "gid://shopify/ProductVariant/11" }] },
      },
      null, // a deleted/delisted id resolves to null
    ]);
    const data = await storefrontFetchByIds(fetchFn)(CREDS, ["gid://shopify/Product/1", "gid://shopify/Product/2"]);
    const products = mapStorefrontToContext("acme", data).products;
    expect(products.map((p) => p.id)).toEqual(["gid://shopify/Product/1"]);
    expect(products[0]!.price).toBe("$10.00");
    expect(products[0]!.variantId).toBe("11");
  });

  it("refuses a non-myshopify host without sending the token (SSRF guard)", async () => {
    const evil: ShopifyStoreCreds = { shopDomain: "evil.example.com", accessToken: "shpat_test" };
    await expect(storefrontFetchByIds(fetchReturning([]))(evil, ["gid://shopify/Product/1"])).rejects.toThrow(/myshopify/);
  });

  it("returns no products for an empty id list without a network call", async () => {
    let called = false;
    const fetchFn = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const data = await storefrontFetchByIds(fetchFn)(CREDS, []);
    expect(mapStorefrontToContext("acme", data).products).toEqual([]);
    expect(called).toBe(false);
  });
});
