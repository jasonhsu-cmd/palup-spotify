import { describe, it, expect } from "vitest";
import type { CommercePort, CommercePolicy, Order, Subscription, Principal } from "@palup/platform-ports";
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

class FakeLiveCommerce implements CommercePort {
  async getOrder(): Promise<Order | null> { return ORDER; }
  async getRecentOrder(): Promise<Order | null> { return ORDER; }
  async getPolicy(): Promise<CommercePolicy> { return POLICY; }
  async getSubscription(): Promise<Subscription | null> { return SUB; }
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

  it("mock (isLive:false) ⇒ ok regardless of principal (tested no-op for this slice)", async () => {
    const guarded = guardCommercePort(new FakeLiveCommerce(), false);
    await expect(withRequestPrincipal(anon, () => guarded.getRecentOrder("shopper-demo"))).resolves.toEqual(ORDER);
    await expect(guarded.getOrder("1")).resolves.toEqual(ORDER); // even with no bound principal at all
  });
});
