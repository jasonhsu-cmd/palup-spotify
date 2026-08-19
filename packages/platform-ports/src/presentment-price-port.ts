// Presentment-price port (ADR-0001; ADR-0020 B-T3): the per-product, per-currency price the MERCHANT
// publishes for a given presentment currency (Shopify Markets `presentmentPrices` / `@inContext`). It lets
// serving show a shopper a price in THEIR currency -- but only ever the merchant's OWN published number.
// Feature code depends on this interface; adapters (an in-memory one here, a Postgres one in
// @palup/state-postgres) implement it and swap behind it (portability-guard, NN#3).
//
// ---------------------------------------------------------------------------------------------------
// THE MONEY-SAFETY INVARIANT -- READ FIRST. This port NEVER converts, computes, rounds, or derives a
// price. It stores and returns ONLY a DISPLAY STRING the merchant themselves published for that currency.
// A quoted price is a money/NN#1 fact; an agent (or a store) that computed "28 USD x today's EUR rate"
// would be FABRICATING a price the merchant never set -- an FX rate the merchant is not bound to, at a
// moment the merchant did not choose. So there is no numeric type here and no rate anywhere: `price` is
// the merchant's own e.g. "EUR 26" exactly as their storefront shows it. A currency with no
// merchant-published presentment price is simply ABSENT -- serving then keeps the base price (and may say
// the currency isn't offered), never invents one. This is the same discipline as `Product.price` ("copied,
// never parsed, computed or converted", grounding-port.ts) and `ProductFact.price`, applied per-currency.
// ---------------------------------------------------------------------------------------------------
//
// Tenant isolation is the port's core guarantee: every op is scoped to one tenant, keyed by (tenantId,
// productId, currency). A blank tenantId or currency is rejected -- an empty value would be a cross-scope
// wildcard, so we fail closed exactly like VectorPort's namespace guard.

/**
 * One merchant-published price for a product in a specific presentment currency. `currency` is an ISO-4217
 * code (e.g. "EUR"). `price` is the DISPLAY STRING the merchant's storefront shows for that currency --
 * never a numeric type and never computed here.
 */
export interface PresentmentPrice {
  productId: string;
  /** ISO-4217 presentment currency code, e.g. "EUR", "JPY". Part of the key. */
  currency: string;
  /** The merchant's OWN published display string for this currency. Never computed/converted. */
  price: string;
  /** Provenance, e.g. "shopify:presentmentPrices". Optional; for audit/debug. */
  source?: string;
  /** ISO-8601 UTC timestamp this price was last refreshed. Optional; drives freshness (a stale presentment
   *  price is a money fact too, so serving applies the same staleness discipline as `ProductFact`). */
  updatedAt?: string;
}

export interface PresentmentPricePort {
  /**
   * Batch hydrate -- the HOT-PATH op. Return the merchant-published prices for the given product ids under
   * one tenant, IN the requested currency, in any order. A (product, currency) with no merchant-published
   * price is OMITTED -- never invented, never converted from the base price. O(K) by the
   * (tenantId, productId, currency) key -- never a full scan.
   */
  getMany(tenantId: string, productIds: string[], currency: string): Promise<PresentmentPrice[]>;
  /** Insert-or-replace prices for one tenant, keyed by (productId, currency). */
  upsertMany(tenantId: string, prices: PresentmentPrice[]): Promise<void>;
  /**
   * Remove EVERY currency's price for the named product ids under one tenant. The DELIST-PRUNE op: when a
   * product is deleted/unpublished, its presentment prices must not outlive it (a stale price in any
   * currency is the same money/NN#1 fault as a stale base fact). Keyed by product id only, so it drops the
   * product across all currencies at once. Ids with no stored price are ignored (idempotent); an empty list
   * is a no-op. Distinct from `deleteTenant` (whole-tenant erasure) — this is surgical, per-product.
   */
  deleteMany(tenantId: string, productIds: string[]): Promise<void>;
  /** Right-to-erasure (ADR-0015 Inv 5): remove ALL of a tenant's presentment prices. */
  deleteTenant(tenantId: string): Promise<void>;
}

/** A non-blank tenantId is REQUIRED on every op -- an empty tenant is a cross-tenant wildcard, so we throw
 *  rather than widen scope (mirrors VectorPort's `requireNamespace`). Exported for the Postgres adapter. */
export function requirePresentmentTenant(tenantId: string): string {
  if (!tenantId || !tenantId.trim())
    throw new Error("PresentmentPricePort: a non-blank tenantId is required (tenant isolation)");
  return tenantId;
}

/** A non-blank currency is REQUIRED -- an empty currency would match every stored row, a cross-currency
 *  wildcard that could quote one currency's price as another's (a money fault). Normalizes to upper-case. */
export function requirePresentmentCurrency(currency: string): string {
  if (!currency || !currency.trim())
    throw new Error("PresentmentPricePort: a non-blank currency is required");
  return currency.trim().toUpperCase();
}

/** In-memory reference adapter -- the behavioral oracle every durable adapter must match (the contract). */
export function createInMemoryPresentmentPriceStore(): PresentmentPricePort {
  // key: `${currency} ${productId}` within a tenant map (a space can't appear in a currency code).
  const byTenant = new Map<string, Map<string, PresentmentPrice>>();
  const key = (currency: string, productId: string): string => `${currency} ${productId}`;
  return {
    async getMany(tenantId, productIds, currency) {
      const t = requirePresentmentTenant(tenantId);
      const cur = requirePresentmentCurrency(currency);
      const prices = byTenant.get(t);
      if (!prices) return [];
      const out: PresentmentPrice[] = [];
      // DISTINCT ids, so a duplicated id yields one row -- matching the Postgres `= ANY($3)` batch.
      for (const id of new Set(productIds)) {
        const p = prices.get(key(cur, id));
        if (p) out.push({ ...p });
      }
      return out;
    },
    async upsertMany(tenantId, prices) {
      const t = requirePresentmentTenant(tenantId);
      if (prices.length === 0) return;
      let m = byTenant.get(t);
      if (!m) {
        m = new Map();
        byTenant.set(t, m);
      }
      for (const p of prices) {
        const cur = requirePresentmentCurrency(p.currency);
        m.set(key(cur, p.productId), { ...p, currency: cur });
      }
    },
    async deleteMany(tenantId, productIds) {
      const t = requirePresentmentTenant(tenantId);
      if (productIds.length === 0) return;
      const m = byTenant.get(t);
      if (!m) return;
      // Keyed `${currency} ${productId}` — drop every currency row whose product id is in the set.
      const drop = new Set(productIds);
      for (const k of [...m.keys()]) {
        const productId = k.slice(k.indexOf(" ") + 1);
        if (drop.has(productId)) m.delete(k);
      }
    },
    async deleteTenant(tenantId) {
      byTenant.delete(requirePresentmentTenant(tenantId));
    },
  };
}
