import type { QueueMessage, QueuePort, QueueSubscription } from "@palup/platform-ports";

// A3 (ADR-0020 D4) — the seam between a verified catalog/inventory WEBHOOK and the RECONCILE worker.
//
// The webhook route's only job is: verify HMAC → enqueue ONE "reconcile this tenant" message → return 200
// (the enqueue-then-200 pattern that fixes today's synchronous coupling). It NEVER trusts the payload: the
// message carries only the tenantId, and the worker RE-FETCHES that tenant's current catalog through
// runCatalogIndex — so out-of-order / duplicate / partial deliveries all converge on the same correct
// end-state, and the scheduled poll job (PRODUCT_FACTS_POLL) stays the missed-event backstop.
//
// Portability (NN#3): everything here is the vendor-neutral QueuePort; no Shopify type crosses it. The
// message `type` records which topic fired (for telemetry) but the worker dispatches on nothing but the
// tenantId — every catalog/inventory topic means the same thing to the reconcile: "this tenant changed,
// re-derive its current state."

export const CATALOG_RECONCILE_TOPIC = "catalog.reconcile";
/** One consumer group: the catalog indexer. A second group (e.g. a search-index refresher) could subscribe
 *  the same topic later and each would get its own at-least-once delivery — that is the port's fan-out. */
export const CATALOG_RECONCILE_GROUP = "catalog-indexer";

/**
 * Build the reconcile message for a verified catalog/inventory delivery. `id` is Shopify's delivery id when
 * present (so the queue dedups a retried delivery within the group); absent, a synthetic per-tenant/topic
 * id — the reconcile is idempotent either way. `tenantKey` is the tenant, so per-tenant publish ORDER is
 * preserved (two rapid changes to one shop reconcile in arrival order). No product data is carried.
 */
export function catalogReconcileMessage(
  tenantId: string,
  topic: string,
  webhookId: string | undefined,
  nowMs: number,
): QueueMessage {
  return {
    id: webhookId ?? `${tenantId}:${topic}:${nowMs}`,
    type: `catalog.${topic}`,
    tenantKey: tenantId,
    payload: { tenantId, topic, at: new Date(nowMs).toISOString() },
  };
}

/**
 * Subscribe the reconcile worker. On each message it extracts the tenantId from the (server-authored)
 * payload and calls `reconcile(tenantId)` — the composition root supplies that as a runCatalogIndex call
 * for the one tenant. A malformed/absent tenantId is skipped (never reconciles a blank/all-tenant scope).
 * A thrown reconcile is retried by the QueuePort up to its cap, then dead-lettered — never lost silently.
 */
export function subscribeCatalogReconcile(queue: QueuePort, reconcile: (tenantId: string) => Promise<void>): QueueSubscription {
  return queue.subscribe(CATALOG_RECONCILE_TOPIC, CATALOG_RECONCILE_GROUP, async (msg) => {
    const tenantId = (msg.payload as { tenantId?: unknown } | undefined)?.tenantId;
    if (typeof tenantId === "string" && tenantId.trim()) await reconcile(tenantId);
  });
}
