// Pillar 1 (price truth) — the per-tenant freshness-CHANNEL health signal.
//
// A merchant's money-facts (price, availability) are kept fresh by an event-driven channel: Shopify webhooks
// → reconcile, with an hourly poll as the missed-event backstop. Today "confirmed" is derived SOLELY from a
// fact row's `updatedAt` recency (hydrate-facts.ts) — which cannot tell "the channel is live" from "the
// webhook died hours ago but a poll happened to write a row recently". At millions of merchants a silently
// dead channel is a *when*, not an *if*, and today a shopper would still see a confident price with zero
// evidence the freshness pipe is alive.
//
// This records a lightweight liveness signal: `recordProducerOk` stamps every successful producer run (a
// webhook reconcile OR a poll), and `isHealthy` answers whether one happened within a freshness window.
// Serving consults it (behind its own posture flag) so a confirmed price requires BOTH a fresh fact AND a
// provably-live channel — otherwise it hedges (money/NN#1 fail-honest).
//
// FAIL-CLOSED by construction: no signal / a stale stamp / any store error ⇒ NOT healthy. A recording
// failure is swallowed so a health-store blip can never break the producer. Tenant-isolated exactly like the
// grounding/brand caches (a tenant can never read another's row). Claim-free (scanned by shopper-promise-guard).
import type { RuntimeStatePort } from "@palup/platform-ports";

/** Where the channel-health row lives on the RuntimeStatePort (exported so tests/producers can address it). */
export const CHANNEL_HEALTH_COLLECTION = "channel-health";
export const CHANNEL_HEALTH_KEY = "v1";

interface HealthRow {
  /** Epoch ms of the most recent successful producer run (webhook reconcile or poll) for this tenant. */
  lastProducerOkAtMs: number;
}

function isValidRow(e: unknown): e is HealthRow {
  const c = e as HealthRow | undefined;
  return !!c && typeof c.lastProducerOkAtMs === "number" && Number.isFinite(c.lastProducerOkAtMs);
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, rej) => {
    t = setTimeout(() => rej(new Error("channel-health timeout")), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(t!);
  }
}

export interface ChannelHealthDeps {
  store: RuntimeStatePort;
  now?: () => number;
  /** How recent a producer run must be for the channel to count as live. Default 2h — generous headroom over
   *  the hourly poll backstop, so a healthy channel (webhook or poll) always has a run inside the window. */
  freshSeconds?: number;
  /** Retention cap on the row (bounds growth). Default 30d. */
  retentionSeconds?: number;
  /** Hard timeout on each store op so neither read nor write can hang serving or the producer. */
  timeoutMs?: number;
}

export interface ChannelHealth {
  /** Stamp a successful producer run (webhook reconcile or poll). Never throws — a store blip is swallowed. */
  recordProducerOk(tenantId: string): Promise<void>;
  /** True only when a producer run is recorded within the freshness window. Fail-closed: never throws. */
  isHealthy(tenantId: string): Promise<boolean>;
}

export function createChannelHealth(deps: ChannelHealthDeps): ChannelHealth {
  const now = deps.now ?? (() => Date.now());
  const freshMs = (deps.freshSeconds ?? 2 * 3600) * 1000;
  const retentionSeconds = deps.retentionSeconds ?? 30 * 86_400;
  const timeoutMs = deps.timeoutMs ?? 3000;

  return {
    async recordProducerOk(tenantId: string): Promise<void> {
      if (!tenantId) return;
      // The write is timeout-bounded and error-swallowing: a slow/failing health store can delay an AWAITING
      // caller by at most `timeoutMs` and can NEVER throw (the facts were already written; health is a side
      // signal). A producer that must not block at all should call this detached (void it) — see Pillar 1b.
      // The store call is wrapped so even a SYNCHRONOUS adapter throw becomes a caught rejection, not an escape.
      await withTimeout(
        (async () => deps.store.put({ tenantId }, CHANNEL_HEALTH_COLLECTION, CHANNEL_HEALTH_KEY, { lastProducerOkAtMs: now() }, { ttlSeconds: retentionSeconds }))(),
        timeoutMs,
      ).catch(() => {});
    },

    async isHealthy(tenantId: string): Promise<boolean> {
      if (!tenantId) return false;
      // Wrapped in an async thunk so a synchronous adapter throw is turned into a rejection the .catch swallows.
      const raw = await withTimeout((async () => deps.store.get<HealthRow>({ tenantId }, CHANNEL_HEALTH_COLLECTION, CHANNEL_HEALTH_KEY))(), timeoutMs).catch(
        () => undefined,
      );
      if (!isValidRow(raw)) return false; // no/corrupt signal ⇒ fail-closed
      return now() - raw.lastProducerOkAtMs <= freshMs; // stale stamp ⇒ channel presumed dead
    },
  };
}
