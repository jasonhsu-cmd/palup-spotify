import type { GroundingContext, GroundingPort } from "./grounding-port.js";
import type { RuntimeStatePort } from "./runtime-state-port.js";

// Caching + degradation wrapper for any GroundingPort (mirrors createRedactingModelPort). A merchant's
// catalog is large and changes rarely, and the upstream source (Shopify) can be slow/down/unauthorized —
// so this decorator:
//   • caches each tenant's GroundingContext on the RuntimeStatePort (tenant-isolated by construction —
//     tenant A can never read B's cache row), fresh for `ttlSeconds`;
//   • bounds the upstream fetch with a hard timeout so a slow store can never hang /chat;
//   • serves STALE-WHILE-ERROR: on fetch error/timeout, returns the last-known-good context (even past
//     TTL) if we have one;
//   • fails CLOSED to a SAFE-EMPTY context (no products) on a cold failure — the brain then honestly
//     says it can't find products rather than ever inventing them or leaking another tenant's catalog.
// Freshness is tracked in-band (fetchedAtMs) rather than via store-TTL expiry, so the last-known-good
// survives past freshness for stale-while-error; a long retention TTL still bounds growth.

const COLLECTION = "grounding";
const KEY = "context";

export interface CachingGroundingOpts {
  /** Freshness window — a cached context newer than this is served without refetching. Default 1800s. */
  ttlSeconds?: number;
  /** Retention cap on the cache row (bounds growth; also the max stale-while-error age). Default 7d. */
  retentionSeconds?: number;
  /** Hard timeout on the upstream getContext so it can never hang the request. Default 3000ms. */
  timeoutMs?: number;
  /** Injectable clock (ms) for deterministic tests. Default Date.now. */
  now?: () => number;
}

interface CacheEntry {
  ctx: GroundingContext;
  fetchedAtMs: number;
}

function safeEmpty(tenantId: string): GroundingContext {
  return { tenantId, brandName: "this store", products: [], policy: { returns: "", shipping: "" } };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("grounding fetch timeout")), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export function createCachingGroundingPort(
  inner: GroundingPort,
  store: RuntimeStatePort,
  opts: CachingGroundingOpts = {},
): GroundingPort {
  const ttlMs = (opts.ttlSeconds ?? 1800) * 1000;
  const retentionSeconds = opts.retentionSeconds ?? 7 * 86_400;
  const timeoutMs = opts.timeoutMs ?? 3000;
  const now = opts.now ?? (() => Date.now());

  return {
    async getContext(tenantId: string): Promise<GroundingContext> {
      // A reading of the cache never breaks serving (fall through to a fetch on any store error).
      const cached = await store.get<CacheEntry>({ tenantId }, COLLECTION, KEY).catch(() => undefined);
      if (cached && now() - cached.fetchedAtMs < ttlMs) return cached.ctx; // fresh hit

      try {
        const ctx = await withTimeout(inner.getContext(tenantId), timeoutMs);
        // Refresh the cache (best-effort — a write failure must not fail the request).
        await store
          .put({ tenantId }, COLLECTION, KEY, { ctx, fetchedAtMs: now() }, { ttlSeconds: retentionSeconds })
          .catch(() => {});
        return ctx;
      } catch {
        if (cached) return cached.ctx; // stale-while-error: last-known-good beats a broken answer
        return safeEmpty(tenantId); // cold failure ⇒ fail closed, never invent / never leak
      }
    },
  };
}
