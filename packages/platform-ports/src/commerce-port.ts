// Commerce port (ADR-0001): order/policy/subscription reads for support. The Shopify adapter
// implements this later; a mock adapter backs it for now. Feature code never calls Shopify directly.

export interface OrderItem {
  title: string;
  price: string;
}

export interface Order {
  id: string;
  /** Owner — the brain verifies this against the current shopper before revealing anything. */
  shopperId: string;
  status: string;
  /** Human ETA string, or undefined if genuinely unknown (never fabricate one). */
  eta?: string;
  placedDaysAgo: number;
  total: number;
  items: OrderItem[];
  /** Has it shipped? Gates whether an order can still be cancelled / address changed. */
  fulfilled: boolean;
}

/** Order-history summary for lifecycle classification (ADR-0015 Tier 2). */
export interface OrderHistorySummary {
  /** Total number of orders this shopper has placed (0 for a known account with no orders). */
  orderCount: number;
  /** Whole days since the MOST RECENT order, or null if there are no orders. */
  lastOrderDaysAgo: number | null;
  /** Whole days since the FIRST order, or null if there are no orders. */
  firstOrderDaysAgo: number | null;
}

export interface Subscription {
  id: string;
  shopperId: string;
  active: boolean;
  /** ADR-0016 #4 — consecutive skip cycles so far, WITHOUT an intervening resume/unskip/normal ship.
   * Compared against `SUBSCRIPTION_SKIP_CAP` before an auto-skip is allowed, so repeated skipping can't
   * become a stealth cancel. Optional so existing literals/mocks that predate this ADR still typecheck. */
  consecutiveSkips?: number;
  /** True while the subscription is indefinitely paused (ADR-0016 #4 — reversible, no cap, but flagged). */
  paused?: boolean;
  /** True once the NEXT delivery is marked skipped for the current cycle — the idempotency marker (#4):
   * a repeated identical skip request while this is true is a no-op, never a second skip. */
  nextDeliverySkipped?: boolean;
}

export interface CommercePolicy {
  returnWindowDays: number;
  /** Refunds above this are HITL — the agent may never auto-approve them. */
  refundCeiling: number;
  returns: string;
  shipping: string;
}

/**
 * F13 — the structured refusal `guardCommercePort` (widget-backend/src/commerce-guard.ts) throws when a
 * LIVE CommercePort call is attempted without a server-verified shopper principal (ADR-0016/ADR-0017).
 * Lives here, not in widget-backend, so a PORT CONSUMER (widget-brain's support.ts) can catch it
 * specifically and degrade gracefully — mirroring `CommsRejection` in comms-port.ts, the same pattern for
 * a different port's fail-closed gate. widget-brain has no dependency on widget-backend (only on this
 * package), so the error type must be defined on the port's own side of that boundary.
 */
export class CommerceGuardRefusalError extends Error {
  constructor(method: string) {
    super(`commerce-guard: live commerce access to ${method} requires a verified shopper principal (ADR-0016)`);
    this.name = "CommerceGuardRefusalError";
  }
}

/** ADR-0016 #4 — per-subscription cap on consecutive auto-executed skips. Once
 * `Subscription.consecutiveSkips` reaches this, the caller (support.ts) MUST route to a human instead
 * of auto-skipping again — repeated skipping can never become a stealth cancel. Small and conservative
 * by design; indefinite PAUSE is not capped (it is explicitly reversible and merely flagged instead). */
export const SUBSCRIPTION_SKIP_CAP = 3;

/** Result of a subscription timing action (ADR-0016 #3/#4). Vendor-neutral — no Shopify types leak
 * through this shape, so a future live adapter satisfies the exact same contract as the mock. */
export interface SubscriptionActionResult {
  ok: boolean;
  /** Human-readable, non-PII detail of what happened (or why it was refused). */
  detail: string;
  /** The CommercePort method name that would UNDO this action, or "n/a" when `ok` is false (nothing
   * changed, so nothing to undo). Reversibility is the whole basis for "auto-allowed" (ADR-0016 #3) — it
   * can't be an unbacked promise, so every successful action names a real, callable reversal. */
  reversalPath: string;
}

