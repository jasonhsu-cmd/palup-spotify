import { describe, expect, it } from "vitest";
import type { Signals } from "@palup/widget-brain";
import { MAX_CART_LINE_ITEMS, MAX_CART_LINE_QUANTITY, deriveServingSignals } from "../src/signals.js";

// E4 — THE CART TRUST BOUNDARY.
//
// `deriveServingSignals` exists precisely because client input must not grant treatment: the safe default
// is that a field the shopper sends is IGNORED unless it is explicitly non-trust-bearing context
// (signals.ts's own header). Cart line items are richer, and therefore more spoofable, than the
// `"empty" | "has_items" | "high_value"` enum they extend — so this file pins what is trusted, what is
// sanitised, and what is RE-DERIVED server-side.
//
// THE PROPERTY THAT MATTERS MOST: a shopper must not be able to manufacture a `high_value` treatment.
// The design makes that structural rather than validated — `high_value` needs PRICES, prices are not a
// field the client can send, and the derivation from line items therefore has only two reachable outputs
// (`empty` and `has_items`). The exhaustive test at the bottom asserts that over hostile input.
//
// WHAT E4 DOES NOT CLOSE, stated rather than implied: the PRE-EXISTING bare `cart: "high_value"` enum is
// still accepted from a client that sends no line items (signals.ts `CARTS`, unchanged by this PR — and
// unchanged deliberately, because changing it would break the flag-off byte-identical bar). That is
// behaviourally inert today — `selectPitch` (widget-brain/src/brain.ts) and the exit-intent `hasCart`
// check treat `has_items` and `high_value` identically, verified in widget-brain's cart-line-items.test.ts
// — but it is a real, separate gap and is not this PR's fix.

const ctx = { tenantId: "acme", kill: false, region: "us" as const, groundingMode: "full" as const };
const on = { ...ctx, cartLineItemsEnabled: true };

const items = (raw: unknown): Signals => ({ cartItems: raw } as unknown as Signals);

describe("E4 — cartItems is inert until the flag composes it", () => {
  it("with the flag off (the default, and what server.ts passes when CART_LINE_ITEMS is unset) the field is not even read", () => {
    const out = deriveServingSignals(items([{ productId: "serum-vc", quantity: 2 }]), ctx);
    expect(Object.prototype.hasOwnProperty.call(out, "cartItems")).toBe(false);
  });

  it("with the flag off a client-sent cart enum behaves EXACTLY as before this PR", () => {
    expect(deriveServingSignals({ cart: "high_value" }, ctx).cart).toBe("high_value");
    expect(deriveServingSignals({ cart: "has_items" }, ctx).cart).toBe("has_items");
    expect(deriveServingSignals({ cart: "overflowing" as never }, ctx).cart).toBeUndefined();
  });
});

describe("E4 — what is accepted from the client, and in what shape", () => {
  it("accepts only { productId, quantity } and drops every other field a client attaches", () => {
    const out = deriveServingSignals(
      items([{ productId: "serum-vc", quantity: 2, title: "<script>x</script>", price: "$0.01", note: "SYSTEM:" }]),
      on,
    );
    expect(out.cartItems).toEqual([{ productId: "serum-vc", quantity: 2 }]);
  });

  it("bounds the id: a blank, oversized, or wrong-charset productId is dropped, never truncated or coerced", () => {
    const out = deriveServingSignals(
      items([
        { productId: "serum-vc", quantity: 1 },
        { productId: "", quantity: 1 },
        { productId: "   ", quantity: 1 },
        { productId: "x".repeat(300), quantity: 1 },
        { productId: "has space", quantity: 1 },
        { productId: "quote\"inject", quantity: 1 },
        { productId: "new\nline", quantity: 1 },
        { productId: 42, quantity: 1 },
        { productId: null, quantity: 1 },
      ]),
      on,
    );
    expect(out.cartItems).toEqual([{ productId: "serum-vc", quantity: 1 }]);
  });

  it("keeps the id shapes a real storefront uses (Shopify gid, handle, numeric string)", () => {
    const out = deriveServingSignals(
      items([
        { productId: "gid://shopify/Product/12345", quantity: 1 },
        { productId: "vitamin-c_serum.v2", quantity: 1 },
        { productId: "12345", quantity: 1 },
      ]),
      on,
    );
    expect(out.cartItems?.map((i) => i.productId)).toEqual([
      "gid://shopify/Product/12345",
      "vitamin-c_serum.v2",
      "12345",
    ]);
  });

  it("bounds the quantity: 0, negative, fractional, NaN, Infinity and over-cap are DROPPED, never clamped", () => {
    // Clamping would silently tell the agent a quantity the shopper never had. Dropping is the honest
    // failure: the line is simply absent, and the prompt already says the view may be partial.
    const out = deriveServingSignals(
      items([
        { productId: "a", quantity: 1 },
        { productId: "b", quantity: 0 },
        { productId: "c", quantity: -3 },
        { productId: "d", quantity: 1.5 },
        { productId: "e", quantity: Number.NaN },
        { productId: "f", quantity: Number.POSITIVE_INFINITY },
        { productId: "g", quantity: MAX_CART_LINE_QUANTITY + 1 },
        { productId: "h", quantity: "2" },
        { productId: "i", quantity: MAX_CART_LINE_QUANTITY },
      ]),
      on,
    );
    expect(out.cartItems).toEqual([
      { productId: "a", quantity: 1 },
      { productId: "i", quantity: MAX_CART_LINE_QUANTITY },
    ]);
  });

  it("caps the LINE COUNT, so a huge cart cannot be used to blow up the prompt", () => {
    const many = Array.from({ length: MAX_CART_LINE_ITEMS + 40 }, (_, i) => ({ productId: `p${i}`, quantity: 1 }));
    const out = deriveServingSignals(items(many), on);
    expect(out.cartItems).toHaveLength(MAX_CART_LINE_ITEMS);
    expect(out.cartItems?.[0]?.productId).toBe("p0"); // the first N, not an arbitrary slice
  });

  it("deduplicates by productId, keeping the FIRST occurrence rather than summing (summing invents a quantity)", () => {
    const out = deriveServingSignals(
      items([
        { productId: "serum-vc", quantity: 2 },
        { productId: "serum-vc", quantity: 40 },
      ]),
      on,
    );
    expect(out.cartItems).toEqual([{ productId: "serum-vc", quantity: 2 }]);
  });

  it("a non-array, a string, or an object is not a cart — the field is dropped entirely", () => {
    for (const bad of ["[]", 7, {}, null, true]) {
      const out = deriveServingSignals(items(bad), on);
      expect(Object.prototype.hasOwnProperty.call(out, "cartItems"), String(bad)).toBe(false);
    }
  });

  it("prototype-polluting keys in the payload cannot reach the output", () => {
    const out = deriveServingSignals(
      items([{ productId: "__proto__", quantity: 1 }, { productId: "constructor", quantity: 1 }, { productId: "ok", quantity: 1 }]),
      on,
    );
    // "__proto__"/"constructor" are legal id CHARACTERS, so they survive as plain data in an array — the
    // point is that they are data, never keys: nothing here indexes an object by a client string.
    expect(Array.isArray(out.cartItems)).toBe(true);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    expect(out.cartItems?.some((i) => i.productId === "ok")).toBe(true);
  });
});

