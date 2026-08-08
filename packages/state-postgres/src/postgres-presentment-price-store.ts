import type { PresentmentPricePort, PresentmentPrice } from "@palup/platform-ports";
import { requirePresentmentTenant, requirePresentmentCurrency } from "@palup/platform-ports";
import type { Sql } from "./sql.js";

// Durable, portable PresentmentPricePort adapter (ADR-0001; ADR-0020 B-T3). Merchant-published per-currency
// prices keyed by (tenant_id, product_id, currency), so serving hydrates the top-K retrieved ids in the
// shopper's currency with ONE indexed batch read (`product_id = ANY($2)` filtered by currency) instead of
// a whole-catalog fetch. `tenant_id` is a REAL column and the PK prefix — every statement binds it, so a
// tenant can never read another's rows. Behavior-equivalent to the in-memory reference (the shared
// contract). MONEY-SAFETY: `price` is the merchant's own DISPLAY STRING for that currency — never computed
// or converted here (see presentment-price-port.ts).

interface PpRow {
  product_id: string;
  currency: string;
  price: string;
  source: string | null;
  updated_at: string | Date | null;
}

export class PostgresPresentmentPriceStore implements PresentmentPricePort {
  constructor(private readonly sql: Sql) {}

  /** Create the table if absent. Idempotent; run at startup / in a migration step. PRIMARY KEY
   *  (tenant_id, product_id, currency) makes the per-currency batch read tenant-indexed. */
  async migrate(): Promise<void> {
    await this.sql.query(
      `CREATE TABLE IF NOT EXISTS presentment_prices (
         tenant_id text NOT NULL, product_id text NOT NULL, currency text NOT NULL, price text NOT NULL,
         source text, updated_at timestamptz,
         PRIMARY KEY (tenant_id, product_id, currency))`,
    );
  }

  async getMany(tenantId: string, productIds: string[], currency: string): Promise<PresentmentPrice[]> {
    const t = requirePresentmentTenant(tenantId);
    const cur = requirePresentmentCurrency(currency);
    if (productIds.length === 0) return [];
    const { rows } = await this.sql.query<PpRow>(
      `SELECT product_id, currency, price, source, updated_at
         FROM presentment_prices WHERE tenant_id=$1 AND currency=$2 AND product_id = ANY($3)`,
      [t, cur, productIds],
    );
    return rows.map((r) => ({
      productId: r.product_id,
      currency: r.currency,
      price: r.price,
      ...(r.source != null ? { source: r.source } : {}),
      ...(r.updated_at != null ? { updatedAt: new Date(r.updated_at).toISOString() } : {}),
    }));
  }

  async upsertMany(tenantId: string, prices: PresentmentPrice[]): Promise<void> {
    const t = requirePresentmentTenant(tenantId);
    if (prices.length === 0) return;
    // Transactional: a mid-batch failure must leave EITHER every row persisted or NONE (same discipline as
    // PostgresProductFactsStore).
    await this.sql.tx(async (tx) => {
      for (const p of prices) {
        const cur = requirePresentmentCurrency(p.currency);
        await tx.query(
          `INSERT INTO presentment_prices (tenant_id, product_id, currency, price, source, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (tenant_id, product_id, currency) DO UPDATE SET
             price = EXCLUDED.price, source = EXCLUDED.source, updated_at = EXCLUDED.updated_at`,
          [t, p.productId, cur, p.price, p.source ?? null, p.updatedAt ?? null],
        );
      }
    });
  }

  async deleteTenant(tenantId: string): Promise<void> {
    const t = requirePresentmentTenant(tenantId);
    await this.sql.query("DELETE FROM presentment_prices WHERE tenant_id=$1", [t]);
  }
}
