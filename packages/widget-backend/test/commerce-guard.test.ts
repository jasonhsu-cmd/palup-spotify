import { describe, it, expect } from "vitest";
import type { CommercePort, CommercePolicy, Order, Subscription, SubscriptionActionResult, Principal } from "@palup/platform-ports";
import { guardCommercePort, withRequestPrincipal, CommerceGuardRefusalError } from "../src/commerce-guard.js";

// ADR-0017 T7 (ADR-0016 fail-closed guard). F2: ANY live commerce/subscription adapter must refuse
// EVERY method — reads included, e.g. getRecentOrder (a live cross-account READ is already an IDOR
// disclosure with no mutation needed) — behind a non-verified-shopper principal. CommercePort in this
// slice exposes reads only (getOrder/getRecentOrder/getPolicy/getSubscription; there is no write method
// yet), so this suite proves the guard covers ALL FOUR port methods uniformly — the strongest form of
// "reads AND any future write inherit the same check" available against today's port shape.

const ORDER: Order = { id: "1", shopperId: "shopper-demo", status: "delivered", placedDaysAgo: 1, total: 20, items: [], fulfilled: true };
const POLICY: CommercePolicy = { returnWindowDays: 30, refundCeiling: 75, returns: "r", shipping: "s" };
const SUB: Subscription = { id: "sub-1", shopperId: "shopper-demo", active: true };

const ACTION_RESULT: SubscriptionActionResult = { ok: true, detail: "done", reversalPath: "n/a" };

class FakeLiveCommerce implements CommercePort {
  async getOrder(): Promise<Order | null> { return ORDER; }
  async getRecentOrder(): Promise<Order | null> { return ORDER; }
  async getPolicy(): Promise<CommercePolicy> { return POLICY; }
  async getSubscription(): Promise<Subscription | null> { return SUB; }
  // ADR-0016 #3/#4 — the new subscription-action WRITES; guarded identically to the reads above.
  async skipNextDelivery(): Promise<SubscriptionActionResult> { return ACTION_RESULT; }
  async pauseSubscription(): Promise<SubscriptionActionResult> { return ACTION_RESULT; }
  async resumeSubscription(): Promise<SubscriptionActionResult> { return ACTION_RESULT; }
  async unskipNextDelivery(): Promise<SubscriptionActionResult> { return ACTION_RESULT; }
}

const anon: Principal = { kind: "anonymous" };
const merchant: Principal = { kind: "merchant", merchantId: "acme" }; // a merchant principal is NOT a verified shopper
const verifiedShopper: Principal = { kind: "shopper", shopperId: "shopify:acme:1", source: "shopify", verified: true };

