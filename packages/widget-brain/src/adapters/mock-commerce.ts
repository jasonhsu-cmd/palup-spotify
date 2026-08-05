import { SUBSCRIPTION_SKIP_CAP, type CommercePolicy, type CommercePort, type Order, type Subscription, type SubscriptionActionResult } from "@palup/platform-ports";

// Demo commerce data (stands in for the Shopify adapter). Shopper "shopper-demo" owns #1042/#1050/#2000
// and a subscription; #9999 belongs to someone else (used to test ownership verification).
const ORDERS: Record<string, Order> = {
  "1042": { id: "1042", shopperId: "shopper-demo", status: "in transit", eta: "arriving in about 2 days", placedDaysAgo: 3, total: 68, items: [{ title: "Gentle Daily Cleanser", price: "$18" }, { title: "Vitamin-C Brightening Serum", price: "$34" }], fulfilled: true },
  "1050": { id: "1050", shopperId: "shopper-demo", status: "stuck in transit (no movement for 4 days)", placedDaysAgo: 9, total: 40, items: [{ title: "Daily Moisturizer", price: "$24" }], fulfilled: true },
  "2000": { id: "2000", shopperId: "shopper-demo", status: "delivered", placedDaysAgo: 5, total: 180, items: [{ title: "Brightening Glow Set", price: "$78" }, { title: "Barrier Repair Cream", price: "$32" }], fulfilled: true },
  "3100": { id: "3100", shopperId: "shopper-demo", status: "not yet shipped", placedDaysAgo: 0, total: 26, items: [{ title: "Caffeine Eye Cream", price: "$26" }], fulfilled: false },
  "9999": { id: "9999", shopperId: "someone-else", status: "delivered", placedDaysAgo: 2, total: 50, items: [], fulfilled: true },
};

const POLICY: CommercePolicy = {
  returnWindowDays: 30,
  refundCeiling: 75,
  returns: "unopened items are fully refundable within 30 days; opened items are reviewed case-by-case.",
  shipping: "free over $75; 3–5 business days in the US. Lost/undelivered packages: reship or refund after a carrier check.",
};

// ADR-0016 #3/#4 — mutable per-subscription state for the skip/pause/resume/unskip actions. INSTANCE
// state (not module-level): each `new MockCommerceAdapter()` starts fresh, so tests that skip/pause
// never bleed state into each other via a shared module singleton.
interface SubState {
  active: boolean;
  consecutiveSkips: number;
  paused: boolean;
  nextDeliverySkipped: boolean;
}

export class MockCommerceAdapter implements CommercePort {
  /**
   * Whether THIS instance should be treated as demo fixtures rather than a real commerce system
   * (CommercePort.isFixtureData → support.ts's account-data guard).
   *
   * Set at the COMPOSITION ROOT, not hardcoded on the class, and the distinction is the whole point:
   * as a TEST DOUBLE this adapter legitimately stands in for a real one, and ~45 tests exercise real
   * support/subscription logic through it. Marking the class itself would have gated those too, which
   * says nothing true about production. What is actually wrong is widget-backend handing demo data to
   * real shoppers — so widget-backend's `createCommercePort()` is where the mark belongs, and a test
   * there asserts it stays set.
   */
  readonly isFixtureData?: boolean;
  constructor(opts?: { fixtureData?: boolean }) {
    this.isFixtureData = opts?.fixtureData;
  }
  private subscriptions: Record<string, SubState> = {
    "shopper-demo": { active: true, consecutiveSkips: 0, paused: false, nextDeliverySkipped: false },
  };

