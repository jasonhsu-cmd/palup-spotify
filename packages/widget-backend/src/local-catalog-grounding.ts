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
// BRAND + POLICY — Task 4 (credential-enrollment-unification, 2026-08-24) closed the gap recorded below for
// `getShell`: it now reads Task 2's `store_profile` (`StoreProfilePort`) directly — a local, tenant-scoped
// KV that Task 3's unified ingestion populates from the Admin API at backfill time — so the S2 render path
// (`getShell`) makes NO Shopify/shellSource call at all. `getContext` still falls back to `shellSource` for
// its own brand/policy fields (out of Task 4's scope — the whole-catalog path already carries the identical
// degrade-to-neutral behavior below and is unaffected by this change).
//
// Historical note (superseded above for `getShell` only): the plan originally assumed Task 7 would write a
// per-tenant profile KV this port could read purely locally; Task 7 (durable-catalog-sync) did not, so
// `getContext`'s brand/policy fell back to `shellSource.getShell` — the existing, cheap storefront shell
// fetch — as a narrow, deliberate exception. `getContext`'s products are, and remain, entirely unaffected
// by any shellSource/store_profile failure (the durability invariant that matters for §8a invariant 11).

export interface LocalCatalogGroundingDeps {
  catalogProduct: CatalogProductPort;
  productFacts: ProductFactsPort;
  /** Brand + policy source for `getContext` only (see file banner) — `getShell` no longer calls this. */
  shellSource: Pick<GroundingPort, "getShell">;
  /** Task 4: the local, tenant-scoped brand + policy record `getShell` serves from — no Shopify call. */
  storeProfile: Pick<StoreProfilePort, "get">;
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
 * The LOCAL `GroundingPort` — no Shopify dependency for catalog PRODUCTS, and (as of Task 4) none for
 * `getShell` either. `getContext`/`getProductsByIds` read ONLY `CatalogProductPort` + `ProductFactsPort`
 * for products. `getShell` reads ONLY the local `storeProfile` store for brand+policy — no Shopify call.
 * `getContext`'s own brand+policy still fall back to `shellSource` (see file banner; out of Task 4's
 * scope), and a failure there degrades it to the SAME neutral default `getShell` uses (never a throw) —
 * `getContext`'s degrade additionally protects the already-resolved products, which is the durability
 * invariant this whole file exists for.
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
      // Task 4: served entirely from the local `store_profile` store — no Shopify/shellSource call on
      // this path. Symmetric with getContext's own degrade: a missing profile OR a store_profile lookup
      // failure fails CLOSED to the same neutral default rather than throwing (coordinator review fix #1
      // still holds — this port never surfaces a raw upstream failure to the caller).
      try {
        const profile = await deps.storeProfile.get(tenantId);
        if (!profile) return { tenantId, brandName: FALLBACK_BRAND, policy: FALLBACK_POLICY };
        return { tenantId, brandName: profile.brandName, policy: profile.policy };
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
