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
// degrade-to-neutral behavior below and is unaffected by this change) UNLESS `unifiedLocalShell` is set —
// see Task 7 below.
//
// Historical note (superseded above for `getShell` only): the plan originally assumed Task 7 would write a
// per-tenant profile KV this port could read purely locally; Task 7 (durable-catalog-sync) did not, so
// `getContext`'s brand/policy fell back to `shellSource.getShell` — the existing, cheap storefront shell
// fetch — as a narrow, deliberate exception. `getContext`'s products are, and remain, entirely unaffected
// by any shellSource/store_profile failure (the durability invariant that matters for §8a invariant 11).
//
// TASK 7 (credential-enrollment-unification, CATALOG_UNIFIED, ADR-0023 D1) — closes the gap the note above
// describes as a "narrow, deliberate exception": when `unifiedLocalShell` is true, `getContext`'s own
// brand+policy ALSO read from `storeProfile` (the exact same `readLocalShell` helper `getShell` calls),
// retiring the residual Storefront call this file's header used to say `getContext` still made. Threaded as
// a per-construction FLAG (not "always prefer storeProfile") so every EXISTING caller of this port — which
// builds it with `localServingEnabled` but no unified cutover — keeps its current, tested `shellSource`
// behavior byte-for-byte; only the composition root's CATALOG_UNIFIED-gated construction sets it.

export interface LocalCatalogGroundingDeps {
  catalogProduct: CatalogProductPort;
  productFacts: ProductFactsPort;
  /** Brand + policy source for `getContext` when NOT unified (see file banner) — `getShell` never calls
   *  this, and neither does `getContext` when `unifiedLocalShell` is true. */
  shellSource: Pick<GroundingPort, "getShell">;
  /** Task 4: the local, tenant-scoped brand + policy record `getShell` serves from — no Shopify call. */
  storeProfile: Pick<StoreProfilePort, "get">;
  /**
   * Task 7 (CATALOG_UNIFIED) — when true, `getContext` reads brand+policy from `storeProfile` (via the
   * SAME `readLocalShell` helper `getShell` uses) instead of `shellSource.getShell`. Absent/false (the
   * default) ⇒ `getContext` is byte-identical to before this task — still `shellSource`.
   */
  unifiedLocalShell?: boolean;
}

/**
 * Task 4/7 — read brand+policy from the local `storeProfile` store, degrading to the SAME neutral default
 * on a missing profile OR a lookup failure (never a throw). Shared by `getShell` (always) and `getContext`
 * (only when `unifiedLocalShell` is set) so the two paths can never drift into two different "local shell"
 * implementations.
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

      // Durability invariant: PRODUCTS never depend on this call succeeding. A shell-source/store_profile
      // failure (Shopify down, credential revoked, missing profile row, …) degrades brand/policy to a
      // neutral default; the products above are already resolved and are returned regardless.
      let brandName = FALLBACK_BRAND;
      let policy = FALLBACK_POLICY;
      try {
        // Task 7 (CATALOG_UNIFIED): unified reads the SAME local source `getShell` does, below — no
        // Shopify/shellSource call at all when the flag is set. Flag absent/false ⇒ byte-identical to
        // before this task (still `shellSource.getShell`).
        const shell = deps.unifiedLocalShell ? await readLocalShell(deps, tenantId) : await deps.shellSource.getShell(tenantId);
        brandName = shell.brandName;
        policy = shell.policy;
      } catch {
        /* brand/policy degrade to the neutral default above; products are unaffected. `readLocalShell`
           never throws (it degrades internally) — this catch remains for the `shellSource` branch. */
      }
      return { tenantId, brandName, products, policy };
    },
    async getShell(tenantId: string): Promise<GroundingShell> {
      // Task 4: served entirely from the local `store_profile` store — no Shopify/shellSource call on
      // this path. See `readLocalShell` for the shared degrade-to-neutral logic (coordinator review fix
      // #1 still holds — this port never surfaces a raw upstream failure to the caller).
      return readLocalShell(deps, tenantId);
    },
    async getProductsByIds(tenantId: string, ids: string[]): Promise<Product[]> {
      if (ids.length === 0) return [];
      const records = await deps.catalogProduct.getMany(tenantId, ids);
      return hydrate(deps, tenantId, records);
    },
  };
}
