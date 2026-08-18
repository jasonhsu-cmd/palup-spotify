import { describe, it, expect, afterEach } from "vitest";
import Fastify from "fastify";
import type { GroundingContext } from "@palup/platform-ports";
import { InMemoryRuntimeStore, createInMemoryMerchantRegistry, createInMemoryVectorStore } from "@palup/platform-ports";
import {
  registerStorefrontCatalogRoutes,
  projectStorefrontCatalog,
  type StorefrontCatalogDeps,
} from "../src/routes/storefront-catalog.js";
import { buildServer } from "../src/server.js";

// WS2 — the public storefront catalog read endpoint. Unit-tested via the injectable registration (no server
// boot needed), plus one buildServer smoke to prove the server.ts wiring.

const CTX: GroundingContext = {
  tenantId: "demo",
  brandName: "Auria",
  policy: { returns: "30-day returns", shipping: "free over $75" },
  products: [
    {
      id: "gid://shopify/Product/1",
      title: "Vitamin-C Serum",
      price: "$34",
      description: "Bright.",
      variantId: "4567",
      handle: "vitamin-c-serum",
      imageUrl: "https://cdn.shopify.com/x.png",
      availableForSale: true,
      tags: ["serum"],
    },
    // No variant + no handle → no cartUrl / productUrl.
    { id: "gid://shopify/Product/2", title: "Sampler", price: "$10", description: "x" },
  ],
};

const baseDeps = (over: Partial<StorefrontCatalogDeps> = {}): StorefrontCatalogDeps => ({
  resolveTenant: async (shop) => (shop === "acme.myshopify.com" ? { ok: true, tenantId: "demo" } : { ok: false }),
  getCatalogPage: async () => ({ context: CTX }),
  shopDomainFor: async () => "acme.myshopify.com",
  allowIp: async () => true,
  allowTenant: async () => true,
  ipKeyFor: () => "ip-1",
  ...over,
});

async function app(over: Partial<StorefrontCatalogDeps> = {}) {
  const a = Fastify();
  registerStorefrontCatalogRoutes(a, baseDeps(over));
  await a.ready();
  return a;
}

