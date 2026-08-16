import { describe, it, expect } from "vitest";
import { productIdOf } from "../src/shopify-webhook-identity.js";

// S3 §C — `productIdOf` extracts the changed product's numeric id from a VERIFIED `products/*` webhook
// body, same numeric discipline as `customerIdOf`/`dataRequestIdOf`: refuse rather than coerce, so a
// hostile or malformed value can never be interpolated into a corpus record id or a Storefront GID.

describe("S3 §C — productIdOf: the numeric product id from a products/* body", () => {
  it("reads a numeric id", () => {
    expect(productIdOf({ id: 7880321196 } as Record<string, unknown>)).toBe("7880321196");
  });
  it("reads an all-digits string id", () => {
    expect(productIdOf({ id: "12345" } as Record<string, unknown>)).toBe("12345");
  });
  it("refuses a float, a GID, an object, null, or empty (never coerces)", () => {
    expect(productIdOf({ id: 1.5 } as Record<string, unknown>)).toBeUndefined();
    expect(productIdOf({ id: "gid://shopify/Product/1" } as Record<string, unknown>)).toBeUndefined();
    expect(productIdOf({ id: {} } as Record<string, unknown>)).toBeUndefined();
    expect(productIdOf({ id: null } as Record<string, unknown>)).toBeUndefined();
    expect(productIdOf({} as Record<string, unknown>)).toBeUndefined();
  });
  it("refuses a number beyond Number.MAX_SAFE_INTEGER — same discipline as customerIdOf: a value that " +
    "already lost precision on the way in must never be coerced into a KV/corpus key", () => {
    // 788032119674292922 (shopify.dev's own oversized sample id) is already rounded to
    // 788032119674292900 by the time it is a JS `number` — refusing rather than trusting the rounded
    // value is the correct call: silently returning the wrong digits would misidentify a product.
    expect(productIdOf({ id: 788032119674292922 } as Record<string, unknown>)).toBeUndefined();
  });
});
