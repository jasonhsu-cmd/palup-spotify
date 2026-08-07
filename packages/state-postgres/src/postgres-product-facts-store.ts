import type { ProductFactsPort, ProductFact } from "@palup/platform-ports";
import { requireProductFactsTenant } from "@palup/platform-ports";
import type { Sql } from "./sql.js";

// Durable, portable ProductFactsPort adapter (ADR-0001 `product-facts`; ADR-0020 D2). Tier-2 fresh
// price/availability keyed by (tenant_id, product_id), so serving hydrates the top-K retrieved ids with
// ONE indexed batch read (`product_id = ANY($2)`) instead of a whole-catalog fetch. `tenant_id` is a REAL
// column and the PK prefix (mirrors PostgresVectorStore's tenant column) — every statement binds it, so a
// tenant can never read another's rows. Behavior-equivalent to the in-memory reference (the shared
// contract). NO stock-count column — availability is the boolean only (§8a inv 11).

interface PfRow {
  product_id: string;
  price: string;
  currency: string | null;
  available_for_sale: boolean | null;
  source: string | null;
  updated_at: string | Date | null;
}

export class PostgresProductFactsStore implements ProductFactsPort {
  constructor(private readonly sql: Sql) {}

  /** Create the table if absent. Idempotent; run at startup / in a migration step (mirrors
   *  PostgresVectorStore.migrate()). PRIMARY KEY (tenant_id, product_id) makes the batch read tenant-indexed. */
  async migrate(): Promise<void> {
    await this.sql.query(
      `CREATE TABLE IF NOT EXISTS product_facts (
         tenant_id text NOT NULL, product_id text NOT NULL, price text NOT NULL,
         currency text, available_for_sale boolean, source text, updated_at timestamptz,
         PRIMARY KEY (tenant_id, product_id))`,
    );
  }

  async getMany(tenantId: string, productIds: string[]): Promise<ProductFact[]> {
    const t = requireProductFactsTenant(tenantId);
    if (productIds.length === 0) return [];
    const { rows } = await this.sql.query<PfRow>(
      `SELECT product_id, price, currency, available_for_sale, source, updated_at
         FROM product_facts WHERE tenant_id=$1 AND product_id = ANY($2)`,
      [t, productIds],
    );
    return rows.map((r) => ({
      productId: r.product_id,
      price: r.price,
      // Omit unset optionals (null in the row) so the shape matches the in-memory adapter's exactly.
      ...(r.currency != null ? { currency: r.currency } : {}),
      ...(r.available_for_sale != null ? { availableForSale: r.available_for_sale } : {}),
      ...(r.source != null ? { source: r.source } : {}),
      ...(r.updated_at != null ? { updatedAt: new Date(r.updated_at).toISOString() } : {}),
    }));
  }

  async upsertMany(tenantId: string, facts: ProductFact[]): Promise<void> {
    const t = requireProductFactsTenant(tenantId);
    if (facts.length === 0) return;
    // Transactional: a mid-batch failure must leave EITHER every row persisted or NONE — never a partial,
    // unaudited set (same discipline as PostgresVectorStore.upsert).
    await this.sql.tx(async (tx) => {
      for (const f of facts) {
        await tx.query(
          `INSERT INTO product_facts (tenant_id, product_id, price, currency, available_for_sale, source, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (tenant_id, product_id) DO UPDATE SET
             price = EXCLUDED.price, currency = EXCLUDED.currency,
             available_for_sale = EXCLUDED.available_for_sale, source = EXCLUDED.source,
             updated_at = EXCLUDED.updated_at`,
          [
            t,
            f.productId,
            f.price,
            f.currency ?? null,
            f.availableForSale ?? null,
            f.source ?? null,
            f.updatedAt ?? null,
          ],
        );
      }
    });
  }

  async deleteTenant(tenantId: string): Promise<void> {
    const t = requireProductFactsTenant(tenantId);
    await this.sql.query("DELETE FROM product_facts WHERE tenant_id=$1", [t]);
  }
}