export interface CommercePort {
  /**
   * TRUE when this adapter serves DEMO/FIXTURE data rather than the merchant's real commerce system.
   *
   * Support branches that would state a fact about the SHOPPER'S OWN ACCOUNT must refuse and route to a
   * human when this is set (widget-brain/src/support.ts). A fixture order confirmed as "on your account"
   * is not a harmless placeholder — it is a confident false claim about someone's account, and it was
   * reaching real shoppers: the composition root returns the mock unconditionally and the brain's default
   * shopper id is the very id that owns the fixtures, so the ownership check PASSED against demo data.
   *
   * Absent or false means a real adapter, and nothing is gated. Deliberately separate from the
   * `isLive` marker returned alongside the port by widget-backend's `createCommercePort()`: that one
   * gates ADR-0016 subscription EXECUTION, this one gates STATING account facts. They answer different
   * questions and a future adapter could be live-but-seeded or fixture-but-executing.
   */
  readonly isFixtureData?: boolean;
  getOrder(orderId: string): Promise<Order | null>;
  /** The shopper's most recent order — used when they ask "where's my order?" with no number. */
  getRecentOrder(shopperId: string): Promise<Order | null>;
  /** Order-history summary for lifecycle classification (ADR-0015 Tier 2). Returns null when history is
   * genuinely unavailable (⇒ callers fall back to the base new/anonymous relationship — fail-open). */
  getOrderHistory(shopperId: string): Promise<OrderHistorySummary | null>;
  getPolicy(): Promise<CommercePolicy>;
  getSubscription(shopperId: string): Promise<Subscription | null>;
  /**
   * ADR-0016 #3/#4 — skip the shopper's OWN next delivery. Reversible (see `unskipNextDelivery`) and
   * idempotent per cycle: calling this again before a cycle turnover must be a no-op, not a double-skip.
   * Adapters MUST act only on the given shopper's own active subscription.
   */
  skipNextDelivery(shopperId: string): Promise<SubscriptionActionResult>;
  /**
   * ADR-0016 #3/#4 — pause the shopper's OWN subscription indefinitely. Reversible (see
   * `resumeSubscription`) and idempotent (pausing an already-paused subscription is a no-op). Not
   * subject to the skip cap, but callers should flag it (an indefinite pause is a stronger action).
   */
  pauseSubscription(shopperId: string): Promise<SubscriptionActionResult>;
  /** ADR-0016 #3 — the EXECUTABLE reversal of `pauseSubscription`. Idempotent: resuming an
   * already-active subscription is a no-op. "You can undo this anytime" must be real. */
  resumeSubscription(shopperId: string): Promise<SubscriptionActionResult>;
  /** ADR-0016 #3 — the EXECUTABLE reversal of `skipNextDelivery`. Idempotent: undoing when nothing is
   * skipped is a no-op. "You can undo this anytime" must be real. */
  unskipNextDelivery(shopperId: string): Promise<SubscriptionActionResult>;
  /**
   * WB win-back agent — enumerates THIS TENANT's customers with their most recent order timestamp.
   * OPTIONAL, unlike every other method above: those are all per-shopper (a verified shopper reading
   * their OWN account), but this one is tenant-wide enumeration, which only an Admin-API-scoped
   * adapter can do — a per-shopper Customer Account API adapter (e.g.
   * `widget-backend/src/shopify-customer-account-commerce.ts`) genuinely cannot implement it, so it
   * is not required on every adapter. A real Shopify Admin-API adapter (broader `read_customers`
   * scope) is a later, human-gated staging-enablement concern — see `SandboxCustomerDirectory` below
   * for the dev/test/staging stand-in.
   */
  listCustomersWithLastOrder?(ctx: { tenantId: string }): Promise<CustomerLastOrder[]>;
  /**
   * W5 Orders screen — enumerates THIS TENANT's recent orders for read-through display. OPTIONAL for
   * the same reason as `listCustomersWithLastOrder`: tenant-wide enumeration only an Admin-API-scoped
   * adapter can implement. A per-shopper Customer Account API adapter cannot, so it is not required.
   */
  listOrders?(ctx: { tenantId: string }, opts?: { limit?: number }): Promise<MerchantOrderSummary[]>;
}

/** One tenant customer + their most recent order timestamp — the minimal shape the win-back agent's
 *  `findLapsedSegment` (`@palup/agent-runtime`) needs to pick a lapsed-customer segment. */