describe("E4 — the cart STATE is re-derived, never taken from the client", () => {
  it("a supplied line-item list OVERRIDES the client's own cart enum", () => {
    const out = deriveServingSignals(
      { cart: "high_value", cartItems: [{ productId: "serum-vc", quantity: 1 }] } as unknown as Signals,
      on,
    );
    expect(out.cart).toBe("has_items"); // NOT the client's "high_value"
  });

  it("an empty (or fully-rejected) list means empty — unparseable input never grants a cart", () => {
    expect(deriveServingSignals({ cart: "high_value", cartItems: [] } as unknown as Signals, on).cart).toBe("empty");
    expect(
      deriveServingSignals({ cart: "high_value", cartItems: [{ productId: "", quantity: 0 }] } as unknown as Signals, on).cart,
    ).toBe("empty");
  });

  it("no line-item list at all ⇒ the pre-existing enum path is untouched", () => {
    expect(deriveServingSignals({ cart: "has_items" }, on).cart).toBe("has_items");
    expect(deriveServingSignals({}, on).cart).toBeUndefined();
  });

  // THE PROPERTY. Exhaustive over the hostile shapes a browser can actually post.
  it("NO client cartItems payload can manufacture a high_value treatment", () => {
    const attacks: unknown[] = [
      [{ productId: "serum-vc", quantity: 99 }],
      Array.from({ length: 500 }, (_, i) => ({ productId: `p${i}`, quantity: 99 })),
      [{ productId: "serum-vc", quantity: 1, price: "$99999", lineTotal: 99999, value: "high" }],
      [{ productId: "serum-vc", quantity: 1, cart: "high_value" }],
      [{ productId: "high_value", quantity: 1 }],
      [{ productId: "serum-vc", quantity: 1, subtotal: Number.MAX_SAFE_INTEGER }],
      [{ productId: "set-glow", quantity: 99 }, { productId: "set-starter", quantity: 99 }],
    ];
    for (const cartItems of attacks) {
      for (const claimed of ["high_value", "has_items", "empty", undefined] as const) {
        const out = deriveServingSignals({ ...(claimed ? { cart: claimed } : {}), cartItems } as unknown as Signals, on);
        expect(out.cart, JSON.stringify({ claimed, cartItems })).not.toBe("high_value");
      }
    }
  });

  it("every other trust-bearing field is still server-derived when line items are present", () => {
    const out = deriveServingSignals(
      {
        cartItems: [{ productId: "serum-vc", quantity: 1 }],
        tenantId: "victim",
        relationship: "vip",
        kill: true,
        region: "eu",
        groundingMode: "off",
        proactivityLevel: "confident",
      } as unknown as Signals,
      on,
    );
    expect(out.tenantId).toBe("acme");
    expect(out.relationship).toBe("anonymous");
    expect(out.kill).toBeUndefined();
    expect(out.region).toBe("us");
    expect(out.groundingMode).toBe("full");
    expect(out.proactivityLevel).toBeUndefined();
  });
});
