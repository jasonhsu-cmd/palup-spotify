import type { GroundingContext, GroundingPort, GroundingShell, Product } from "./grounding-port.js";
import type { RuntimeStatePort } from "./runtime-state-port.js";

// Caching + degradation wrapper for any GroundingPort (mirrors createRedactingModelPort). A merchant's
// catalog is large and changes rarely, and the upstream source (Shopify) can be slow/down/unauthorized —
// so this decorator:
//   • caches each tenant's GroundingContext on the RuntimeStatePort (tenant-isolated by construction —
//     tenant A can never read B's cache row), fresh for `ttlSeconds`;
//   • hard-timeouts BOTH the upstream fetch AND every store read/write, and fires the cache write
//     fire-and-forget, so neither a slow Shopify nor a hung state store can ever hang /chat;
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

// Guard the cached shape (F5): a corrupt/legacy row must be treated as a miss, never served as a
// GroundingContext. Requires a numeric fetchedAtMs and an object ctx carrying the tenant.
function isValidEntry(e: unknown): e is CacheEntry {
  const c = e as CacheEntry | undefined;
  return !!c && typeof c === "object" && typeof c.fetchedAtMs === "number" && !!c.ctx && typeof c.ctx === "object" && typeof c.ctx.tenantId === "string";
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
      // Reading the cache never breaks serving, and a HUNG store never hangs /chat (F1): the read is
      // timeout-bounded and any error/timeout/corrupt row (F5) degrades to a cache miss.
      const raw = await withTimeout(store.get<CacheEntry>({ tenantId }, COLLECTION, KEY), timeoutMs).catch(() => undefined);
      const cached = isValidEntry(raw) ? raw : undefined;
      if (cached && now() - cached.fetchedAtMs < ttlMs) return cached.ctx; // fresh hit

      try {
        const ctx = await withTimeout(inner.getContext(tenantId), timeoutMs);
        // Defense-in-depth on the top multi-tenant control (F2): never cache or serve a context whose
        // tenant doesn't match the request — a buggy upstream adapter must not be laundered through the
        // cache. A mismatch is treated as a fetch failure (→ stale-while-error / safe-empty below).
        if (ctx.tenantId !== tenantId) throw new Error("grounding tenant mismatch");
        // Refresh the cache FIRE-AND-FORGET + timeout-bounded — a slow/hung store write never delays or
        // fails the response (F1).
        void withTimeout(
          store.put({ tenantId }, COLLECTION, KEY, { ctx, fetchedAtMs: now() }, { ttlSeconds: retentionSeconds }),
          timeoutMs,
        ).catch(() => {});
        return ctx;
      } catch {
        if (cached) return cached.ctx; // stale-while-error: last-known-good beats a broken answer
        return safeEmpty(tenantId); // cold failure ⇒ fail closed, never invent / never leak
      }
    },

    // S2 — a lightweight passthrough: a shell fetch is one cheap call (brand + policy, no products), so
    // there's no TTL cache to maintain here — just the same timeout + tenant-isolation + fail-closed
    // discipline as getContext's cold path.
    async getShell(tenantId: string): Promise<GroundingShell> {
      try {
        const shell = await withTimeout(inner.getShell(tenantId), timeoutMs);
        if (shell.tenantId !== tenantId) throw new Error("grounding tenant mismatch");
        return shell;
      } catch {
        // Fail CLOSED, exactly like getContext's cold path: a brandless "this store" + empty policy, so the
        // brain grounds honestly rather than inventing or leaking.
        return { tenantId, brandName: "this store", policy: { returns: "", shipping: "" } };
      }
    },

    // Cart/retrieval coexistence — no TTL cache row for this (a small, bounded, per-turn fetch, not the
    // whole catalog). Same timeout BOUND as getShell, but — UNLIKE getContext/getShell — a failure is
    // PROPAGATED, not swallowed to `[]`. There is no last-known-good to serve for an arbitrary per-turn id
    // set, and a silent `[]` is indistinguishable from a legitimate "no ids resolved" — which would drop
    // the shopper's cart block with NO audit trail (the §3-rule-5 silent-degrade this fetch's flag exists
    // to prevent). The sole caller (the brain's cart path) wraps this in try/catch and IS the fail-closed
    // point: on a throw it renders no cart block AND records `cart:byid_unavailable`. `ids.length === 0`
    // short-circuits without touching the inner adapter.
    async getProductsByIds(tenantId: string, ids: string[]): Promise<Product[]> {
      if (ids.length === 0) return [];
      return withTimeout(inner.getProductsByIds(tenantId, ids), timeoutMs);
    },
  };
}

// Go-live hygiene: when a merchant is flipped from a fixture/demo grounding source to the real
// catalog, a stale fixture context can still be cached here for up to `ttlSeconds` (default 30 min),
// so the first grounded turn after go-live could otherwise answer from the fixture. This is the
// operator-mediated escape hatch — reuses the SAME private COLLECTION/KEY the decorator writes above
// (never exported as raw strings, so this stays the only way to touch that row from outside the
// decorator). Deliberately NOT on the hot /chat path and NOT timeout-wrapped: this runs from an
// operator CLI, not a request handler, so a delete failure should throw and be seen, not be swallowed.
export async function invalidateGroundingCache(store: RuntimeStatePort, tenantId: string): Promise<void> {
  if (!tenantId) throw new Error("invalidateGroundingCache: a non-blank tenantId is required");
  await store.delete({ tenantId }, COLLECTION, KEY);
}
