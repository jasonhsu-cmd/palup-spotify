import { describe, it, expect } from "vitest";
import { deriveLifecycle, LAPSED_DAYS, VIP_ORDERS } from "../src/lifecycle.js";
import type { OrderHistorySummary, Subscription } from "@palup/platform-ports";

// WS-B2b: one case per lifecycle stage + the fail-open null-input cases. Precedence under test:
// subscriber > lapsed > vip > one_and_done > repeat > new > anonymous.
describe("deriveLifecycle", () => {
  const hist = (orderCount: number, lastOrderDaysAgo: number | null, firstOrderDaysAgo: number | null = lastOrderDaysAgo): OrderHistorySummary => ({
    orderCount,
    lastOrderDaysAgo,
    firstOrderDaysAgo,
  });
  const sub = (active: boolean): Subscription => ({ id: "sub_1", shopperId: "s1", active });

  it("unverified shopper ⇒ anonymous, regardless of history/subscription", () => {
    expect(deriveLifecycle(hist(10, 1), sub(true), false)).toBe("anonymous");
    expect(deriveLifecycle(null, null, false)).toBe("anonymous");
  });

  it("verified + active subscription ⇒ subscriber (wins over everything else)", () => {
    expect(deriveLifecycle(hist(1, 1000), sub(true), true)).toBe("subscriber");
    expect(deriveLifecycle(null, sub(true), true)).toBe("subscriber");
  });

  it("verified + no history (null) ⇒ new", () => {
    expect(deriveLifecycle(null, null, true)).toBe("new");
  });

  it("verified + orderCount 0 ⇒ new", () => {
    expect(deriveLifecycle(hist(0, null), null, true)).toBe("new");
  });

  it(`verified + last order > ${LAPSED_DAYS} days ago ⇒ lapsed (even with many orders)`, () => {
    expect(deriveLifecycle(hist(1, LAPSED_DAYS + 1), null, true)).toBe("lapsed");
    expect(deriveLifecycle(hist(VIP_ORDERS + 2, LAPSED_DAYS + 1), null, true)).toBe("lapsed");
  });

  it(`verified + orderCount >= VIP_ORDERS and recent ⇒ vip`, () => {
    expect(deriveLifecycle(hist(VIP_ORDERS, 10), null, true)).toBe("vip");
    expect(deriveLifecycle(hist(VIP_ORDERS + 5, 10), null, true)).toBe("vip");
  });

  it("verified + exactly one order, recent ⇒ one_and_done", () => {
    expect(deriveLifecycle(hist(1, 10), null, true)).toBe("one_and_done");
  });

  it("verified + 2..VIP_ORDERS-1 orders, recent ⇒ repeat", () => {
    expect(deriveLifecycle(hist(2, 10), null, true)).toBe("repeat");
    expect(deriveLifecycle(hist(VIP_ORDERS - 1, 10), null, true)).toBe("repeat");
  });

  it("fail-open: null history + null subscription, verified ⇒ new (never throws)", () => {
    expect(deriveLifecycle(null, null, true)).toBe("new");
  });

  it("fail-open: null subscription with real history still classifies off history alone", () => {
    expect(deriveLifecycle(hist(3, 10), null, true)).toBe("repeat");
  });

  it("inactive subscription does not force subscriber — falls through to history-based classification", () => {
    expect(deriveLifecycle(hist(3, 10), sub(false), true)).toBe("repeat");
  });

  it("lastOrderDaysAgo exactly at the LAPSED_DAYS boundary is NOT lapsed (strictly greater-than)", () => {
    expect(deriveLifecycle(hist(2, LAPSED_DAYS), null, true)).toBe("repeat");
  });
});
