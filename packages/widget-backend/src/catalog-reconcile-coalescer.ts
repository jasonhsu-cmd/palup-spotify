import type { ReconcileReason } from "./catalog-webhook-queue.js";

// S3 §C — per-tenant coalesce/debounce. A bulk edit fires many webhooks; without this, each becomes its own
// reconcile. This accumulates changed ids per tenant over a short window and processes them as ONE batch,
// deduped by id and capped (over the cap ⇒ spill to a full reconcile — cheaper than a giant nodes(ids:)).
//
// SCOPE: wraps the reconcile used by the IN-MEMORY queue consumer (dev/staging synchronous delivery), the
// path that most needs debouncing. The durable Pub/Sub path reconciles per delivery (already targeted);
// cross-delivery coalescing there is an operational/S4 concern (Pub/Sub batches + has an ack deadline).

export const CATALOG_RECONCILE_COALESCE_MS_DEFAULT = 5_000;
/** Above this many distinct ids in one window, a targeted fetch is no cheaper than a full reconcile. */
export const CATALOG_RECONCILE_MAX_IDS = 500;

export interface ReconcileCoalescer {
  enqueue(tenantId: string, req: { productIds?: string[]; reason: ReconcileReason }): void;
  /** Flush now (a specific tenant, or all) — for shutdown and deterministic tests. */
  flush(tenantId?: string): Promise<void>;
}

interface Pending {
  ids: Set<string>;
  forceFull: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export function createReconcileCoalescer(
  reconcile: (tenantId: string, opts: { productIds?: string[]; reason: ReconcileReason }) => Promise<void>,
  opts: { windowMs?: number; maxIds?: number } = {},
): ReconcileCoalescer {
  const windowMs = Math.max(0, Math.floor(opts.windowMs ?? CATALOG_RECONCILE_COALESCE_MS_DEFAULT));
  const maxIds = Math.max(1, Math.floor(opts.maxIds ?? CATALOG_RECONCILE_MAX_IDS));
  const pending = new Map<string, Pending>();

  // Isolate a single tenant's reconcile failure: it must not crash the coalescer, must not become an
  // unhandled rejection, and must not block/lose any OTHER tenant's pending flush (see flush() below, which
  // uses allSettled rather than Promise.all across tenants).
  const runFlush = async (tenantId: string): Promise<void> => {
    const p = pending.get(tenantId);
    if (!p) return;
    if (p.timer) clearTimeout(p.timer);
    pending.delete(tenantId);
    try {
      if (p.forceFull) {
        await reconcile(tenantId, { reason: "full" });
        return;
      }
      if (p.ids.size === 0) return; // inventory-only (or empty) batch: no crawl — §D ceiling + §E backstop cover it
      await reconcile(tenantId, { productIds: [...p.ids], reason: "product" });
    } catch (err) {
      console.error(`[catalog-reconcile-coalescer] reconcile failed for tenant "${tenantId}" (isolated):`, err);
    }
  };

  return {
    enqueue(tenantId, req) {
      let p = pending.get(tenantId);
      if (!p) {
        p = { ids: new Set(), forceFull: false, timer: undefined };
        pending.set(tenantId, p);
      }
      if (req.reason === "full") p.forceFull = true;
      if (req.reason === "product") for (const id of req.productIds ?? []) p.ids.add(id);
      // reason === "inventory" contributes nothing to the fetch set and does not force a full reconcile.
      if (p.ids.size > maxIds) p.forceFull = true;
      if (!p.timer) p.timer = setTimeout(() => void runFlush(tenantId), windowMs);
    },
    async flush(tenantId) {
      if (tenantId) {
        await runFlush(tenantId);
        return;
      }
      await Promise.allSettled([...pending.keys()].map((t) => runFlush(t)));
    },
  };
}
