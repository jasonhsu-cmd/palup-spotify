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
}
