import { describe, it, expect } from "vitest";
import { createCartPermalinkAdapter } from "../src/cart-permalink-adapter.js";
import { MAX_PERMALINK_QTY } from "../src/cart-permalink.js";

// Pillar 2a — multi-line checkout-permalink CartPort adapter. Builds
// `https://<shopDomain>/cart/<v1>:<q1>,<v2>:<q2>,...` — a Shopify `/cart/` deep link the shopper opens
// to complete checkout on Shopify (no new scope, no add-to-cart I/O, no fetch). Reuses the SHOP_HOST /
// variantNumericId / MAX_PERMALINK_QTY validators from cart-permalink.ts rather than re-deriving them.

describe("createCartPermalinkAdapter", () => {
  const adapter = createCartPermalinkAdapter("shop.myshopify.com");

  it("builds a multi-line permalink for two valid lines", async () => {
    const result = await adapter.createCheckout([
      { variantId: "111", quantity: 2 },
      { variantId: "222", quantity: 1 },
    ]);
    expect(result).toEqual({ checkoutUrl: "https://shop.myshopify.com/cart/111:2,222:1" });
  });

  it("resolves a ProductVariant GID to its numeric id", async () => {
    const result = await adapter.createCheckout([{ variantId: "gid://shopify/ProductVariant/333", quantity: 1 }]);
    expect(result).toEqual({ checkoutUrl: "https://shop.myshopify.com/cart/333:1" });
  });

  it("drops an invalid-variant line but keeps the valid ones, preserving order", async () => {
    const result = await adapter.createCheckout([
      { variantId: "111", quantity: 1 },
      { variantId: "gid://shopify/Product/999", quantity: 1 }, // Product GID, not Variant — invalid
      { variantId: "222", quantity: 3 },
    ]);
    expect(result).toEqual({ checkoutUrl: "https://shop.myshopify.com/cart/111:1,222:3" });
  });

  it("clamps a quantity above MAX_PERMALINK_QTY down to the cap", async () => {
    const result = await adapter.createCheckout([{ variantId: "111", quantity: MAX_PERMALINK_QTY + 50 }]);
    expect(result).toEqual({ checkoutUrl: `https://shop.myshopify.com/cart/111:${MAX_PERMALINK_QTY}` });
  });

  it("drops a line with a sub-1 or non-integer quantity, mirroring cart-permalink.ts's refusal", async () => {
    const result = await adapter.createCheckout([
      { variantId: "111", quantity: 0 },
      { variantId: "222", quantity: 1.5 },
      { variantId: "333", quantity: 2 },
    ]);
    expect(result).toEqual({ checkoutUrl: "https://shop.myshopify.com/cart/333:2" });
  });

  it("returns null when every line is invalid", async () => {
    const result = await adapter.createCheckout([
      { variantId: "not-an-id", quantity: 1 },
      { variantId: "222", quantity: 0 },
    ]);
    expect(result).toBeNull();
  });

  it("returns null for empty lines", async () => {
    const result = await adapter.createCheckout([]);
    expect(result).toBeNull();
  });

  it("returns null for a bad / non-Shopify shop host", async () => {
    const evil = createCartPermalinkAdapter("evil.example.com");
    const result = await evil.createCheckout([{ variantId: "111", quantity: 1 }]);
    expect(result).toBeNull();
  });

  it("still works for a single line (parity with cartPermalink)", async () => {
    const result = await adapter.createCheckout([{ variantId: "12", quantity: 1 }]);
    expect(result).toEqual({ checkoutUrl: "https://shop.myshopify.com/cart/12:1" });
  });
});
