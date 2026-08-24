import type { StoreProfilePort, StoreProfileRecord } from "@palup/platform-ports";
import { requireStoreProfileTenant } from "@palup/platform-ports";
import type { Sql } from "./sql.js";

// Durable, portable StoreProfilePort adapter (ADR-0001; credential-enrollment-unification Task 2). Owns
// the `store_profile` table — the local source of truth for serving `getShell`, replacing the live
// Storefront-API shell fetch. ONE row per tenant (PRIMARY KEY (tenant_id) — no product/entity dimension,
// unlike PostgresProductFactsStore/PostgresCatalogProductStore), so `put` is a plain upsert rather than a
// batch. `policy` is stored as a single jsonb column so its shape (returns/shipping/optional allergens)
// can evolve without a migration. Tenant-bound like every store here — every statement binds tenant_id=$1.

interface SpRow {
  brand_name: string;
  policy: StoreProfileRecord["policy"];
}

export class PostgresStoreProfileStore implements StoreProfilePort {
  constructor(private readonly sql: Sql) {}

  /** Create the table if absent. Idempotent; one statement per `sql.query()` call so this runs unchanged
   *  on both node-postgres (Cloud SQL / Spanner-pg) and the pglite test engine. PRIMARY KEY (tenant_id)
   *  — one profile per tenant. */
  async migrate(): Promise<void> {
    await this.sql.query(
      `CREATE TABLE IF NOT EXISTS store_profile (
         tenant_id text NOT NULL,
         brand_name text,
         policy jsonb,
         updated_at timestamptz,
         PRIMARY KEY (tenant_id))`,
    );
  }

  async get(tenantId: string): Promise<StoreProfileRecord | null> {
    const t = requireStoreProfileTenant(tenantId);
    const { rows } = await this.sql.query<SpRow>(
      `SELECT brand_name, policy FROM store_profile WHERE tenant_id=$1`,
      [t],
    );
    const row = rows[0];
    if (!row) return null;
    return { brandName: row.brand_name, policy: row.policy };
  }

  async put(tenantId: string, profile: StoreProfileRecord): Promise<void> {
    const t = requireStoreProfileTenant(tenantId);
    await this.sql.query(
      `INSERT INTO store_profile (tenant_id, brand_name, policy, updated_at)
         VALUES ($1,$2,$3,now())
       ON CONFLICT (tenant_id) DO UPDATE SET
         brand_name = EXCLUDED.brand_name,
         policy = EXCLUDED.policy,
         updated_at = EXCLUDED.updated_at`,
      [t, profile.brandName, JSON.stringify(profile.policy)],
    );
  }

  async deleteTenant(tenantId: string): Promise<void> {
    const t = requireStoreProfileTenant(tenantId);
    await this.sql.query(`DELETE FROM store_profile WHERE tenant_id=$1`, [t]);
  }
}
