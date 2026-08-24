// Catalog product port: the durable product-catalog subsystem supporting Shopify product metadata,
// inventory, and soft-deletes with tombstone cleanup. Mirrors the ProductFactsPort pattern with
// extended record type and lifecycle operations.
//
// Tenant isolation is the port's core guarantee: every op is scoped to one tenant, keyed by
// (tenantId, productId). A blank tenantId is rejected on every op — fail closed like ProductFactsPort.
//
// Soft-delete model: products are marked deleted via `deletedAt` (ISO-8601 UTC); getMany excludes
// tombstones, listByTenant can include them with { includeDeleted: true }, and pruneTombstoned
// hard-deletes rows past a cutoff.

export interface CatalogProductVariant {
  variantId: string;
  title?: string;
  sku?: string;
  price?: string;            // display string, never numeric (mirrors ProductFact.price)
  currency?: string;
  availableForSale?: boolean; // boolean only (F8) — no raw stock count
  imageUrl?: string;
  options?: Record<string, string>;
}

export interface CatalogProductRecord {
  productId: string;         // Shopify product GID
  handle: string;
  title: string;
  descriptionHtml?: string;
  descriptionText?: string;
  productType?: string;
  vendor?: string;
  tags?: string[];
  status: "active" | "archived" | "draft";
  options?: { name: string; values: string[] }[];
  variants: CatalogProductVariant[];
  featuredImageUrl?: string;
  imageUrls?: string[];
  onlineStoreUrl?: string;
  contentHash: string;
  syncedAt: string;          // ISO-8601 UTC
  deletedAt?: string;        // ISO tombstone; unset = live
}

export interface CatalogProductPort {
  getMany(tenantId: string, productIds: string[]): Promise<CatalogProductRecord[]>; // excludes tombstoned
  listByTenant(tenantId: string, opts?: { limit?: number; includeDeleted?: boolean }): Promise<CatalogProductRecord[]>;
  upsertMany(tenantId: string, records: CatalogProductRecord[]): Promise<void>;
  softDeleteMany(tenantId: string, productIds: string[], opts: { at: string }): Promise<void>;
  pruneTombstoned(tenantId: string, opts: { olderThan: string }): Promise<number>;  // hard-delete, returns count
  deleteTenant(tenantId: string): Promise<void>;
}

/** A non-blank tenantId is REQUIRED on every op — an empty tenant is a cross-tenant wildcard, so we throw
 *  rather than widen scope (mirrors ProductFactsPort's `requireProductFactsTenant`). */
export function requireCatalogTenant(tenantId: string): string {
  if (!tenantId || !tenantId.trim())
    throw new Error("CatalogProductPort: a non-blank tenantId is required (tenant isolation)");
  return tenantId;
}

/** In-memory reference adapter — the behavioral oracle every durable adapter must match (the contract). */
export function createInMemoryCatalogProductStore(): CatalogProductPort {
  const byTenant = new Map<string, Map<string, CatalogProductRecord>>();
  return {
    async getMany(tenantId, productIds) {
      const t = requireCatalogTenant(tenantId);
      const records = byTenant.get(t);
      if (!records) return [];
      const out: CatalogProductRecord[] = [];
      // DISTINCT ids, matching behavior of ProductFactsPort
      for (const id of new Set(productIds)) {
        const r = records.get(id);
        if (r && !r.deletedAt) out.push({ ...deepCopy(r) });
      }
      return out;
    },
    async listByTenant(tenantId, opts) {
      const t = requireCatalogTenant(tenantId);
      const records = byTenant.get(t);
      if (!records) return [];
      const out: CatalogProductRecord[] = [];
      let count = 0;
      for (const r of records.values()) {
        if (opts?.includeDeleted || !r.deletedAt) {
          out.push({ ...deepCopy(r) });
          count++;
          if (opts?.limit && count >= opts.limit) break;
        }
      }
      return out;
    },
    async upsertMany(tenantId, records) {
      const t = requireCatalogTenant(tenantId);
      if (records.length === 0) return;
      let m = byTenant.get(t);
      if (!m) {
        m = new Map();
        byTenant.set(t, m);
      }
      for (const r of records) m.set(r.productId, deepCopy(r));
    },
    async softDeleteMany(tenantId, productIds, opts) {
      const t = requireCatalogTenant(tenantId);
      if (productIds.length === 0) return;
      const m = byTenant.get(t);
      if (!m) return;
      for (const id of productIds) {
        const r = m.get(id);
        if (r) {
          r.deletedAt = opts.at;
        }
      }
    },
    async pruneTombstoned(tenantId, opts) {
      const t = requireCatalogTenant(tenantId);
      const m = byTenant.get(t);
      if (!m) return 0;
      let count = 0;
      for (const [id, r] of Array.from(m.entries())) {
        if (r.deletedAt && r.deletedAt < opts.olderThan) {
          m.delete(id);
          count++;
        }
      }
      return count;
    },
    async deleteTenant(tenantId) {
      byTenant.delete(requireCatalogTenant(tenantId));
    },
  };
}

/** Deep copy helper for records (ensures no shared references between storage and returns). */
function deepCopy(r: CatalogProductRecord): CatalogProductRecord {
  return {
    ...r,
    tags: r.tags ? [...r.tags] : undefined,
    options: r.options ? r.options.map(o => ({ ...o, values: [...o.values] })) : undefined,
    variants: r.variants.map(v => ({ ...v, options: v.options ? { ...v.options } : undefined })),
    imageUrls: r.imageUrls ? [...r.imageUrls] : undefined,
  };
}