describe("GET /storefront/catalog (route unit)", () => {
  it("returns 200 with brand, policy, products; cartUrl/productUrl only when inputs valid", async () => {
    const a = await app();
    const res = await a.inject({ method: "GET", url: "/storefront/catalog?shop=acme.myshopify.com" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    expect(res.headers["cache-control"]).toBe("public, max-age=300, stale-while-revalidate=600");
    expect(res.headers["set-cookie"]).toBeUndefined();
    const body = JSON.parse(res.body);
    expect(body.brandName).toBe("Auria");
    expect(body.policy.returns).toContain("30-day");
    expect(body.products).toHaveLength(2);
    expect(body.products[0]).toMatchObject({
      id: "gid://shopify/Product/1",
      title: "Vitamin-C Serum",
      variantId: "4567",
      handle: "vitamin-c-serum",
      imageUrl: "https://cdn.shopify.com/x.png",
      cartUrl: "https://acme.myshopify.com/cart/4567:1",
      productUrl: "https://acme.myshopify.com/products/vitamin-c-serum",
    });
    expect(body.products[1].cartUrl).toBeUndefined();
    expect(body.products[1].productUrl).toBeUndefined();
    await a.close();
  });

  it("returns a UNIFORM 404 for every non-ok tenant (not an existence oracle)", async () => {
    const a = await app();
    const unknown = await a.inject({ method: "GET", url: "/storefront/catalog?shop=stranger.myshopify.com" });
    const missing = await a.inject({ method: "GET", url: "/storefront/catalog" });
    expect(unknown.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(unknown.body).toBe(missing.body); // identical bytes → no oracle
    expect(JSON.parse(unknown.body)).toEqual({ error: "not found" });
    await a.close();
  });

  it("returns 429 when the per-IP limiter denies", async () => {
    const a = await app({ allowIp: async () => false });
    const res = await a.inject({ method: "GET", url: "/storefront/catalog?shop=acme.myshopify.com" });
    expect(res.statusCode).toBe(429);
    await a.close();
  });

  it("returns 429 when the per-TENANT ceiling denies (denial-of-wallet backstop), checked only after resolve", async () => {
    const denyTenant = { allowTenant: async () => false };
    const a = await app(denyTenant);
    // A known shop is throttled by the tenant ceiling...
    const known = await a.inject({ method: "GET", url: "/storefront/catalog?shop=acme.myshopify.com" });
    expect(known.statusCode).toBe(429);
    // ...but an UNKNOWN shop still 404s (the tenant check runs AFTER resolution, so it can't consume budget
    // for / leak the existence of a tenant that didn't resolve).
    const unknown = await a.inject({ method: "GET", url: "/storefront/catalog?shop=stranger.myshopify.com" });
    expect(unknown.statusCode).toBe(404);
    await a.close();
  });

  it("collapses a THROWING resolver to the uniform 404 (no 500-vs-404 oracle)", async () => {
    const a = await app({ resolveTenant: async () => { throw new Error("registry down"); } });
    const res = await a.inject({ method: "GET", url: "/storefront/catalog?shop=acme.myshopify.com" });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: "not found" });
    await a.close();
  });

  it("re-validates imageUrl at the wire — a non-conforming adapter's bad URL is dropped (defense in depth)", async () => {
    const bad: GroundingContext = {
      tenantId: "demo", brandName: "Auria", policy: { returns: "", shipping: "" },
      products: [{ id: "p1", title: "X", price: "$1", description: "d", imageUrl: "javascript:alert(1)" }],
    };
    const a = await app({ getCatalogPage: async () => ({ context: bad }) });
    const res = await a.inject({ method: "GET", url: "/storefront/catalog?shop=acme.myshopify.com" });
    expect(JSON.parse(res.body).products[0].imageUrl).toBeUndefined();
    await a.close();
  });

  it("a resolvable-but-empty tenant returns 200 with products:[] (honest 'no products', not a 404)", async () => {
    const empty: GroundingContext = { tenantId: "demo", brandName: "Auria", policy: { returns: "", shipping: "" }, products: [] };
    const a = await app({ getCatalogPage: async () => ({ context: empty }) });
    const res = await a.inject({ method: "GET", url: "/storefront/catalog?shop=acme.myshopify.com" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).products).toEqual([]);
    await a.close();
  });

  it("a cold grounding failure degrades to 200 empty catalog (never a 500)", async () => {
    const a = await app({ getCatalogPage: async () => { throw new Error("shopify down"); } });
    const res = await a.inject({ method: "GET", url: "/storefront/catalog?shop=acme.myshopify.com" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.products).toEqual([]);
    expect(body.brandName).toBe("this store");
    await a.close();
  });

  it("omits cartUrl/productUrl when the shop domain is unknown", async () => {
    const a = await app({ shopDomainFor: async () => undefined });
    const res = await a.inject({ method: "GET", url: "/storefront/catalog?shop=acme.myshopify.com" });
    const body = JSON.parse(res.body);
    expect(body.products[0].cartUrl).toBeUndefined();
    expect(body.products[0].productUrl).toBeUndefined();
    await a.close();
  });

  it("paginates: returns nextCursor and forwards ?cursor= to the reader's `after` (durable for any size)", async () => {
    let seenAfter: string | undefined = "UNSET";
    const a = await app({
      getCatalogPage: async (_t, _first, after) => {
        seenAfter = after;
        return { context: CTX, nextCursor: "CURSOR_2" };
      },
    });
    const first = await a.inject({ method: "GET", url: "/storefront/catalog?shop=acme.myshopify.com" });
    expect(JSON.parse(first.body).nextCursor).toBe("CURSOR_2");
    expect(seenAfter).toBeUndefined(); // first page: no cursor
    const next = await a.inject({ method: "GET", url: "/storefront/catalog?shop=acme.myshopify.com&cursor=CURSOR_2" });
    expect(next.statusCode).toBe(200);
    expect(seenAfter).toBe("CURSOR_2"); // the client's cursor is forwarded to Shopify's `after`
    await a.close();
  });

  it("OPTIONS preflight returns 204 with CORS headers", async () => {
    const a = await app();
    const res = await a.inject({ method: "OPTIONS", url: "/storefront/catalog" });
    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    expect(res.headers["access-control-allow-methods"]).toContain("GET");
    await a.close();
  });
});

describe("projectStorefrontCatalog (pure)", () => {
  it("builds cart/product URLs only for products that have the inputs", () => {
    const out = projectStorefrontCatalog(CTX, "acme.myshopify.com");
    expect(out.products[0].cartUrl).toBe("https://acme.myshopify.com/cart/4567:1");
    expect(out.products[1].cartUrl).toBeUndefined();
  });
  it("no shop domain → no URLs at all", () => {
    const out = projectStorefrontCatalog(CTX, undefined);
    expect(out.products.every((p) => p.cartUrl === undefined && p.productUrl === undefined)).toBe(true);
  });
});

// ── buildServer wiring smoke — proves the route is registered + resolves via the real merchants/grounding.
const ENV = ["WIDGET_EMBED_KEYS", "SHOPIFY_STORES", "WIDGET_TOKEN_SECRET"];
afterEach(() => ENV.forEach((k) => delete process.env[k]));

describe("GET /storefront/catalog (buildServer wiring)", () => {
  it("is wired: 200 + products array + cache header for a known shop, uniform 404 for an unknown one", async () => {
    process.env.WIDGET_EMBED_KEYS = '{"demo-embed-key":"demo"}';
    process.env.SHOPIFY_STORES = '{"demo":"acme.myshopify.com"}';
    process.env.WIDGET_TOKEN_SECRET = "widget-signing-secret";
    const server = await buildServer({
      store: new InMemoryRuntimeStore(),
      merchantRegistry: createInMemoryMerchantRegistry(),
      vectorPort: createInMemoryVectorStore(),
    });
    try {
      const ok = await server.inject({ method: "GET", url: "/storefront/catalog?shop=acme.myshopify.com" });
      expect(ok.statusCode).toBe(200);
      expect(Array.isArray(JSON.parse(ok.body).products)).toBe(true);
      expect(String(ok.headers["cache-control"] || "")).toContain("max-age=300");
      const bad = await server.inject({ method: "GET", url: "/storefront/catalog?shop=stranger.myshopify.com" });
      expect(bad.statusCode).toBe(404);
    } finally {
      await server.close();
    }
  });
});
