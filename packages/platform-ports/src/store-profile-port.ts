// Store-profile port (ADR-0001; credential-enrollment-unification Task 2): the per-tenant BRAND + POLICY
// record — the local source of truth for serving `getShell`, replacing the live Storefront-API shell
// fetch. Feature code depends on this interface; adapters (an in-memory one here, a Postgres one in
// @palup/state-postgres) implement it and swap behind it (portability-guard).
//
// Tenant isolation is the port's core guarantee: every op is scoped to one tenant, keyed by tenantId. A
// blank tenantId is rejected on every op — an empty tenant would be a cross-tenant wildcard, so we fail
// closed exactly like ProductFactsPort's tenant guard.

/** Brand + policy content shown in the shell (greeting/about, returns/shipping/allergens copy). */
export interface StoreProfileRecord {
  brandName: string;
  policy: {
    returns: string;
    shipping: string;
    /** Optional — most stores carry no allergen policy. */
    allergens?: string;
  };
}

export interface StoreProfilePort {
  /** Fetch the tenant's profile, or `null` if none has been set yet (never invented). */
  get(tenantId: string): Promise<StoreProfileRecord | null>;
  /** Insert-or-replace the tenant's profile (upsert — one row per tenant). */
  put(tenantId: string, profile: StoreProfileRecord): Promise<void>;
  /** Right-to-erasure (ADR-0015 Inv 5): remove the tenant's profile entirely. */
  deleteTenant(tenantId: string): Promise<void>;
}

/** A non-blank tenantId is REQUIRED on every op — an empty tenant is a cross-tenant wildcard, so we throw
 *  rather than widen scope (mirrors ProductFactsPort's `requireProductFactsTenant`). Exported for the
 *  Postgres adapter. */
export function requireStoreProfileTenant(tenantId: string): string {
  if (!tenantId || !tenantId.trim())
    throw new Error("StoreProfilePort: a non-blank tenantId is required (tenant isolation)");
  return tenantId;
}

/** In-memory reference adapter — the behavioral oracle every durable adapter must match (the contract). */
export function createInMemoryStoreProfileStore(): StoreProfilePort {
  const byTenant = new Map<string, StoreProfileRecord>();
  return {
    async get(tenantId) {
      const t = requireStoreProfileTenant(tenantId);
      const p = byTenant.get(t);
      return p ? { brandName: p.brandName, policy: { ...p.policy } } : null;
    },
    async put(tenantId, profile) {
      const t = requireStoreProfileTenant(tenantId);
      byTenant.set(t, { brandName: profile.brandName, policy: { ...profile.policy } });
    },
    async deleteTenant(tenantId) {
      byTenant.delete(requireStoreProfileTenant(tenantId));
    },
  };
}