describe("guardCommercePort (T7, ADR-0016 fail-closed)", () => {
  it("live + anonymous ⇒ fails closed on a READ (getRecentOrder)", async () => {
    const guarded = guardCommercePort(new FakeLiveCommerce(), true);
    await expect(withRequestPrincipal(anon, () => guarded.getRecentOrder("shopper-demo"))).rejects.toThrow(CommerceGuardRefusalError);
  });

  it("live + anonymous ⇒ fails closed on getOrder (a second READ, standing in for 'any operation, read or future write')", async () => {
    const guarded = guardCommercePort(new FakeLiveCommerce(), true);
    await expect(withRequestPrincipal(anon, () => guarded.getOrder("1"))).rejects.toThrow(CommerceGuardRefusalError);
  });

  it("live + a MERCHANT principal (not a verified shopper) ⇒ fails closed too", async () => {
    const guarded = guardCommercePort(new FakeLiveCommerce(), true);
    await expect(withRequestPrincipal(merchant, () => guarded.getRecentOrder("shopper-demo"))).rejects.toThrow(CommerceGuardRefusalError);
  });

  it("live + no bound principal at all (ALS empty) ⇒ fails closed (default is anonymous, never open)", async () => {
    const guarded = guardCommercePort(new FakeLiveCommerce(), true);
    await expect(guarded.getRecentOrder("shopper-demo")).rejects.toThrow(CommerceGuardRefusalError);
  });

  it("live + getSubscription and getPolicy are ALSO guarded (every method, not just the two named above)", async () => {
    const guarded = guardCommercePort(new FakeLiveCommerce(), true);
    await expect(withRequestPrincipal(anon, () => guarded.getSubscription("shopper-demo"))).rejects.toThrow(CommerceGuardRefusalError);
    await expect(withRequestPrincipal(anon, () => guarded.getPolicy())).rejects.toThrow(CommerceGuardRefusalError);
  });

  it("live + VERIFIED shopper ⇒ ok (the real call goes through)", async () => {
    const guarded = guardCommercePort(new FakeLiveCommerce(), true);
    await expect(withRequestPrincipal(verifiedShopper, () => guarded.getRecentOrder("shopify:acme:1"))).resolves.toEqual(ORDER);
    await expect(withRequestPrincipal(verifiedShopper, () => guarded.getOrder("1"))).resolves.toEqual(ORDER);
    await expect(withRequestPrincipal(verifiedShopper, () => guarded.getSubscription("shopify:acme:1"))).resolves.toEqual(SUB);
    await expect(withRequestPrincipal(verifiedShopper, () => guarded.getPolicy())).resolves.toEqual(POLICY);
  });

  it("live + VERIFIED shopper but a MISMATCHED shopperId arg ⇒ fails closed (ownership at the choke point, steward finding 3)", async () => {
    const guarded = guardCommercePort(new FakeLiveCommerce(), true);
    // The principal is shopify:acme:1, but the call targets a DIFFERENT shopper — must refuse, so even a
    // caller bug can't act on another shopper's account on a live adapter.
    await expect(withRequestPrincipal(verifiedShopper, () => guarded.getSubscription("shopify:acme:999"))).rejects.toBeInstanceOf(CommerceGuardRefusalError);
    await expect(withRequestPrincipal(verifiedShopper, () => guarded.getRecentOrder("shopify:acme:999"))).rejects.toBeInstanceOf(CommerceGuardRefusalError);
    await expect(withRequestPrincipal(verifiedShopper, () => guarded.skipNextDelivery("shopify:acme:999"))).rejects.toBeInstanceOf(CommerceGuardRefusalError);
  });

  it("mock (isLive:false) ⇒ ok regardless of principal (tested no-op for this slice)", async () => {
    const guarded = guardCommercePort(new FakeLiveCommerce(), false);
    await expect(withRequestPrincipal(anon, () => guarded.getRecentOrder("shopper-demo"))).resolves.toEqual(ORDER);
    await expect(guarded.getOrder("1")).resolves.toEqual(ORDER); // even with no bound principal at all
  });

  // ADR-0016 #3/#4 — the new subscription-action methods are WRITES on a live adapter and MUST inherit
  // the exact same fail-closed guard as every read above (ADR-0017 §3: "reads AND writes").
  describe("the ADR-0016 subscription-action writes are guarded too", () => {
    it("live + anonymous ⇒ fails closed on skipNextDelivery/pauseSubscription/resumeSubscription/unskipNextDelivery", async () => {
      const guarded = guardCommercePort(new FakeLiveCommerce(), true);
      await expect(withRequestPrincipal(anon, () => guarded.skipNextDelivery("shopper-demo"))).rejects.toThrow(CommerceGuardRefusalError);
      await expect(withRequestPrincipal(anon, () => guarded.pauseSubscription("shopper-demo"))).rejects.toThrow(CommerceGuardRefusalError);
      await expect(withRequestPrincipal(anon, () => guarded.resumeSubscription("shopper-demo"))).rejects.toThrow(CommerceGuardRefusalError);
      await expect(withRequestPrincipal(anon, () => guarded.unskipNextDelivery("shopper-demo"))).rejects.toThrow(CommerceGuardRefusalError);
    });

    it("live + VERIFIED shopper ⇒ ok (the real call goes through)", async () => {
      const guarded = guardCommercePort(new FakeLiveCommerce(), true);
      await expect(withRequestPrincipal(verifiedShopper, () => guarded.skipNextDelivery("shopify:acme:1"))).resolves.toEqual(ACTION_RESULT);
      await expect(withRequestPrincipal(verifiedShopper, () => guarded.pauseSubscription("shopify:acme:1"))).resolves.toEqual(ACTION_RESULT);
      await expect(withRequestPrincipal(verifiedShopper, () => guarded.resumeSubscription("shopify:acme:1"))).resolves.toEqual(ACTION_RESULT);
      await expect(withRequestPrincipal(verifiedShopper, () => guarded.unskipNextDelivery("shopify:acme:1"))).resolves.toEqual(ACTION_RESULT);
    });

    it("mock (isLive:false) ⇒ ok regardless of principal", async () => {
      const guarded = guardCommercePort(new FakeLiveCommerce(), false);
      await expect(guarded.skipNextDelivery("shopper-demo")).resolves.toEqual(ACTION_RESULT); // no bound principal at all
    });
  });
});
