import { describe, it, expect } from "vitest";
import { mapStorefrontToContext, STOREFRONT_NODES_MAX } from "../src/shopify-grounding.js";
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

  it("drops a non-Product node (empty fragment result) mixed with a real Product, without mis-mapping it", async () => {
    const fetchFn = fetchReturning([
      {
        id: "gid://shopify/Product/1",
        title: "Alpha",
        description: "d",
        tags: [],
        availableForSale: true,
        priceRange: { minVariantPrice: { amount: "5.00", currencyCode: "USD" } },
        variants: { nodes: [] },
      },
      // A GID that resolves to a real Node but NOT a Product (e.g. a ProductVariant GID mistakenly
      // requested): the `... on Product` inline fragment selects nothing, so Shopify returns an object
      // with none of the fragment's fields — no `id` — never `null`. Must be dropped, not mis-mapped.
      {},
    ]);
    const data = await storefrontFetchByIds(fetchFn)(CREDS, ["gid://shopify/Product/1", "gid://shopify/ProductVariant/99"]);
    const products = mapStorefrontToContext("acme", data).products;
    expect(products).toHaveLength(1);
    expect(products[0]!.id).toBe("gid://shopify/Product/1");
  });

  it("chunks a request above STOREFRONT_NODES_MAX into multiple nodes(ids:) calls and merges resolved products", async () => {
    const total = STOREFRONT_NODES_MAX + 10; // 260 when the cap is 250
    const ids = Array.from({ length: total }, (_, i) => `gid://shopify/Product/${i}`);
    // The last id in the batch resolves to null (delisted) — must stay absent from the merged result too.
    const deletedId = ids[ids.length - 1]!;
    const calls: string[][] = [];
    const fetchFn = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { variables: { ids: string[] } };
      calls.push(body.variables.ids);
      const nodes = body.variables.ids.map((id) =>
        id === deletedId
          ? null
          : {
              id,
              title: "T",
              description: "d",
              tags: [],
              availableForSale: true,
              priceRange: { minVariantPrice: { amount: "1.00", currencyCode: "USD" } },
              variants: { nodes: [] },
            },
      );
      return new Response(JSON.stringify({ data: { nodes } }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof globalThis.fetch;

    const data = await storefrontFetchByIds(fetchFn)(CREDS, ids);
    const products = mapStorefrontToContext("acme", data).products;

    // Non-vacuous: with chunking removed (a single call for `total` ids) this would be 1, not 2.
    expect(calls.length).toBe(Math.ceil(total / STOREFRONT_NODES_MAX));
    for (const c of calls) expect(c.length).toBeLessThanOrEqual(STOREFRONT_NODES_MAX);
    expect(calls.flat().length).toBe(total);
    expect(products).toHaveLength(total - 1); // every id resolved except the deleted one
    expect(products.some((p) => p.id === deletedId)).toBe(false);
  });
});
