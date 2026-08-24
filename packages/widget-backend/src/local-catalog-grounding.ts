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
  StoreProfilePort,
} from "@palup/platform-ports";
import { MAX_CATALOG_PRODUCTS } from "./shopify-grounding.js";

// Task 8 (durable-catalog-sync, spec §3/§13.4) — the LOCAL grounding port: serves catalog PRODUCTS
// entirely from `CatalogProductPort` + `ProductFactsPort`, calling Shopify for NOTHING on that path. This
// is the durability invariant made concrete: a backfilled tenant's catalog no longer depends on Shopify's
// Storefront API being reachable at serve time (Task 7's Bulk-Operations backfill is what populates the
// stores this port reads).
//
// BRAND + POLICY — unified-cutover-cleanup (2026-08-24): `getContext` AND `getShell` now ALWAYS read
// brand+policy from the local `store_profile` store (`StoreProfilePort`), via the shared `readLocalShell`
// helper below. This used to be conditional on a `unifiedLocalShell` flag (credential-enrollment-
// unification's CATALOG_UNIFIED cutover); the owner made that cutover the ONLY behavior and the flag/OFF
// path (falling back to a `shellSource` — the Storefront-or-fixtures shell) was deleted as dead code. A
// `store_profile` miss or lookup failure degrades to the SAME neutral default it always has — never a
// throw — and `getContext`'s products remain entirely unaffected by any such failure, which is the
// durability invariant that matters for §8a invariant 11.

export interface LocalCatalogGroundingDeps {
  catalogProduct: CatalogProductPort;
  productFacts: ProductFactsPort;
  /** The local, tenant-scoped brand + policy record `getContext`/`getShell` ALWAYS serve from — no
   *  Shopify call on that path. A missing row or a lookup failure degrades to the neutral default via
   *  `readLocalShell` (never a throw). */
  storeProfile: Pick<StoreProfilePort, "get">;
}

/**
 * Read brand+policy from the local `storeProfile` store, degrading to the SAME neutral default on a
 * missing profile OR a lookup failure (never a throw). Shared by `getShell` and `getContext` so the two
 * paths can never drift into two different "local shell" implementations.
 */
async function readLocalShell(deps: Pick<LocalCatalogGroundingDeps, "storeProfile">, tenantId: string): Promise<GroundingShell> {
  try {
    const profile = await deps.storeProfile.get(tenantId);
    if (!profile) return { tenantId, brandName: FALLBACK_BRAND, policy: FALLBACK_POLICY };
    return { tenantId, brandName: profile.brandName, policy: profile.policy };
  } catch {
    return { tenantId, brandName: FALLBACK_BRAND, policy: FALLBACK_POLICY };
  }
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
 * The LOCAL `GroundingPort` — no Shopify dependency for catalog PRODUCTS or for brand/policy.
 * `getContext`/`getProductsByIds` read ONLY `CatalogProductPort` + `ProductFactsPort` for products.
 * `getContext` and `getShell` both ALWAYS read brand+policy from the local `storeProfile` store. Either
 * way a failure degrades to the SAME neutral default (never a throw) — `getContext`'s degrade additionally
 * protects the already-resolved products, which is the durability invariant this whole file exists for.
 */
export function createLocalCatalogGroundingPort(deps: LocalCatalogGroundingDeps): GroundingPort {
  return {
    async getContext(tenantId: string): Promise<GroundingContext> {
      // Fetch one past the ceiling so an over-ceiling catalog is DETECTED (and refused) rather than
      // silently truncated to exactly MAX_CATALOG_PRODUCTS — mirrors storefrontFetch's own ceiling check.
      const records = await deps.catalogProduct.listByTenant(tenantId, { limit: MAX_CATALOG_PRODUCTS + 1 });
      if (records.length > MAX_CATALOG_PRODUCTS) throw new LocalCatalogCeilingExceededError(tenantId);
      const products = await hydrate(deps, tenantId, records);

      // Durability invariant: PRODUCTS never depend on this call succeeding. A store_profile failure
      // (missing profile row, DB error, …) degrades brand/policy to a neutral default; the products above
      // are already resolved and are returned regardless. `readLocalShell` never throws internally — this
      // try/catch is defense-in-depth so a future change to that invariant still can't take products down.
      let brandName = FALLBACK_BRAND;
      let policy = FALLBACK_POLICY;
      try {
        const shell = await readLocalShell(deps, tenantId);
        brandName = shell.brandName;
        policy = shell.policy;
      } catch {
        /* brand/policy degrade to the neutral default above; products are unaffected. */
      }
      return { tenantId, brandName, products, policy };
    },
    async getShell(tenantId: string): Promise<GroundingShell> {
      return readLocalShell(deps, tenantId);
    },
    async getProductsByIds(tenantId: string, ids: string[]): Promise<Product[]> {
      if (ids.length === 0) return [];
      const records = await deps.catalogProduct.getMany(tenantId, ids);
      return hydrate(deps, tenantId, records);
    },
  };
}
