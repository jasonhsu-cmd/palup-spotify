import { describe, it, expect } from "vitest";
import { productIdOf } from "../src/shopify-webhook-identity.js";
import { SHOPIFY_PRODUCT_GID_PREFIX } from "../src/catalog-webhook-queue.js";

// S3 §C — `productIdOf` extracts the changed product's id from a VERIFIED `products/*` webhook body, same
// refuse-rather-than-coerce discipline as `customerIdOf`/`dataRequestIdOf`.
//
// FIX ROUND 2 — id FORMAT (supersedes fix round 1's "return the bare numeric id" ruling). The corpus/ledger
// record key is `product:<FULL-GID>`, and the by-id fetch (`nodes(ids:)`) requires a GID, not a bare
// number — so this function now returns the FULL `"gid://shopify/Product/<id>"` string end-to-end, never a
// bare numeric string. Precision is unchanged: the numeric `id` (a JSON number, already lossy for a large
// id — JSON.parse/the JS number type round anything beyond Number.MAX_SAFE_INTEGER before this function
// ever runs) is read only as a last-resort fallback, and `admin_graphql_api_id` (a GID STRING, never
// subject to float64 rounding) is read FIRST and returned VERBATIM.

describe("S3 §C — productIdOf: the changed product's full GID from a products/* body", () => {
  it("reads the FULL GID from admin_graphql_api_id verbatim, even when a numeric id is also present", () => {
    expect(
      productIdOf({ id: 7, admin_graphql_api_id: "gid://shopify/Product/7" } as Record<string, unknown>),
    ).toBe("gid://shopify/Product/7");
  });

  it("reads a realistic 13-digit id delivered via admin_graphql_api_id, as the full GID", () => {
    expect(
      productIdOf({ admin_graphql_api_id: "gid://shopify/Product/8258451439839" } as Record<string, unknown>),
    ).toBe("gid://shopify/Product/8258451439839");
  });

  it("preserves an OVERSIZED (18-digit, beyond Number.MAX_SAFE_INTEGER) id EXACTLY via the GID string", () => {
    // This is the property fix round 1 exists for, still true under fix round 2's full-GID return. If this
    // read the numeric `id` field instead, the JS number would already have rounded
    // 788032119674292922 to 788032119674292900 by the time this function runs — verified this session:
    // `Number(788032119674292922) === 788032119674292900` — so an implementation reading the numeric
    // field CANNOT return the exact original digits here; only reading the GID STRING VERBATIM can.
    expect(
      productIdOf({ id: 1, admin_graphql_api_id: "gid://shopify/Product/788032119674292922" } as Record<string, unknown>),
    ).toBe("gid://shopify/Product/788032119674292922");
  });

  it("falls back to a CONSTRUCTED GID from the numeric id when admin_graphql_api_id is absent", () => {
    expect(productIdOf({ id: 7880321196 } as Record<string, unknown>)).toBe(`${SHOPIFY_PRODUCT_GID_PREFIX}7880321196`);
  });

  it("falls back to a CONSTRUCTED GID from an all-digits string id when admin_graphql_api_id is absent", () => {
    expect(productIdOf({ id: "12345" } as Record<string, unknown>)).toBe(`${SHOPIFY_PRODUCT_GID_PREFIX}12345`);
  });

  it("refuses a float, a GID as the `id` field, an object, null, or empty (never coerces)", () => {
    expect(productIdOf({ id: 1.5 } as Record<string, unknown>)).toBeUndefined();
    expect(productIdOf({ id: "gid://shopify/Product/1" } as Record<string, unknown>)).toBeUndefined();
    expect(productIdOf({ id: {} } as Record<string, unknown>)).toBeUndefined();
    expect(productIdOf({ id: null } as Record<string, unknown>)).toBeUndefined();
    expect(productIdOf({} as Record<string, unknown>)).toBeUndefined();
  });

  it("refuses a malformed admin_graphql_api_id (wrong resource type / no trailing digits) and does not fall through to a bad numeric id", () => {
    expect(productIdOf({ admin_graphql_api_id: "gid://shopify/Collection/7" } as Record<string, unknown>)).toBeUndefined();
    expect(productIdOf({ admin_graphql_api_id: "gid://shopify/Product/abc" } as Record<string, unknown>)).toBeUndefined();
    expect(productIdOf({ admin_graphql_api_id: "not-a-gid" } as Record<string, unknown>)).toBeUndefined();
  });

  it("refuses the FALLBACK numeric id when it is beyond Number.MAX_SAFE_INTEGER and no GID is present — " +
    "same discipline as customerIdOf: a value that already lost precision on the way in must never be " +
    "coerced into a KV/corpus key", () => {
    // 788032119674292922 is already rounded to 788032119674292900 by the time it is a JS `number`
    // (verified this session in a Node REPL) — refusing rather than trusting the rounded value is the
    // correct call when there is no precision-safe GID to fall back on.
    expect(productIdOf({ id: 788032119674292922 } as Record<string, unknown>)).toBeUndefined();
  });
});
