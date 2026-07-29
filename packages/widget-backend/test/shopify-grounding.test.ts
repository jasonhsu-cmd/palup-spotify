import { describe, it, expect } from "vitest";
import { mapStorefrontToContext, createShopifyGroundingAdapter, type StorefrontData } from "../src/shopify-grounding.js";

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

  it("the DEFAULT live fetch is not implemented — it rejects (we never ship a guessed network call)", async () => {
    const adapter = createShopifyGroundingAdapter({ shopDomain: "acme.myshopify.com", accessToken: "tok" });
    await expect(adapter.getContext("acme")).rejects.toThrow(/not implemented/i);
  });
});
