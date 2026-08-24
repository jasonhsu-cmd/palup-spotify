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
// BRAND + POLICY — Task 4 (credential-enrollment-unification, 2026-08-24) added Task 2's `store_profile`
// (`StoreProfilePort`) as a brand/policy source — a local, tenant-scoped KV that Task 3's unified ingestion
// populates from the Admin API at backfill time. Final-review Critical fix (2026-08-24, same day): `getShell`
// initially read it UNCONDITIONALLY (a gap left over from before `unifiedLocalShell` existed); it is now
// gated on `unifiedLocalShell` exactly like `getContext` below — see Task 7. With the flag off (the default),
// `getShell` falls back to `shellSource`, same as `getContext` always has.
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
  /** Brand + policy source for `getContext` AND `getShell` when NOT unified (see file banner) — neither
   *  calls this when `unifiedLocalShell` is true. */
  shellSource: Pick<GroundingPort, "getShell">;
  /** Task 4/7: the local, tenant-scoped brand + policy record `getContext`/`getShell` serve from ONLY
   *  when `unifiedLocalShell` is true — no Shopify call on that path. */
  storeProfile: Pick<StoreProfilePort, "get">;
  /**
   * Task 7 (CATALOG_UNIFIED) — when true, BOTH `getContext` and `getShell` read brand+policy from
   * `storeProfile` (via the shared `readLocalShell` helper) instead of `shellSource.getShell`.
   * Absent/false (the default) ⇒ both are byte-identical to before this task — still `shellSource`.
   */
  unifiedLocalShell?: boolean;
}

/**
 * Task 4/7 — read brand+policy from the local `storeProfile` store, degrading to the SAME neutral default
 * on a missing profile OR a lookup failure (never a throw). Shared by `getShell` and `getContext`, both
 * only when `unifiedLocalShell` is set, so the two paths can never drift into two different "local shell"
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
 * The LOCAL `GroundingPort` — no Shopify dependency for catalog PRODUCTS. `getContext`/`getProductsByIds`
 * read ONLY `CatalogProductPort` + `ProductFactsPort` for products. `getContext` and `getShell` both read
 * brand+policy from the local `storeProfile` store ONLY when `unifiedLocalShell` is true (Task 7); with the
 * flag off (the default) both fall back to `shellSource` instead, byte-identical to before Task 4/7. Either
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
      // Final-review Critical fix (2026-08-24): this MUST mirror getContext's own gate above — `getShell`
      // was left unconditionally reading the local `store_profile` store from before `unifiedLocalShell`
      // existed (Task 4, pre-dating Task 7's flag) and was never retrofitted. With the flag off (the
      // documented-safe default) that meant a backfilled tenant's `getShell` read whatever `store_profile`
      // handle this port was constructed with — an always-empty in-memory store in the CATALOG_UNIFIED-off
      // composition (server.ts never wires a persisted one) — degrading brand+policy to the neutral
      // FALLBACK on every call, instead of the real shellSource/fixtures shell `getContext` already fell
      // back to. See `readLocalShell` for the shared degrade-to-neutral logic (coordinator review fix #1
      // still holds — this port never surfaces a raw upstream failure to the caller either way).
      return deps.unifiedLocalShell ? readLocalShell(deps, tenantId) : deps.shellSource.getShell(tenantId);
    },
    async getProductsByIds(tenantId: string, ids: string[]): Promise<Product[]> {
      if (ids.length === 0) return [];
      const records = await deps.catalogProduct.getMany(tenantId, ids);
      return hydrate(deps, tenantId, records);
    },
  };
}
