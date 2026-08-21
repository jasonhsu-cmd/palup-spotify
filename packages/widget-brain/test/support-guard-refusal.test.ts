import { describe, it, expect } from "vitest";
import {
  CommerceGuardRefusalError,
  type CommercePort,
  type CommercePolicy,
  type Order,
  type OrderHistorySummary,
  type StorePolicy,
  type Subscription,
  type SubscriptionActionResult,
} from "@palup/platform-ports";
import { handleSupport, MockCommerceAdapter } from "../src/index.js";

// F13 — confirmed root cause (see .superpowers/sdd/2026-08-20-widget-behavioral-harness-layer1/
// f13-investigation.md): on staging, CAA/commerce-auth is live, so `guardCommercePort`
// (widget-backend/src/commerce-guard.ts) fail-closed-refuses EVERY CommercePort call for an anonymous
// shopper. `support.ts` called `commerce.getPolicy()` unconditionally for all 16 support intents, so the
// refusal was uncaught and crashed the turn into `model_error` — even for `policy_q`, which is PUBLIC
// merchant info that should never have depended on shopper auth in the first place.
//
// `guardCommercePort` itself lives in widget-backend (an AsyncLocalStorage-bound wrapper) — widget-brain
// has no dependency on widget-backend, only on @palup/platform-ports — so this fake reproduces exactly
// its externally observable contract for support.ts: every live CommercePort read throws
// `CommerceGuardRefusalError` for an unverified/anonymous principal.
class AnonymousGuardedCommerce implements CommercePort {
  readonly isFixtureData = false;
  async getOrder(): Promise<Order | null> {
    throw new CommerceGuardRefusalError("getOrder");
  }
  async getRecentOrder(): Promise<Order | null> {
    throw new CommerceGuardRefusalError("getRecentOrder");
  }
  // WS-B2a — getOrderHistory is a shopper-scoped READ like getRecentOrder, so a live guard refusal
  // reproduces here too.
  async getOrderHistory(): Promise<OrderHistorySummary | null> {
    throw new CommerceGuardRefusalError("getOrderHistory");
  }
  async getPolicy(): Promise<CommercePolicy> {
    throw new CommerceGuardRefusalError("getPolicy");
  }
  async getSubscription(): Promise<Subscription | null> {
    throw new CommerceGuardRefusalError("getSubscription");
  }
  async skipNextDelivery(): Promise<SubscriptionActionResult> {
    throw new CommerceGuardRefusalError("skipNextDelivery");
  }
  async pauseSubscription(): Promise<SubscriptionActionResult> {
    throw new CommerceGuardRefusalError("pauseSubscription");
  }
  async resumeSubscription(): Promise<SubscriptionActionResult> {
    throw new CommerceGuardRefusalError("resumeSubscription");
  }
  async unskipNextDelivery(): Promise<SubscriptionActionResult> {
    throw new CommerceGuardRefusalError("unskipNextDelivery");
  }
}

const STORE_POLICY: StorePolicy = {
  returns: "unopened items are fully refundable within 30 days.",
  shipping: "orders ship in 1-2 business days.",
};

describe("F13 — a live commerce-guard refusal for an anonymous shopper must not crash the turn", () => {
  it("policy_q (PUBLIC store policy) answers from the ungated grounded policy — never touches the guarded commerce port", async () => {
    const commerce = new AnonymousGuardedCommerce();
    const r = await handleSupport(
      commerce,
      "shopper-demo",
      "what's your return policy?",
      undefined,
      undefined,
      undefined,
      undefined,
      STORE_POLICY,
    );
    expect(r.reply).toMatch(/30 days/);
    expect(r.reply).toMatch(/1-2 business days/);
    expect(r.escalate).toBe(false);
    expect(r.flags).toContain("mode_support");
    expect(r.flags).not.toContain("model_error");
  });

  it("policy_q with NO grounded policy supplied still degrades gracefully (no throw) instead of crashing", async () => {
    const commerce = new AnonymousGuardedCommerce();
    const r = await handleSupport(commerce, "shopper-demo", "what's your return policy?");
    expect(r.escalate).toBe(false);
    expect(r.flags).toContain("policy_unavailable");
    expect(r.flags).not.toContain("model_error");
  });

  it("order_status (ACCOUNT data) degrades to a sign-in prompt — never a crash, never an order leak", async () => {
    const commerce = new AnonymousGuardedCommerce();
    const r = await handleSupport(
      commerce,
      "shopper-demo",
      "where's my order #1042?",
      undefined,
      undefined,
      undefined,
      undefined,
      STORE_POLICY,
    );
    expect(r.reply.toLowerCase()).toMatch(/sign in/);
    expect(r.reply).not.toMatch(/#1042/);
    expect(r.reply).not.toMatch(/in transit/i);
    expect(r.flags).not.toContain("model_error");
    expect(r.flags).toContain("sign_in_required");
  });

  it("refund (ACCOUNT data) also degrades to sign-in, not a crash", async () => {
    const commerce = new AnonymousGuardedCommerce();
    const r = await handleSupport(commerce, "shopper-demo", "can I get a refund on my last order?", undefined, undefined, undefined, undefined, STORE_POLICY);
    expect(r.reply.toLowerCase()).toMatch(/sign in/);
    expect(r.flags).toContain("sign_in_required");
  });

  it("an unrelated thrown error from the commerce port is NOT swallowed by the guard-refusal catch", async () => {
    const base = new MockCommerceAdapter();
    // A minimal wrapper delegating everything to a real MockCommerceAdapter EXCEPT getPolicy, which
    // throws a plain (non-guard) error — proves the catch is scoped to CommerceGuardRefusalError only.
    const commerce: CommercePort = {
      isFixtureData: base.isFixtureData,
      getOrder: (id) => base.getOrder(id),
      getRecentOrder: (id) => base.getRecentOrder(id),
      getOrderHistory: (id) => base.getOrderHistory(id),
      getSubscription: (id) => base.getSubscription(id),
      skipNextDelivery: (id) => base.skipNextDelivery(id),
      pauseSubscription: (id) => base.pauseSubscription(id),
      resumeSubscription: (id) => base.resumeSubscription(id),
      unskipNextDelivery: (id) => base.unskipNextDelivery(id),
      getPolicy: async () => {
        throw new Error("boom: unrelated adapter failure");
      },
    };
    await expect(handleSupport(commerce, "shopper-demo", "I want to return the cleanser, it's unopened")).rejects.toThrow(/boom/);
  });

  it("the unguarded default MockCommerceAdapter path is byte-identical (no regression)", async () => {
    const commerce = new MockCommerceAdapter();
    const r = await handleSupport(commerce, "shopper-demo", "what's your return policy?");
    expect(r.reply).toMatch(/return policy/i);
    expect(r.escalate).toBe(false);
  });
});
