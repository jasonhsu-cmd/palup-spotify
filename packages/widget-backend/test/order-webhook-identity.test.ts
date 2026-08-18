import { describe, it, expect } from "vitest";
import {
  JOIN_TOKEN_NOTE_ATTRIBUTE,
  ORDER_TOPICS,
  REFUND_TOPIC,
  joinTokenOf,
  matchesPayloadShape,
  orderCurrencyOf,
  orderNumericIdOf,
  orderTotalOf,
  refundCurrencyOf,
  refundOrderIdOf,
  refundedAmountOf,
} from "../src/shopify-webhook-identity.js";

// W2-C — the Order/Refund extraction helpers + the PAYLOAD_SHAPES entries that discriminate the three
// new topics from every existing one (and from each other). Mirrors shopify-webhook-identity.test.ts's
// own style for productIdOf: pure functions over a verified body, refuse-rather-than-coerce.

const orderBody = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 450789469,
  note_attributes: [{ name: JOIN_TOKEN_NOTE_ATTRIBUTE, value: "tok_abc123" }],
  total_price: "409.94",
  currency: "USD",
  customer: { id: 191167 },
  ...over,
});

const refundBody = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 209908758,
  order_id: 450789469,
  transactions: [{ amount: "10.00", currency: "USD" }],
  ...over,
});

describe("orderNumericIdOf", () => {
  it("reads the bare numeric order id as a decimal string", () => {
    expect(orderNumericIdOf(orderBody())).toBe("450789469");
  });
  it("accepts an all-digits string id", () => {
    expect(orderNumericIdOf({ id: "450789469" })).toBe("450789469");
  });
  it("refuses a float, a negative, an object, null, or absent id", () => {
    expect(orderNumericIdOf({ id: 1.5 })).toBeUndefined();
    expect(orderNumericIdOf({ id: -1 })).toBeUndefined();
    expect(orderNumericIdOf({ id: {} })).toBeUndefined();
    expect(orderNumericIdOf({ id: null })).toBeUndefined();
    expect(orderNumericIdOf({})).toBeUndefined();
  });
  it("refuses an id beyond Number.MAX_SAFE_INTEGER (already lost precision) rather than coercing it", () => {
    expect(orderNumericIdOf({ id: 788032119674292922 })).toBeUndefined();
  });
});

describe("refundOrderIdOf — the SAME key space as orderNumericIdOf, read from `order_id`", () => {
  it("reads the parent order id as a decimal string", () => {
    expect(refundOrderIdOf(refundBody())).toBe("450789469");
    // Same order, extracted from the two different bodies, must produce the IDENTICAL key.
    expect(refundOrderIdOf(refundBody())).toBe(orderNumericIdOf(orderBody()));
  });
  it("refuses a malformed order_id", () => {
    expect(refundOrderIdOf({ order_id: -1 })).toBeUndefined();
    expect(refundOrderIdOf({ order_id: "abc" })).toBeUndefined();
    expect(refundOrderIdOf({})).toBeUndefined();
  });
});

describe("joinTokenOf — the opaque token from note_attributes", () => {
  it("reads the token when the note attribute is present", () => {
    expect(joinTokenOf(orderBody())).toBe("tok_abc123");
  });
  it("is undefined when note_attributes is absent, empty, or names a different attribute", () => {
    expect(joinTokenOf({})).toBeUndefined();
    expect(joinTokenOf({ note_attributes: [] })).toBeUndefined();
    expect(joinTokenOf({ note_attributes: [{ name: "gift_message", value: "hi" }] })).toBeUndefined();
  });
  it("refuses a malformed entry (not an array, entries not objects, blank value) rather than crashing or coercing", () => {
    expect(joinTokenOf({ note_attributes: "not-an-array" })).toBeUndefined();
    expect(joinTokenOf({ note_attributes: [null, "x", 5] })).toBeUndefined();
    expect(joinTokenOf({ note_attributes: [{ name: JOIN_TOKEN_NOTE_ATTRIBUTE, value: "   " }] })).toBeUndefined();
    expect(joinTokenOf({ note_attributes: [{ name: JOIN_TOKEN_NOTE_ATTRIBUTE, value: 5 }] })).toBeUndefined();
  });
});