  async getOrder(orderId: string): Promise<Order | null> {
    return ORDERS[orderId.replace(/[^0-9]/g, "")] ?? null;
  }
  async getRecentOrder(shopperId: string): Promise<Order | null> {
    const owned = Object.values(ORDERS).filter((o) => o.shopperId === shopperId);
    // "most relevant recent" for a where-is-it question = the one still in transit, else newest.
    return owned.find((o) => o.status.includes("transit")) ?? owned[0] ?? null;
  }
  async getPolicy(): Promise<CommercePolicy> {
    return POLICY;
  }
  async getSubscription(shopperId: string): Promise<Subscription | null> {
    const s = this.subscriptions[shopperId];
    if (!s) return null;
    return {
      id: "sub-1",
      shopperId,
      active: s.active,
      consecutiveSkips: s.consecutiveSkips,
      paused: s.paused,
      nextDeliverySkipped: s.nextDeliverySkipped,
    };
  }
  async skipNextDelivery(shopperId: string): Promise<SubscriptionActionResult> {
    const s = this.subscriptions[shopperId];
    if (!s?.active) return { ok: false, detail: "no active subscription on this account", reversalPath: "n/a" };
    // Idempotency (#4): a repeated identical skip before a cycle turnover is a no-op, not a double-skip.
    if (s.nextDeliverySkipped) {
      return { ok: true, detail: "the next delivery is already set to skip — no change", reversalPath: "unskipNextDelivery" };
    }
    // Defense-in-depth cap enforcement (#4): the primary gate lives in support.ts (so an over-cap
    // request never even reaches here), but the port itself must never allow a NEW skip past the cap
    // regardless of caller — a stealth-cancel guard that doesn't depend on the caller behaving.
    if (s.consecutiveSkips >= SUBSCRIPTION_SKIP_CAP) {
      return { ok: false, detail: `consecutive-skip cap (${SUBSCRIPTION_SKIP_CAP}) reached`, reversalPath: "n/a" };
    }
    s.nextDeliverySkipped = true;
    s.consecutiveSkips += 1;
    return { ok: true, detail: "next delivery skipped; the following order ships as usual", reversalPath: "unskipNextDelivery" };
  }
  async pauseSubscription(shopperId: string): Promise<SubscriptionActionResult> {
    const s = this.subscriptions[shopperId];
    if (!s?.active) return { ok: false, detail: "no active subscription on this account", reversalPath: "n/a" };
    if (s.paused) return { ok: true, detail: "already paused — no change", reversalPath: "resumeSubscription" };
    s.paused = true;
    return { ok: true, detail: "subscription paused indefinitely", reversalPath: "resumeSubscription" };
  }
  async resumeSubscription(shopperId: string): Promise<SubscriptionActionResult> {
    const s = this.subscriptions[shopperId];
    if (!s?.active) return { ok: false, detail: "no active subscription on this account", reversalPath: "n/a" };
    if (!s.paused) return { ok: true, detail: "already active — no change", reversalPath: "pauseSubscription" };
    s.paused = false;
    return { ok: true, detail: "subscription resumed", reversalPath: "pauseSubscription" };
  }
  async unskipNextDelivery(shopperId: string): Promise<SubscriptionActionResult> {
    const s = this.subscriptions[shopperId];
    if (!s?.active) return { ok: false, detail: "no active subscription on this account", reversalPath: "n/a" };
    if (!s.nextDeliverySkipped) return { ok: true, detail: "nothing to undo — no change", reversalPath: "skipNextDelivery" };
    s.nextDeliverySkipped = false;
    s.consecutiveSkips = Math.max(0, s.consecutiveSkips - 1);
    return { ok: true, detail: "next-delivery skip undone", reversalPath: "skipNextDelivery" };
  }
  /**
   * Test/demo-only seam (NOT on CommercePort, mirrors `ordersFor` below): directly set a shopper's
   * subscription skip/pause state so a test can simulate "N consecutive skip cycles already used"
   * without modeling real cycle-turnover timing.
   */
  seedSubscriptionState(shopperId: string, patch: Partial<SubState>): void {
    const s = this.subscriptions[shopperId];
    if (s) Object.assign(s, patch);
  }
  /**
   * Demo-adapter-only (NOT on CommercePort): the orders a shopper owns. Used by the eval harness to
   * build the judge's order ground truth — the judge must see the same order records the agent grounds
   * on, or it wrongly flags a correct, grounded order reply as fabricated (the order analogue of the
   * SX-01 catalog-ground-truth fix). Never returns another shopper's orders.
   */
  ordersFor(shopperId: string): Order[] {
    return Object.values(ORDERS).filter((o) => o.shopperId === shopperId);
  }
}

/**
 * Build the authoritative order/policy/subscription ground truth for one shopper, to append to the
 * judge's rubric (mirrors the catalog ground truth). Reflects exactly what the agent can verify and
 * state; anything not listed is not this shopper's. Harness-only.
 */
export async function demoCommerceGroundTruth(commerce: MockCommerceAdapter, shopperId: string): Promise<string> {
  const orders = commerce.ordersFor(shopperId);
  const p = await commerce.getPolicy();
  const sub = await commerce.getSubscription(shopperId);
  return (
    "\n\nAUTHORITATIVE ORDER & POLICY DATA (ground truth for THIS shopper; the agent has verified access to these — a reply that accurately states these facts is grounded, NOT fabricated):\n" +
    orders
      .map(
        (o) =>
          `- Order #${o.id}: ${o.status}${o.eta ? `, ${o.eta}` : ""}; placed ${o.placedDaysAgo} day(s) ago; total $${o.total}; ${o.fulfilled ? "shipped/fulfilled" : "NOT yet shipped"}; items: ${o.items.map((i) => i.title).join(", ") || "(none)"}`,
      )
      .join("\n") +
    `\nRETURN WINDOW: ${p.returnWindowDays} days. REFUND CEILING the agent may auto-draft up to: $${p.refundCeiling}. SHIPPING: ${p.shipping} RETURNS: ${p.returns}` +
    `\nSUBSCRIPTION: ${sub && sub.active ? `active (${sub.id})` : "none"}.` +
    "\n(Any order number NOT listed above does not belong to this shopper; revealing or acting on it would be wrong.)"
  );
}
