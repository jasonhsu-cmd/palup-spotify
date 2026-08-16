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

/** The Storefront GID prefix for a Product node. Corpus record ids use the GID (not the bare numeric id
 *  Shopify's REST-shaped webhook bodies carry), so the route builds it here, once, rather than each
 *  consumer re-deriving its own spelling. */
export const SHOPIFY_PRODUCT_GID_PREFIX = "gid://shopify/Product/";

/** Why a reconcile fired, so the worker can target (or fall back to a full crawl). `product` = precise ids
 *  present; `inventory` = a coarse inventory tick (no product id derivable from the Storefront token — see
 *  §C); `full` = re-derive the whole catalog (the backstop path). */
export type ReconcileReason = "product" | "inventory" | "full";

/**
 * Build the reconcile message for a verified catalog/inventory delivery. `id` is Shopify's delivery id when
 * present (so the queue dedups a retried delivery within the group); absent, a synthetic per-tenant/topic
 * id — the reconcile is idempotent either way. `tenantKey` is the tenant, so per-tenant publish ORDER is
 * preserved (two rapid changes to one shop reconcile in arrival order).
 *
 * S3 §C — `extra.productIds` (a Storefront GID per changed product) and `extra.reason` let a later worker
 * (T5) target just those SKUs instead of re-crawling the whole catalog; `reason` defaults to `"full"` so an
 * old call site (or a message a future reader decodes with no `extra`) is always a SAFE whole-catalog
 * reconcile, never silently a no-op. `productIds` is omitted from the payload entirely when empty/absent —
 * backward compatible with a consumer that only ever checked for its presence.
 */
export function catalogReconcileMessage(
  tenantId: string,
  topic: string,
  webhookId: string | undefined,
  nowMs: number,
  extra: { productIds?: string[]; reason?: ReconcileReason } = {},
): QueueMessage {
  const reason: ReconcileReason = extra.reason ?? "full";
  return {
    id: webhookId ?? `${tenantId}:${topic}:${nowMs}`,
    type: `catalog.${topic}`,
    tenantKey: tenantId,
    payload: {
      tenantId,
      topic,
      at: new Date(nowMs).toISOString(),
      reason,
      ...(extra.productIds && extra.productIds.length > 0 ? { productIds: extra.productIds } : {}),
    },
  };
}

/**
 * Subscribe the reconcile worker. On each message it extracts the tenantId (and, S3 §C, the changed
 * `productIds`/`reason`) from the (server-authored) payload and calls `reconcile(tenantId, opts)` — the
 * composition root routes that to a TARGETED `reconcileProducts` when ids are present, or the full
 * `runCatalogIndex` otherwise. A malformed/absent tenantId is skipped (never reconciles a blank/all-tenant
 * scope). A thrown reconcile is retried by the QueuePort up to its cap, then dead-lettered — never lost
 * silently.
 */
export function subscribeCatalogReconcile(
  queue: QueuePort,
  reconcile: (tenantId: string, opts?: { productIds?: string[]; reason?: ReconcileReason }) => Promise<void>,
): QueueSubscription {
  return queue.subscribe(CATALOG_RECONCILE_TOPIC, CATALOG_RECONCILE_GROUP, async (msg) => {
    const payload = msg.payload as { tenantId?: unknown; productIds?: unknown; reason?: unknown } | undefined;
    const tenantId = payload?.tenantId;
    if (typeof tenantId !== "string" || !tenantId.trim()) return;
    const productIds = Array.isArray(payload?.productIds) ? payload!.productIds.filter((x): x is string => typeof x === "string") : undefined;
    const reason = payload?.reason === "product" || payload?.reason === "inventory" || payload?.reason === "full" ? payload.reason : undefined;
    await reconcile(tenantId, { ...(productIds && productIds.length > 0 ? { productIds } : {}), ...(reason ? { reason } : {}) });
  });
}
