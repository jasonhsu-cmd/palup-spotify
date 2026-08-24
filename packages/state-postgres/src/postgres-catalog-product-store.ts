import type { CatalogProductPort, CatalogProductRecord, CatalogProductVariant } from "@palup/platform-ports";
import { requireCatalogTenant } from "@palup/platform-ports";
import type { Sql } from "./sql.js";

// Durable, portable CatalogProductPort adapter (ADR-0001; the durable-catalog-sync feature). Owns the
// `catalog_product` table keyed by (tenant_id, product_id) — mirrors PostgresProductFactsStore's shape
// (Shape A) but carries full Shopify product metadata plus a soft-delete lifecycle (tombstone then
// prune) instead of a single fresh-fact row. NO raw stock-count column anywhere — `availableForSale` is
// a boolean living inside the `variants` jsonb blob (F8 data minimization), same discipline as
// ProductFact.availableForSale.

interface CpRow {
  product_id: string;
  handle: string;
  title: string;
  description_html: string | null;
  description_text: string | null;
  product_type: string | null;
  vendor: string | null;
  tags: string[] | null;
  status: string;
  options: { name: string; values: string[] }[] | null;
  variants: CatalogProductVariant[];
  featured_image_url: string | null;
  image_urls: string[] | null;
  online_store_url: string | null;
  content_hash: string;
  synced_at: string | Date;
  deleted_at: string | Date | null;
}

function rowToRecord(r: CpRow): CatalogProductRecord {
  return {
    productId: r.product_id,
    handle: r.handle,
    title: r.title,
    ...(r.description_html != null ? { descriptionHtml: r.description_html } : {}),
    ...(r.description_text != null ? { descriptionText: r.description_text } : {}),
    ...(r.product_type != null ? { productType: r.product_type } : {}),
    ...(r.vendor != null ? { vendor: r.vendor } : {}),
    ...(r.tags != null ? { tags: r.tags } : {}),
    status: r.status as CatalogProductRecord["status"],
    ...(r.options != null ? { options: r.options } : {}),
    variants: r.variants,
    ...(r.featured_image_url != null ? { featuredImageUrl: r.featured_image_url } : {}),
    ...(r.image_urls != null ? { imageUrls: r.image_urls } : {}),
    ...(r.online_store_url != null ? { onlineStoreUrl: r.online_store_url } : {}),
    contentHash: r.content_hash,
    syncedAt: new Date(r.synced_at).toISOString(),
    ...(r.deleted_at != null ? { deletedAt: new Date(r.deleted_at).toISOString() } : {}),
  };
}

export class PostgresCatalogProductStore implements CatalogProductPort {
  constructor(private readonly sql: Sql) {}

  /** Create the table if absent. Idempotent; one statement per `sql.query()` call so this runs
   *  unchanged on both node-postgres (Cloud SQL / Spanner-pg) and the pglite test engine. PRIMARY KEY
   *  (tenant_id, product_id) makes every read tenant-indexed (mirrors PostgresProductFactsStore). */
  async migrate(): Promise<void> {
    await this.sql.query(
      `CREATE TABLE IF NOT EXISTS catalog_product (
         tenant_id text NOT NULL,
         product_id text NOT NULL,
         handle text NOT NULL,
         title text NOT NULL,
         description_html text,
         description_text text,
         product_type text,
         vendor text,
         tags text[],
         status text NOT NULL,
         options jsonb,
         variants jsonb NOT NULL DEFAULT '[]'::jsonb,
         featured_image_url text,
         image_urls text[],
         online_store_url text,
         content_hash text NOT NULL,
         synced_at timestamptz NOT NULL,
         deleted_at timestamptz,
         PRIMARY KEY (tenant_id, product_id))`,
    );
    await this.sql.query(
      `CREATE INDEX IF NOT EXISTS catalog_product_live_idx ON catalog_product (tenant_id) WHERE deleted_at IS NULL`,
    );
  }

  async getMany(tenantId: string, productIds: string[]): Promise<CatalogProductRecord[]> {
    const t = requireCatalogTenant(tenantId);
    if (productIds.length === 0) return [];
    const { rows } = await this.sql.query<CpRow>(
      `SELECT product_id, handle, title, description_html, description_text, product_type, vendor, tags,
              status, options, variants, featured_image_url, image_urls, online_store_url, content_hash,
              synced_at, deleted_at
         FROM catalog_product
        WHERE tenant_id=$1 AND product_id = ANY($2::text[]) AND deleted_at IS NULL`,
      [t, productIds],
    );
    return rows.map(rowToRecord);
  }

