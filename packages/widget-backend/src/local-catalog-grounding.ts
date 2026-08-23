import type {
  CatalogProductPort,
  CatalogProductRecord,
  GroundingContext,
  GroundingPort,
  GroundingShell,
  Product,
  ProductFact,
  ProductFactsPort,
  StorePolicy,
} from "@palup/platform-ports";
import { MAX_CATALOG_PRODUCTS } from "./shopify-grounding.js";

// Task 8 (durable-catalog-sync, spec §3/§13.4) — the LOCAL grounding port: serves catalog PRODUCTS
// entirely from `CatalogProductPort` + `ProductFactsPort`, calling Shopify for NOTHING on that path. This
// is the durability invariant made concrete: a backfilled tenant's catalog no longer depends on Shopify's
// Storefront API being reachable at serve time (Task 7's Bulk-Operations backfill is what populates the
// stores this port reads).
//
// BRAND + POLICY GAP — recorded, not silently assumed away. The plan for this task assumed Task 7 would
// write a per-tenant profile KV (brandName + policy) this port could read purely locally. VERIFIED against
// Task 7's actual scope (task-7-report.md, `packages/widget-backend/src/jobs/catalog-backfill.ts`): it
// writes ONLY a `BackfillManifest` (productId -> contentHash) under the `catalog_backfill` collection — no
// brand/policy KV exists anywhere in the codebase (grepped `packages/widget-backend/src` for
// "profile"/"brandName" writes; none found besides `GroundingContext`/`GroundingShell` themselves). So
// brand+policy here fall back to `shellSource.getShell` — the EXISTING, cheap, single-round-trip storefront
// shell fetch that `createCachingGroundingPort` already caches upstream — for those two fields ONLY. This
// is a deliberate, narrow exception to "no Shopify on this port": the catalog PRODUCTS path (`getContext`'s
// `products`, `getProductsByIds`) never touches `shellSource`, and even `getContext`'s own products are
// unaffected when the shell fetch fails (see below) — the durability invariant holds for the part that
// actually matters (§8a invariant 11 / money accuracy is about products, not the brand string). Populating
// a real local profile KV at backfill time is a follow-up, not invented here.

export interface LocalCatalogGroundingDeps {
  catalogProduct: CatalogProductPort;
  productFacts: ProductFactsPort;
  /** Brand + policy source (see file banner). Only `getShell` is ever called on it — never the
   *  whole-catalog `getContext`/`getProductsByIds`, which would defeat the durability invariant. */
  shellSource: Pick<GroundingPort, "getShell">;
}

/** Mirrors `mapStorefrontToContext`'s own fallback brand string (shopify-grounding.ts) so a shell-source
 *  failure degrades to the SAME neutral brand a Shopify outage already produces elsewhere. */
const FALLBACK_BRAND = "this store";
const FALLBACK_POLICY: StorePolicy = { returns: "", shipping: "" };

/** Thrown by `getContext` when the tenant's local catalog exceeds `MAX_CATALOG_PRODUCTS` — mirrors
 *  `storefrontFetch`'s own "hard-fail over truncation" ceiling (shopify-grounding.ts) so a >1000-SKU
 *  backfilled tenant is forced onto the S2/retrieval render path (getShell + getProductsByIds) exactly
 *  like a >1000-SKU Shopify-served tenant already is, rather than silently truncating (NN#5). */
export class LocalCatalogCeilingExceededError extends Error {
  constructor(tenantId: string) {
    super(`local catalog for tenant ${tenantId} exceeds the ${MAX_CATALOG_PRODUCTS}-product getContext ceiling`);
    this.name = "LocalCatalogCeilingExceededError";
  }
}

/**
 * Map one `CatalogProductRecord` (+ its fresh `ProductFact`, if any) to a `GroundingPort` `Product`.
 * PRICE/AVAILABILITY COME FROM `product_facts` (fresh) OVERLAID ON THE VARIANT COPY — per the durable
 * catalog-sync spec: `product_facts` is the Tier-2 fast-moving truth, `catalog_product`'s own variant price
 * is only the fallback when no fact has been recorded yet for this id (e.g. a product just backfilled,
 * before the next facts poll/webhook lands).
 */