export interface CustomerLastOrder {
  customerId: string;
  /** Recipient address for outbound comms (email today; extend as more channels are wired). */
  contact: string;
  /** ISO-8601 timestamp of the customer's most recent order. */
  lastOrderAt: string;
}

/** The narrow capability `findLapsedSegment` actually depends on — deliberately NOT the full
 *  `CommercePort` (most adapters can't enumerate all customers; see the optional method above). Any
 *  adapter (or `CommercePort` that happens to implement the optional method) satisfies this. */
export interface CustomerListingCommerce {
  listCustomersWithLastOrder(ctx: { tenantId: string }): Promise<CustomerLastOrder[]>;
}

/**
 * Minimal in-memory sandbox adapter for `listCustomersWithLastOrder` — seeded fixture data, never
 * calls a real commerce system. The win-back agent's dev/test/staging seam until a real Shopify
 * Admin-API adapter is wired (a later, human-gated staging-enablement step, same pattern as
 * `SandboxCommsAdapter` in `comms-port.ts`).
 *
 * Fixtures are keyed by `tenantId` (constructor takes `Record<tenantId, CustomerLastOrder[]>`), so
 * `listCustomersWithLastOrder` honors `ctx.tenantId` — an unknown/unseeded tenant gets an empty
 * list, never another tenant's fixtures. This mirrors `CommercePort`'s own tenant-isolation
 * discipline; a test/staging double must not be the one place that leaks across tenants.
 */
export class SandboxCustomerDirectory implements CustomerListingCommerce {
  constructor(private readonly customersByTenant: Readonly<Record<string, CustomerLastOrder[]>> = {}) {}

  async listCustomersWithLastOrder(ctx: { tenantId: string }): Promise<CustomerLastOrder[]> {
    return (this.customersByTenant[ctx.tenantId] ?? []).map((c) => ({ ...c }));
  }
}

/**
 * A tenant-facing order SUMMARY for the merchant Orders screen (W5). Deliberately NARROW and
 * display-oriented — NOT the per-shopper support `Order` above (which carries a `shopperId` and
 * line items for account-scoped support answers). `customerLabel` is a display string only
 * ("Jamie R." / "Guest"), never a raw email/PII field. `id` is also the Shopify admin deep-link key.
 */
export interface MerchantOrderSummary {
  id: string;
  /** Human order number, e.g. "#1001". */
  orderNumber: string;
  /** ISO-8601 placement timestamp. */
  placedAt: string;
  totalUsd: number;
  currency: string;
  /** Shopify financial status: "paid" | "refunded" | "partially_refunded" | "pending" | ... */
  financialStatus: string;
  /** Shopify fulfilment status: "fulfilled" | "unfulfilled" | "partial" | "restocked". */
  fulfillmentStatus: string;
  /** Display-only customer label (no raw PII). */
  customerLabel: string;
}

/**
 * The narrow capability the W5 Orders screen depends on — deliberately NOT the full `CommercePort`
 * (most per-shopper adapters cannot enumerate a whole tenant's orders; same reasoning as
 * `CustomerListingCommerce`). A real Shopify Admin-API adapter (`read_orders` scope) is a later,
 * human-gated staging-enablement concern.
 */
export interface OrderListingCommerce {
  listOrders(ctx: { tenantId: string }, opts?: { limit?: number }): Promise<MerchantOrderSummary[]>;
}

/**
 * In-memory sandbox adapter for `listOrders` — seeded fixture data, never calls a real commerce
 * system. The Orders screen's dev/test/staging seam until a real Shopify Admin-API adapter is wired
 * (human-gated). Keyed by `tenantId`, so an unseeded tenant gets an empty list, never another
 * tenant's orders — the same tenant-isolation discipline `SandboxCustomerDirectory` follows.
 */
export class SandboxOrderDirectory implements OrderListingCommerce {
  constructor(private readonly ordersByTenant: Readonly<Record<string, MerchantOrderSummary[]>> = {}) {}

  async listOrders(ctx: { tenantId: string }, opts?: { limit?: number }): Promise<MerchantOrderSummary[]> {
    const all = (this.ordersByTenant[ctx.tenantId] ?? []).map((o) => ({ ...o }));
    return typeof opts?.limit === "number" ? all.slice(0, opts.limit) : all;
  }
}
