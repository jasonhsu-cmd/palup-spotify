import { describe, it, expect } from "vitest";
import { mapStorefrontToContext } from "../src/shopify-grounding.js";

// C1 — the Shopify adapter maps the first variant's GID to the opaque neutral Product.variantId (numeric).
// The widget builds the cart URL from it; no Shopify URL crosses the port. `variants` is not live-verified
// (added post the 2026-07-31 check), so this mock-tests the extraction deterministically.
type Data = Parameters<typeof mapStorefrontToContext>[1];

describe("C1 — Storefront → Product.variantId", () => {
  it("extracts the numeric variant id from the first variant's GID", () => {
    const data = {
      products: {
        nodes: [
          { id: "gid://shopify/Product/1", title: "Serum", variants: { nodes: [{ id: "gid://shopify/ProductVariant/4567" }] } },
        ],
      },
    } as Data;
    expect(mapStorefrontToContext("t", data).products[0]!.variantId).toBe("4567");
  });

  it("leaves variantId undefined when the node reports no variant", () => {
    const data = { products: { nodes: [{ id: "gid://shopify/Product/1", title: "Serum" }] } } as Data;
    expect(mapStorefrontToContext("t", data).products[0]!.variantId).toBeUndefined();
  });

  it("ignores a non-ProductVariant / junk gid (never a wrong cart id)", () => {
    const data = {
      products: {
        nodes: [{ id: "gid://shopify/Product/1", title: "Serum", variants: { nodes: [{ id: "gid://shopify/Product/999" }] } }],
      },
    } as Data;
    expect(mapStorefrontToContext("t", data).products[0]!.variantId).toBeUndefined();
  });
});
