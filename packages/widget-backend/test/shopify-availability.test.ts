import { describe, it, expect } from "vitest";
import { mapStorefrontToContext } from "../src/shopify-grounding.js";

// The Storefront side of grounded availability.
//
// Field verified against primary docs, not memory: `Product.availableForSale: Boolean!` —
// "Indicates if at least one product variant is available for sale" — shopify.dev Storefront API 2026-07,
// retrieved 2026-08-05. The same page documents `ProductVariant.quantityAvailable: Int` as "Token access
// required", which is one of the two reasons we do not request it; the other is that a stock COUNT is the
// raw material for manufactured urgency (§8a inv 11), and a number we never fetch is a number that can
// never be leaked or invented.

const node = (over: Record<string, unknown>) => ({
  id: "gid://shopify/Product/1",
  title: "Serum",
  description: "d",
  priceRange: { minVariantPrice: { amount: "34.00", currencyCode: "USD" } },
  ...over,
});

const mapOne = (over: Record<string, unknown>) =>
  mapStorefrontToContext("demo", { products: { nodes: [node(over)] } } as never).products[0]!;

describe("availableForSale maps through the port as a THREE-STATE value", () => {
  it("true stays true", () => {
    expect(mapOne({ availableForSale: true }).availableForSale).toBe(true);
  });

  it("false stays false — not dropped, because 'unavailable' is a real answer", () => {
    expect(mapOne({ availableForSale: false }).availableForSale).toBe(false);
  });

  it("ABSENT stays undefined — it must never collapse to false", () => {
    // false would make the agent tell shoppers a product is unpurchasable on the strength of a field
    // Shopify simply did not return. undefined routes to "I can't confirm" instead.
    expect(mapOne({}).availableForSale).toBeUndefined();
  });

  it("a non-boolean (null / string / number) is treated as UNKNOWN, not coerced", () => {
    for (const bad of [null, "true", "false", 1, 0, {}, []]) {
      expect(mapOne({ availableForSale: bad }).availableForSale, `coerced ${JSON.stringify(bad)}`).toBeUndefined();
    }
  });

  it("does not introduce a stock count onto the neutral Product", () => {
    // If a future edit requests quantityAvailable, this fails and forces the §8a inv 11 conversation.
    const p = mapOne({ availableForSale: true, quantityAvailable: 2 }) as Record<string, unknown>;
    expect(Object.keys(p)).not.toContain("quantityAvailable");
    expect(JSON.stringify(p)).not.toContain("quantityAvailable");
  });

  it("per-product, not per-catalog — one item's state never bleeds onto another", () => {
    const ctx = mapStorefrontToContext("demo", {
      products: {
        nodes: [
          node({ id: "1", title: "Yes", availableForSale: true }),
          node({ id: "2", title: "No", availableForSale: false }),
          node({ id: "3", title: "Unknown" }),
        ],
      },
    } as never);
    expect(ctx.products.map((p) => p.availableForSale)).toEqual([true, false, undefined]);
  });
});
