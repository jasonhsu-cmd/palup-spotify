// Product-facts port (ADR-0001; ADR-0020 A0 / D2): the Tier-2 fresh per-product price + availability
// store that lets serving HYDRATE the retriever's top-K product ids by id, instead of pulling the whole
// catalog into the prompt every turn. Feature code depends on this interface; adapters (an in-memory one
// here, a Postgres one in @palup/state-postgres) implement it and swap behind it (portability-guard).
//
// Tenant isolation is the port's core guarantee: every op is scoped to one tenant, keyed by (tenantId,
// productId). A blank tenantId is rejected on every op — an empty tenant would be a cross-tenant wildcard,
// so we fail closed exactly like VectorPort's namespace guard.
//
// DELIBERATELY NO STOCK COUNT. `availableForSale` is the same three-state boolean the GroundingPort
// carries (grounding-port.ts) — a count/quantity is manufactured-urgency raw material forbidden by §8a
// invariant 11, so this store never holds one. `price` is the DISPLAY STRING actually quoted (matching
// `Product.price`), never a numeric type the model could be tempted to do arithmetic on (CART_DATA_RULE).

/**
 * One fresh per-product fact. `updatedAt` drives the freshness SLA / hard staleness ceiling (ADR-0020 D2):
 * past the ceiling, serving must degrade to "let me confirm" rather than quote a stale price (money/NN#1).
 */
export interface ProductFact {
  productId: string;
  /** Display string as quoted to the shopper (e.g. "$28"), matching `Product.price` — NOT a numeric type. */
  price: string;
  /** Presentment currency code if known (e.g. "USD"). Optional. */
  currency?: string;
  /** Same semantics as `Product.availableForSale`: a boolean, never a stock count. Optional. */
  availableForSale?: boolean;
  /** Provenance of this fact, e.g. "poll" or "webhook:products/update". Optional; for audit/debug. */
  source?: string;
  /** ISO-8601 UTC timestamp this fact was last refreshed. Optional; drives freshness/staleness. */
  updatedAt?: string;
}

export interface ProductFactsPort {
  /**
   * Batch hydrate — the HOT-PATH op. Return the facts for the given product ids under one tenant, in any
   * order. Ids with no stored fact are simply OMITTED (never invented). O(K) by the (tenantId, productId)
   * key — never a full-namespace scan (the whole point of Tier-2 vs. the whole-catalog fetch).
   */
  getMany(tenantId: string, productIds: string[]): Promise<ProductFact[]>;
  /** Insert-or-replace facts for one tenant, keyed by `productId`. */
  upsertMany(tenantId: string, facts: ProductFact[]): Promise<void>;
  /** Right-to-erasure (ADR-0015 Inv 5): remove ALL of a tenant's facts. */
  deleteTenant(tenantId: string): Promise<void>;
}

/** A non-blank tenantId is REQUIRED on every op — an empty tenant is a cross-tenant wildcard, so we throw
 *  rather than widen scope (mirrors VectorPort's `requireNamespace`). Exported for the Postgres adapter. */
export function requireProductFactsTenant(tenantId: string): string {
  if (!tenantId || !tenantId.trim())
    throw new Error("ProductFactsPort: a non-blank tenantId is required (tenant isolation)");
  return tenantId;
}

/** In-memory reference adapter — the behavioral oracle every durable adapter must match (the contract). */
export function createInMemoryProductFactsStore(): ProductFactsPort {
  const byTenant = new Map<string, Map<string, ProductFact>>();
  return {
    async getMany(tenantId, productIds) {
      const t = requireProductFactsTenant(tenantId);
      const facts = byTenant.get(t);
      if (!facts) return [];
      const out: ProductFact[] = [];
      // DISTINCT ids, so a duplicated id in the request yields one fact — matching `product_id = ANY($2)`.
      for (const id of new Set(productIds)) {
        const f = facts.get(id);
        if (f) out.push({ ...f });
      }
      return out;
    },
    async upsertMany(tenantId, facts) {
      const t = requireProductFactsTenant(tenantId);
      if (facts.length === 0) return;
      let m = byTenant.get(t);
      if (!m) {
        m = new Map();
        byTenant.set(t, m);
      }
      for (const f of facts) m.set(f.productId, { ...f });
    },
    async deleteTenant(tenantId) {
      byTenant.delete(requireProductFactsTenant(tenantId));
    },
  };
}
