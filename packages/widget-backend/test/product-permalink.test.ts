import { describe, it, expect } from "vitest";
import { productPermalink } from "../src/product-permalink.js";

// WS2 — pure, fail-safe product-page permalink builder (sibling of cart-permalink). Any invalid input →
// undefined, never a malformed or cross-origin URL (the link is shown to a shopper).
describe("productPermalink", () => {
  it("builds a canonical product URL for a valid shop + handle", () => {
    expect(productPermalink("acme.myshopify.com", "vitamin-c-serum")).toBe(
      "https://acme.myshopify.com/products/vitamin-c-serum",
    );
  });

  it("rejects a non-Shopify / malformed shop host", () => {
    expect(productPermalink("evil.example.com", "serum")).toBeUndefined();
    expect(productPermalink("acme.myshopify.com.evil.com", "serum")).toBeUndefined();
    expect(productPermalink("", "serum")).toBeUndefined();
  });

  it("rejects an empty, illegal, or overlong handle (never a smuggled path/host)", () => {
    expect(productPermalink("acme.myshopify.com", "")).toBeUndefined();
    expect(productPermalink("acme.myshopify.com", "bad/slug")).toBeUndefined();
    expect(productPermalink("acme.myshopify.com", "space serum")).toBeUndefined();
    expect(productPermalink("acme.myshopify.com", "../../admin")).toBeUndefined();
    expect(productPermalink("acme.myshopify.com", "x".repeat(201))).toBeUndefined();
  });

  it("trims surrounding whitespace on the handle", () => {
    expect(productPermalink("acme.myshopify.com", "  serum  ")).toBe("https://acme.myshopify.com/products/serum");
  });
});
