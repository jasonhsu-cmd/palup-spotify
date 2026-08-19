// Pillar 5 (auto-brand) — durable merchant-brand-NAME resolution for the widget header/greeting.
//
// The brand name a shopper reads must be the merchant's REAL Shopify shop name — never a hardcoded
// per-tenant literal (which cannot scale to millions of merchants) and never a per-request Shopify fetch
// (which would scale COGS with shopper traffic instead of with merchants). So the name is resolved from the
// merchant's own store and CACHED on the RuntimeStatePort: at most ONE bounded fetch per tenant per TTL,
// then served from the cache row (tenant-isolated by construction, exactly like the grounding cache).
//
// Fail-closed by construction: any miss/timeout/error — or a blank / "this store" fail-closed sentinel from
// the shell fetch — yields `undefined`, and the caller renders the neutral default. The header never breaks
// and never shows a wrong brand. This module is claim-free (scanned by shopper-promise-guard).
import type { RuntimeStatePort } from "@palup/platform-ports";

/** Where the brand-name cache row lives on the RuntimeStatePort (exported so tests can seed it). */
export const BRAND_CACHE_COLLECTION = "brand-name-cache";
export const BRAND_CACHE_KEY = "v1";
const COLLECTION = BRAND_CACHE_COLLECTION;
const KEY = BRAND_CACHE_KEY;
// shopify-grounding.ts's getShell returns this literal when the real shop name is missing/unfetchable
// (`bound(data.shop?.name) || "this store"`), so it must never be cached or served as a real brand.
const SENTINEL = "this store";

interface BrandRow {
  brandName: string;
  fetchedAtMs: number;
}

function isValidRow(e: unknown): e is BrandRow {
  const c = e as BrandRow | undefined;
  return !!c && typeof c.brandName === "string" && typeof c.fetchedAtMs === "number";
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, rej) => {
    t = setTimeout(() => rej(new Error("brand-cache timeout")), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(t!);
  }
}

export interface BrandNameResolverDeps {
  store: RuntimeStatePort;
  /**
   * Fetch the merchant's real shop name (e.g. `(t) => grounding.getShell(t).then(s => s.brandName)`).
   * May throw, hang, or return the "this store" sentinel — the resolver tolerates all three.
   */
  fetchShopName: (tenantId: string) => Promise<string | undefined>;
  now?: () => number;
  /** Freshness window for a cached brand name. Default 6h — a merchant's brand name changes rarely. */
  ttlSeconds?: number;
  /** Retention cap on the cache row (bounds growth; also the max stale-while-error age). Default 30d. */
  retentionSeconds?: number;
  /** Hard timeout on the upstream fetch AND each store op, so neither can ever hang panel serving. */
  timeoutMs?: number;
}

/**
 * A cached, write-through brand-name resolver: returns the merchant's real shop name, or `undefined` when it
 * cannot be resolved (→ the caller's neutral default). Never throws. One bounded fetch per tenant per TTL.
 */
export function createBrandNameResolver(
  deps: BrandNameResolverDeps,
): (tenantId: string) => Promise<string | undefined> {
  const now = deps.now ?? (() => Date.now());
  const ttlMs = (deps.ttlSeconds ?? 6 * 3600) * 1000;
  const retentionSeconds = deps.retentionSeconds ?? 30 * 86_400;
  const timeoutMs = deps.timeoutMs ?? 3000;

  const clean = (name: string | undefined): string | undefined => {
    const n = (name ?? "").trim();
    return n && n.toLowerCase() !== SENTINEL ? n : undefined;
  };

  return async (tenantId: string): Promise<string | undefined> => {
    if (!tenantId) return undefined;

    // Reading the cache never breaks serving: a hung/failing/corrupt store degrades to a miss.
    const raw = await withTimeout(deps.store.get<BrandRow>({ tenantId }, COLLECTION, KEY), timeoutMs).catch(
      () => undefined,
    );
    const cached = isValidRow(raw) ? raw : undefined;
    if (cached && now() - cached.fetchedAtMs < ttlMs) return clean(cached.brandName);

    let fetched: string | undefined;
    try {
      fetched = clean(await withTimeout(deps.fetchShopName(tenantId), timeoutMs));
    } catch {
      // stale-while-error: a last-known-good name beats a broken/blank header
      return cached ? clean(cached.brandName) : undefined;
    }

    if (fetched) {
      // Write-through FIRE-AND-FORGET + timeout-bounded — a slow store write never delays the panel.
      void withTimeout(
        deps.store.put({ tenantId }, COLLECTION, KEY, { brandName: fetched, fetchedAtMs: now() }, { ttlSeconds: retentionSeconds }),
        timeoutMs,
      ).catch(() => {});
      return fetched;
    }
    // Fetch resolved to the sentinel/blank — never cache it; fall back to a stale good name if we have one.
    return cached ? clean(cached.brandName) : undefined;
  };
}