export function mapCatalogRecordToProduct(r: CatalogProductRecord, fact: ProductFact | undefined): Product {
  const variant = r.variants[0];
  const price = fact?.price ?? variant?.price ?? "";
  const availableForSale = fact?.availableForSale ?? variant?.availableForSale;
  return {
    id: r.productId,
    title: r.title,
    description: r.descriptionText ?? "",
    price,
    ...(availableForSale !== undefined ? { availableForSale } : {}),
    ...(variant?.variantId ? { variantId: variant.variantId } : {}),
    ...(r.featuredImageUrl ? { imageUrl: r.featuredImageUrl } : {}),
    ...(r.handle ? { handle: r.handle } : {}),
    ...(r.tags && r.tags.length > 0 ? { tags: r.tags } : {}),
  };
}

/** Batch-hydrate a set of records with their fresh facts (a single `productFacts.getMany` round-trip,
 *  never per-record) into rendered `Product`s. Shared by `getContext` and `getProductsByIds`. */
async function hydrate(deps: LocalCatalogGroundingDeps, tenantId: string, records: CatalogProductRecord[]): Promise<Product[]> {
  if (records.length === 0) return [];
  const facts = await deps.productFacts.getMany(tenantId, records.map((r) => r.productId));
  const factById = new Map(facts.map((f) => [f.productId, f]));
  return records.map((r) => mapCatalogRecordToProduct(r, factById.get(r.productId)));
}

/**
 * The LOCAL `GroundingPort` — no Shopify dependency for catalog PRODUCTS. `getContext`/`getProductsByIds`
 * read ONLY `CatalogProductPort` + `ProductFactsPort`. Brand+policy (both `getContext` and `getShell`)
 * fall back to `shellSource` (see file banner), and a shell-source failure degrades EITHER method to the
 * SAME neutral default (never a throw) — `getContext`'s degrade additionally protects the already-resolved
 * products, which is the durability invariant this whole file exists for.
 */
export function createLocalCatalogGroundingPort(deps: LocalCatalogGroundingDeps): GroundingPort {
  return {
    async getContext(tenantId: string): Promise<GroundingContext> {
      // Fetch one past the ceiling so an over-ceiling catalog is DETECTED (and refused) rather than
      // silently truncated to exactly MAX_CATALOG_PRODUCTS — mirrors storefrontFetch's own ceiling check.
      const records = await deps.catalogProduct.listByTenant(tenantId, { limit: MAX_CATALOG_PRODUCTS + 1 });
      if (records.length > MAX_CATALOG_PRODUCTS) throw new LocalCatalogCeilingExceededError(tenantId);
      const products = await hydrate(deps, tenantId, records);

      // Durability invariant: PRODUCTS never depend on this call succeeding. A shell-source failure
      // (Shopify down, credential revoked, …) degrades brand/policy to a neutral default; the products
      // above are already resolved and are returned regardless.
      let brandName = FALLBACK_BRAND;
      let policy = FALLBACK_POLICY;
      try {
        const shell = await deps.shellSource.getShell(tenantId);
        brandName = shell.brandName;
        policy = shell.policy;
      } catch {
        /* brand/policy degrade to the neutral default above; products are unaffected */
      }
      return { tenantId, brandName, products, policy };
    },
    async getShell(tenantId: string): Promise<GroundingShell> {
      // Symmetric with getContext's own degrade: a shell-source failure (Shopify down, credential
      // revoked, …) fails CLOSED to the same neutral default rather than throwing. `getShell` has no
      // products to protect, but this port should never surface a raw upstream failure any differently
      // than `getContext` does for the identical dependency (coordinator review fix #1).
      try {
        return await deps.shellSource.getShell(tenantId);
      } catch {
        return { tenantId, brandName: FALLBACK_BRAND, policy: FALLBACK_POLICY };
      }
    },
    async getProductsByIds(tenantId: string, ids: string[]): Promise<Product[]> {
      if (ids.length === 0) return [];
      const records = await deps.catalogProduct.getMany(tenantId, ids);
      return hydrate(deps, tenantId, records);
    },
  };
}
