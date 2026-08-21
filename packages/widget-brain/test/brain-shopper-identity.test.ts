import { describe, it, expect } from "vitest";
import { createBrain, DEFAULT_POLICY, MockModelAdapter, StaticGroundingAdapter } from "../src/index.js";
import type { CommercePort, CommercePolicy, Order, OrderHistorySummary, Subscription, SubscriptionActionResult } from "@palup/platform-ports";

// ADR-0017 T6: the brain must use the PER-REQUEST `signals.shopperId` (server-derived), not the
// constructor default, for the support/commerce ownership check — otherwise a stale/constant
// constructor shopperId is an IDOR: request A (really shopper "A") could read/act on shopper "B"'s
// order merely because the brain instance happens to have been constructed with shopperId "B".

const ORDER_OWNED_BY_B: Order = {
  id: "5000",
  shopperId: "B",
  status: "delivered",
  placedDaysAgo: 2,
  total: 40,
  items: [{ title: "Widget", price: "$40" }],
  fulfilled: true,
};

const POLICY: CommercePolicy = { returnWindowDays: 30, refundCeiling: 75, returns: "30 days", shipping: "3-5 days" };

class StubCommerce implements CommercePort {
  async getOrder(orderId: string): Promise<Order | null> {
    return orderId.replace(/[^0-9]/g, "") === "5000" ? ORDER_OWNED_BY_B : null;
  }
  async getRecentOrder(): Promise<Order | null> {
    return null;
  }
  // Not exercised by this suite (ADR-0017 T6 IDOR focus) — stub so the class still satisfies
  // CommercePort after WS-B2a's new getOrderHistory method.
  async getOrderHistory(): Promise<OrderHistorySummary | null> {
    return null;
  }
  async getPolicy(): Promise<CommercePolicy> {
    return POLICY;
  }
  async getSubscription(): Promise<Subscription | null> {
    return null;
  }
  // Not exercised by this suite (ADR-0017 T6 IDOR focus) — stub so the class still satisfies
  // CommercePort after ADR-0016's new subscription-action methods.
  async skipNextDelivery(): Promise<SubscriptionActionResult> {
    return { ok: false, detail: "not used in this suite", reversalPath: "n/a" };
  }
  async pauseSubscription(): Promise<SubscriptionActionResult> {
    return { ok: false, detail: "not used in this suite", reversalPath: "n/a" };
  }
  async resumeSubscription(): Promise<SubscriptionActionResult> {
    return { ok: false, detail: "not used in this suite", reversalPath: "n/a" };
  }
  async unskipNextDelivery(): Promise<SubscriptionActionResult> {
    return { ok: false, detail: "not used in this suite", reversalPath: "n/a" };
  }
}

describe("brain uses per-request shopperId (T6, IDOR)", () => {
  it("an order owned by 'B' is denied when signals.shopperId is 'A', even if the brain was constructed with shopperId 'B'", async () => {
    // Constructor default is "B" (simulates a stale/shared brain instance) — if the brain incorrectly
    // used the constructor value instead of the per-request signals.shopperId, this order would appear
    // OWNED and be revealed/acted on for the wrong caller.
    const commerce = new StubCommerce();
    const brain = createBrain(new MockModelAdapter(), new StaticGroundingAdapter(), DEFAULT_POLICY, commerce, "B");
    const decision = await brain.decide({ tenantId: "demo", shopperId: "A" }, "status of order #5000?");
    expect(decision.flags).toContain("ownership_denied");
    expect(decision.reply.toLowerCase()).not.toContain("delivered");
  });

  it("the SAME order is revealed when signals.shopperId correctly matches the owner", async () => {
    const commerce = new StubCommerce();
    const brain = createBrain(new MockModelAdapter(), new StaticGroundingAdapter(), DEFAULT_POLICY, commerce, "B");
    const decision = await brain.decide({ tenantId: "demo", shopperId: "B" }, "status of order #5000?");
    expect(decision.flags).not.toContain("ownership_denied");
    expect(decision.reply).toContain("#5000");
  });

  it("falls back to the constructor shopperId when signals.shopperId is absent (anonymous rollout default unchanged)", async () => {
    const commerce = new StubCommerce();
    const brain = createBrain(new MockModelAdapter(), new StaticGroundingAdapter(), DEFAULT_POLICY, commerce, "B");
    const decision = await brain.decide({ tenantId: "demo" }, "status of order #5000?"); // no shopperId on signals
    expect(decision.flags).not.toContain("ownership_denied"); // constructor "B" owns #5000
  });
});
