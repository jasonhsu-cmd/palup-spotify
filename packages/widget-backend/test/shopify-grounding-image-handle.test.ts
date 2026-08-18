import { describe, it, expect } from "vitest";
import {
  mapStorefrontToContext,
  PRODUCT_PAGE_FIELDS,
  STOREFRONT_NODES_QUERY,
} from "../src/shopify-grounding.js";

// WS1 — the Shopify adapter maps `featuredImage.url` + `handle` onto the opaque neutral
// Product.imageUrl/handle for the storefront render + product-card thumbnail. Display-only, and
// host/charset-validated at the adapter so a compromised/injected Storefront response can never smuggle a
// `javascript:`/`http:`/arbitrary-host image URL onto a shopper's page. `featuredImage`/`handle` were added
// to the query after the 2026-07-31 live check, so this mock-tests the mapping + validation deterministically.
type Data = Parameters<typeof mapStorefrontToContext>[1];

const node = (extra: Record<string, unknown>): Data => ({
  products: { nodes: [{ id: "gid://shopify/Product/1", title: "Serum", ...extra }] },
}) as Data;

describe("WS1 — Storefront → Product.imageUrl / handle", () => {
  it("maps a Shopify-CDN https image URL and a valid handle", () => {
    const p = mapStorefrontToContext("t", node({
      featuredImage: { url: "https://cdn.shopify.com/s/files/1/img/serum.png", altText: "Serum" },
      handle: "vitamin-c-serum",
    })).products[0]!;
    expect(p.imageUrl).toBe("https://cdn.shopify.com/s/files/1/img/serum.png");
    expect(p.handle).toBe("vitamin-c-serum");
  });

  it("accepts legacy shopifycdn.net and per-shop myshopify.com image hosts", () => {
    expect(mapStorefrontToContext("t", node({
      featuredImage: { url: "https://abc.shopifycdn.net/x.jpg" },
    })).products[0]!.imageUrl).toBe("https://abc.shopifycdn.net/x.jpg");
    expect(mapStorefrontToContext("t", node({
      featuredImage: { url: "https://palup-skincare-jason.myshopify.com/x.jpg" },
    })).products[0]!.imageUrl).toBe("https://palup-skincare-jason.myshopify.com/x.jpg");
  });

  it("drops a non-Shopify host, http, or javascript: image URL (never a rendered unsafe src)", () => {
    for (const url of [
      "https://evil.example.com/x.png",
      "http://cdn.shopify.com/x.png", // not https
      "javascript:alert(1)//cdn.shopify.com",
      "//cdn.shopify.com/x.png", // protocol-relative, not absolute https
      "not a url",
    ]) {
      expect(mapStorefrontToContext("t", node({ featuredImage: { url } })).products[0]!.imageUrl).toBeUndefined();
    }
  });

  it("leaves imageUrl undefined when featuredImage is null or absent", () => {
    expect(mapStorefrontToContext("t", node({ featuredImage: null })).products[0]!.imageUrl).toBeUndefined();
    expect(mapStorefrontToContext("t", node({})).products[0]!.imageUrl).toBeUndefined();
  });

  it("drops a malformed handle (spaces / illegal chars / overlong)", () => {
    for (const handle of ["not a handle", "bad/slug", "space serum", "x".repeat(201)]) {
      expect(mapStorefrontToContext("t", node({ handle })).products[0]!.handle).toBeUndefined();
    }
    expect(mapStorefrontToContext("t", node({})).products[0]!.handle).toBeUndefined();
  });

  it("does not put image/handle on other fields (existing mapping unaffected)", () => {
    const p = mapStorefrontToContext("t", node({
      priceRange: { minVariantPrice: { amount: "34.00", currencyCode: "USD" } },
      featuredImage: { url: "https://cdn.shopify.com/x.png" },
      handle: "serum",
    })).products[0]!;
    expect(p.price).toBe("$34.00");
    expect(p.title).toBe("Serum");
  });
});

describe("WS1 — the Storefront queries request the render fields", () => {
  it("PRODUCT_PAGE_FIELDS (both paged queries) selects featuredImage + handle", () => {
    expect(PRODUCT_PAGE_FIELDS).toContain("handle");
    expect(PRODUCT_PAGE_FIELDS).toContain("featuredImage { url altText }");
  });
  it("STOREFRONT_NODES_QUERY (by-id path) selects featuredImage + handle", () => {
    expect(STOREFRONT_NODES_QUERY).toContain("handle");
    expect(STOREFRONT_NODES_QUERY).toContain("featuredImage { url altText }");
  });
});
