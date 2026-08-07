import { describe, it, expect } from "vitest";
import { cartPermalink, variantNumericId, MAX_PERMALINK_QTY } from "../src/cart-permalink.js";

// C1 — cart permalink builder. Pure/fail-safe: correct link for valid input, undefined (never a
// malformed or cross-origin URL) for anything invalid. Generates a link only — never a purchase.

describe("variantNumericId", () => {
  it("extracts the numeric id from a ProductVariant GID", () => {
    expect(variantNumericId("gid://shopify/ProductVariant/4567")).toBe("4567");
  });
  it("passes through an already-numeric id", () => {
    expect(variantNumericId("4567")).toBe("4567");
  });
  it("returns undefined for a Product (not Variant) GID or junk", () => {
    expect(variantNumericId("gid://shopify/Product/4567")).toBeUndefined();
    expect(variantNumericId("not-an-id")).toBeUndefined();
    expect(variantNumericId("")).toBeUndefined();
  });
});

describe("cartPermalink", () => {
  it("builds the pre-filled cart link for a valid store + variant", () => {
    expect(cartPermalink("palup-skincare-jason.myshopify.com", "gid://shopify/ProductVariant/4567", 2)).toBe(
      "https://palup-skincare-jason.myshopify.com/cart/4567:2",
    );
  });
  it("defaults quantity to 1", () => {
    expect(cartPermalink("shop.myshopify.com", "12")).toBe("https://shop.myshopify.com/cart/12:1");
  });
  it("refuses a non-Shopify / attacker host (no cross-origin link)", () => {
    expect(cartPermalink("evil.example.com", "12", 1)).toBeUndefined();
    expect(cartPermalink("shop.myshopify.com.evil.com", "12", 1)).toBeUndefined();
  });
  it("refuses a non-numeric / absent variant id", () => {
    expect(cartPermalink("shop.myshopify.com", "gid://shopify/Product/12", 1)).toBeUndefined();
    expect(cartPermalink("shop.myshopify.com", "", 1)).toBeUndefined();
  });
  it("refuses an out-of-range quantity", () => {
    expect(cartPermalink("shop.myshopify.com", "12", 0)).toBeUndefined();
    expect(cartPermalink("shop.myshopify.com", "12", MAX_PERMALINK_QTY + 1)).toBeUndefined();
    expect(cartPermalink("shop.myshopify.com", "12", 1.5)).toBeUndefined();
  });
});
