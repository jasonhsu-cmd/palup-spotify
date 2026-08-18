import { describe, it, expect } from "vitest";
import {
  storefrontProductByHandleFetch,
  mapStorefrontToContext,
  PRODUCT_PAGE_FIELDS,
  PRODUCT_NODE_FIELDS,
  STOREFRONT_API_VERSION,
  type StorefrontEgressLog,
} from "../src/shopify-grounding.js";

// Single-product-by-handle fetch — backs the PDP on a DIRECT hit (SEO/ad/typed URL) so a product beyond
// the grid's first page still resolves, instead of a false not-found. It reuses the SAME per-node render
// fields (PRODUCT_NODE_FIELDS) and flows through the SAME mapStorefrontToContext as the paginated path.
// NO LIVE SHOPIFY CALL (no creds here); the query is fixture-tested against an injected fetch, and the
// `product(handle:)` shape is marked NOT-LIVE-VERIFIED in the adapter (confirm via drift-check).

const creds = { shopDomain: "acme.myshopify.com", accessToken: "shptok_secret" };
const SHOP = { name: "Acme Skincare", refundPolicy: { body: "30-day returns." }, shippingPolicy: { body: "Free US shipping." } };

const node = (over: Record<string, unknown> = {}) => ({
  id: "gid://shopify/Product/9",
  title: "Glow Serum",
  description: "A serum.",
  tags: ["serum"],
  availableForSale: true,
  handle: "glow-serum",
  featuredImage: { url: "https://cdn.shopify.com/s/files/1/x.jpg", altText: "Glow" },
  priceRange: { minVariantPrice: { amount: "42.00", currencyCode: "USD" } },
  variants: { nodes: [{ id: "gid://shopify/ProductVariant/123456" }] },
  ...over,
});

interface Recorded {
  url: string;
  query: string;
  variables: { handle?: string };
  headers: Record<string, string>;
  signal: unknown;
}
function fakeStorefront(payload: { product?: unknown; shop?: unknown; ok?: boolean; status?: number; errors?: unknown[] }) {
  const calls: Recorded[] = [];
  const fn = (async (url: string, init: { body: string; headers: Record<string, string>; signal: unknown }) => {
    const body = JSON.parse(init.body) as { query: string; variables: { handle?: string } };
    calls.push({ url, query: body.query, variables: body.variables, headers: init.headers, signal: init.signal });
    return {
      ok: payload.ok ?? true,
      status: payload.status ?? 200,
      json: async () => (payload.errors ? { errors: payload.errors } : { data: { product: payload.product ?? null, shop: payload.shop ?? SHOP } }),
    } as Response;
  }) as unknown as typeof globalThis.fetch;
  return { fn, calls };
}

describe("storefrontProductByHandleFetch — resolve ONE product for a direct PDP hit", () => {
  it("queries product(handle:) with the handle, the shop shell, and the shared render fields", async () => {
    const { fn, calls } = fakeStorefront({ product: node() });
    await storefrontProductByHandleFetch(fn)(creds, "glow-serum");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`https://acme.myshopify.com/api/${STOREFRONT_API_VERSION}/graphql.json`);
    expect(calls[0]!.variables.handle).toBe("glow-serum");
    expect(calls[0]!.query).toContain("product(handle: $handle)");
    expect(calls[0]!.query).toContain("refundPolicy { body }"); // shop shell in the same round-trip
    expect(calls[0]!.query).toContain(PRODUCT_NODE_FIELDS); // the SAME render fields as the grid path
  });

  it("PRODUCT_PAGE_FIELDS still wraps PRODUCT_NODE_FIELDS in nodes{} + pageInfo (shared, unchanged)", () => {
    expect(PRODUCT_PAGE_FIELDS).toContain(`nodes { ${PRODUCT_NODE_FIELDS} }`);
    expect(PRODUCT_PAGE_FIELDS).toContain("pageInfo { hasNextPage endCursor }");
  });

  it("reshapes { product, shop } so mapStorefrontToContext yields exactly that ONE mapped product", async () => {
    const { fn } = fakeStorefront({ product: node() });
    const data = await storefrontProductByHandleFetch(fn)(creds, "glow-serum");
    const ctx = mapStorefrontToContext("acme", data);
    expect(ctx.products).toHaveLength(1);
    const p = ctx.products[0]!;
    expect(p.id).toBe("gid://shopify/Product/9");
    expect(p.title).toBe("Glow Serum");
    expect(p.handle).toBe("glow-serum");
    expect(p.variantId).toBe("123456"); // numeric id extracted from the variant GID
    expect(p.imageUrl).toBe("https://cdn.shopify.com/s/files/1/x.jpg");
    expect(ctx.brandName).toBe("Acme Skincare");
    expect(ctx.tenantId).toBe("acme");
  });

  it("a handle that resolves to NO product → zero products, brand/policy intact", async () => {
    const { fn } = fakeStorefront({ product: null });
    const data = await storefrontProductByHandleFetch(fn)(creds, "does-not-exist");
    const ctx = mapStorefrontToContext("acme", data);
    expect(ctx.products).toEqual([]);
    expect(ctx.brandName).toBe("Acme Skincare");
  });

  it("sends the private token + a per-request timeout signal, never the public browser header", async () => {
    const { fn, calls } = fakeStorefront({ product: node() });
    await storefrontProductByHandleFetch(fn)(creds, "glow-serum");
    expect(calls[0]!.headers["Shopify-Storefront-Private-Token"]).toBe("shptok_secret");
    expect(calls[0]!.headers["X-Shopify-Storefront-Access-Token"]).toBeUndefined();
    expect(calls[0]!.signal).toBeInstanceOf(AbortSignal);
  });

  it("refuses a non-*.myshopify.com host before any request (never leaks the token)", async () => {
    const { fn, calls } = fakeStorefront({ product: node() });
    await expect(
      storefrontProductByHandleFetch(fn)({ shopDomain: "evil.com", accessToken: "shptok_secret" }, "x"),
    ).rejects.toThrow(/myshopify\.com/);
    expect(calls).toHaveLength(0);
  });

  it("throws a STATIC message on a GraphQL error payload (no vendor text) and logs no token", async () => {
    const logs: StorefrontEgressLog[] = [];
    const { fn } = fakeStorefront({ errors: [{ message: "sensitive vendor detail" }] });
    const err = await storefrontProductByHandleFetch(fn, { log: (i) => logs.push(i) })(creds, "x").catch((e) => e as Error);
    expect(err.message).toBe("Shopify Storefront GraphQL error");
    expect(err.message).not.toContain("sensitive vendor detail");
    expect(JSON.stringify(logs)).not.toContain("shptok_secret");
  });
});