  async listByTenant(
    tenantId: string,
    opts?: { limit?: number; includeDeleted?: boolean },
  ): Promise<CatalogProductRecord[]> {
    const t = requireCatalogTenant(tenantId);
    const clauses = ["tenant_id=$1"];
    if (!opts?.includeDeleted) clauses.push("deleted_at IS NULL");
    let text = `SELECT product_id, handle, title, description_html, description_text, product_type, vendor, tags,
              status, options, variants, featured_image_url, image_urls, online_store_url, content_hash,
              synced_at, deleted_at
         FROM catalog_product WHERE ${clauses.join(" AND ")}`;
    const params: unknown[] = [t];
    if (opts?.limit != null) {
      params.push(opts.limit);
      text += ` LIMIT $${params.length}`;
    }
    const { rows } = await this.sql.query<CpRow>(text, params);
    return rows.map(rowToRecord);
  }

  async upsertMany(tenantId: string, records: CatalogProductRecord[]): Promise<void> {
    const t = requireCatalogTenant(tenantId);
    if (records.length === 0) return;
    // Transactional: a mid-batch failure must leave EITHER every row persisted or NONE (same discipline
    // as PostgresProductFactsStore.upsertMany / PostgresVectorStore.upsert).
    await this.sql.tx(async (tx) => {
      for (const r of records) {
        await tx.query(
          `INSERT INTO catalog_product
             (tenant_id, product_id, handle, title, description_html, description_text, product_type,
              vendor, tags, status, options, variants, featured_image_url, image_urls, online_store_url,
              content_hash, synced_at, deleted_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NULL)
           ON CONFLICT (tenant_id, product_id) DO UPDATE SET
             handle = EXCLUDED.handle,
             title = EXCLUDED.title,
             description_html = EXCLUDED.description_html,
             description_text = EXCLUDED.description_text,
             product_type = EXCLUDED.product_type,
             vendor = EXCLUDED.vendor,
             tags = EXCLUDED.tags,
             status = EXCLUDED.status,
             options = EXCLUDED.options,
             variants = EXCLUDED.variants,
             featured_image_url = EXCLUDED.featured_image_url,
             image_urls = EXCLUDED.image_urls,
             online_store_url = EXCLUDED.online_store_url,
             content_hash = EXCLUDED.content_hash,
             synced_at = EXCLUDED.synced_at,
             deleted_at = NULL`,
          [
            t,
            r.productId,
            r.handle,
            r.title,
            r.descriptionHtml ?? null,
            r.descriptionText ?? null,
            r.productType ?? null,
            r.vendor ?? null,
            r.tags ?? null,
            r.status,
            r.options != null ? JSON.stringify(r.options) : null,
            JSON.stringify(r.variants),
            r.featuredImageUrl ?? null,
            r.imageUrls ?? null,
            r.onlineStoreUrl ?? null,
            r.contentHash,
            r.syncedAt,
          ],
        );
      }
    });
  }

  async softDeleteMany(tenantId: string, productIds: string[], opts: { at: string }): Promise<void> {
    const t = requireCatalogTenant(tenantId);
    if (productIds.length === 0) return;
    await this.sql.query(
      "UPDATE catalog_product SET deleted_at=$3 WHERE tenant_id=$1 AND product_id = ANY($2::text[])",
      [t, productIds, opts.at],
    );
  }

  async pruneTombstoned(tenantId: string, opts: { olderThan: string }): Promise<number> {
    const t = requireCatalogTenant(tenantId);
    const { rows } = await this.sql.query<{ product_id: string }>(
      "DELETE FROM catalog_product WHERE tenant_id=$1 AND deleted_at IS NOT NULL AND deleted_at < $2 RETURNING product_id",
      [t, opts.olderThan],
    );
    return rows.length;
  }

  async deleteTenant(tenantId: string): Promise<void> {
    const t = requireCatalogTenant(tenantId);
    await this.sql.query("DELETE FROM catalog_product WHERE tenant_id=$1", [t]);
  }
}
