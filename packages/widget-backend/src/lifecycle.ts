// WS-B2b — pure lifecycle derivation from order history + subscription (ADR-0015 Tier 2).
// No I/O, no port access: the caller (server.ts) fetches OrderHistorySummary/Subscription via the
// guarded commerce port and passes the results in here. Kept pure so it's trivially unit-testable and
// so a future adapter change can never smuggle a side effect into the classification itself.
import type { Relationship } from "@palup/widget-brain";
import type { OrderHistorySummary, Subscription } from "@palup/platform-ports";

// Tunable staging thresholds (FAIR-1: relationship steers VOICE + pitch KIND only, never price/offers —
// a mis-stage is low-harm). Starting values; validate with the owner before prod.
export const LAPSED_DAYS = 180;
export const VIP_ORDERS = 5;

/** Map order history + subscription to a lifecycle stage. Pure. Fail-open inputs: null history/subscription
 * are treated as "no data". Precedence: subscriber > lapsed > vip > one_and_done > repeat > new.
 * `replenishment_due` is intentionally NOT derived here — it needs product-cadence data we don't have;
 * deferred to a future slice. */
export function deriveLifecycle(
  hist: OrderHistorySummary | null,
  sub: Subscription | null,
  shopperVerified: boolean,
): Relationship {
  if (!shopperVerified) return "anonymous";
  if (sub?.active) return "subscriber";
  if (!hist || hist.orderCount === 0) return "new";
  if (hist.lastOrderDaysAgo != null && hist.lastOrderDaysAgo > LAPSED_DAYS) return "lapsed";
  if (hist.orderCount >= VIP_ORDERS) return "vip";
  if (hist.orderCount === 1) return "one_and_done";
  return "repeat";
}