describe("orderTotalOf / orderCurrencyOf", () => {
  it("parses the decimal-string total_price to a number", () => {
    expect(orderTotalOf(orderBody())).toBe(409.94);
  });
  it("accepts a numeric total_price too, defensively", () => {
    expect(orderTotalOf({ total_price: 10 })).toBe(10);
  });
  it("refuses a missing, negative, or non-numeric total_price — never coerces to 0", () => {
    expect(orderTotalOf({})).toBeUndefined();
    expect(orderTotalOf({ total_price: "-5.00" })).toBeUndefined();
    expect(orderTotalOf({ total_price: "abc" })).toBeUndefined();
  });
  it("reads a 3-letter uppercase currency code", () => {
    expect(orderCurrencyOf(orderBody())).toBe("USD");
  });
  it("refuses a malformed currency", () => {
    expect(orderCurrencyOf({ currency: "usd" })).toBeUndefined();
    expect(orderCurrencyOf({ currency: "US" })).toBeUndefined();
    expect(orderCurrencyOf({})).toBeUndefined();
  });
});

describe("refundedAmountOf / refundCurrencyOf", () => {
  it("sums valid transaction amounts", () => {
    expect(
      refundedAmountOf({ transactions: [{ amount: "10.00", currency: "USD" }, { amount: "2.50", currency: "USD" }] }),
    ).toBeCloseTo(12.5);
  });
  it("skips malformed entries but still sums the valid ones", () => {
    expect(refundedAmountOf({ transactions: [{ amount: "abc" }, { amount: "5.00" }, null, "x"] })).toBe(5);
  });
  it("is undefined (never 0) when there is no array or no valid amount anywhere in it", () => {
    expect(refundedAmountOf({})).toBeUndefined();
    expect(refundedAmountOf({ transactions: [] })).toBeUndefined();
    expect(refundedAmountOf({ transactions: [{ amount: "abc" }] })).toBeUndefined();
  });
  it("reads the first valid transaction's currency", () => {
    expect(refundCurrencyOf(refundBody())).toBe("USD");
  });
});

describe("PAYLOAD_SHAPES — cross-topic replay refusal for the three new topics", () => {
  it("a genuine Order body matches BOTH orders/create and orders/updated (same resource shape) and NEITHER other topic", () => {
    const body = orderBody();
    expect(matchesPayloadShape(ORDER_TOPICS[0], body)).toBe(true);
    expect(matchesPayloadShape(ORDER_TOPICS[1], body)).toBe(true);
    expect(matchesPayloadShape(REFUND_TOPIC, body)).toBe(false);
    expect(matchesPayloadShape("customers/redact", body)).toBe(false);
    expect(matchesPayloadShape("shop/redact", body)).toBe(false);
    expect(matchesPayloadShape("products/create", body)).toBe(false);
    expect(matchesPayloadShape("app/uninstalled", body)).toBe(false);
  });

  it("a genuine Refund body matches ONLY refunds/create", () => {
    const body = refundBody();
    expect(matchesPayloadShape(REFUND_TOPIC, body)).toBe(true);
    expect(matchesPayloadShape(ORDER_TOPICS[0], body)).toBe(false);
    expect(matchesPayloadShape(ORDER_TOPICS[1], body)).toBe(false);
    expect(matchesPayloadShape("customers/redact", body)).toBe(false);
    expect(matchesPayloadShape("shop/redact", body)).toBe(false);
    expect(matchesPayloadShape("products/create", body)).toBe(false);
  });

  it("a compliance body (shop_domain) never matches an order/refund topic, and vice versa", () => {
    const compliance = { shop_domain: "acme.myshopify.com", customer: { id: 1 } };
    expect(matchesPayloadShape(ORDER_TOPICS[0], compliance)).toBe(false);
    expect(matchesPayloadShape(REFUND_TOPIC, compliance)).toBe(false);
  });

  it("a products/* body (bare `id`, no note_attributes/total_price) never matches an order topic", () => {
    const product = { id: 7, admin_graphql_api_id: "gid://shopify/Product/7" };
    expect(matchesPayloadShape(ORDER_TOPICS[0], product)).toBe(false);
    expect(matchesPayloadShape(ORDER_TOPICS[1], product)).toBe(false);
  });
});
