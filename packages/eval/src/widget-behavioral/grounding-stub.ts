import type { GroundingPort, GroundingContext, GroundingShell, Product, StorePolicy } from "@palup/platform-ports";

/**
 * Task 5 — injectable grounding STUB config for grounding-integrity behavioral cases. Drives each
 * source-state (empty catalog / throw / price-unconfirmed) deterministically on the Layer-1 mock
 * path. `memoryFacts` is consumed by brain-factory.ts (Task 5), not by `makeStubGrounding` itself —
 * cross-visit memory is a SEPARATE port (`MemoryRecallPort`, widget-brain/src/types.ts), never part
 * of `GroundingPort`.
 */
export type GroundingStubConfig = {
  /** Catalog to serve; `[]` (or absent) => empty catalog, the fail-closed "we carry nothing" case. */
  products?: Product[];
  /** Simulate the getContext throw / timeout path. Only `getContext` throws — `getShell` and
   *  `getProductsByIds` are unaffected, matching the flag's name. */
  throwOnGetContext?: boolean;
  policy?: StorePolicy;
  /** `false` overlays `priceConfirmed: false` onto every served product (A1b/D2 price-unconfirmed
   *  hedge shape — see `Product.priceConfirmed` in grounding-port.ts). Absent/`true` leaves each
   *  product's own `priceConfirmed` (usually unset === confirmed) untouched. */
  priceConfirmed?: boolean;
  /** Cross-visit memory facts for the case (Task 5's `memory` port slot); consumed by brain-factory.ts. */
  memoryFacts?: { text: string; tier: "ordinary" | "special" }[];
};

/**
 * Builds a deterministic `GroundingPort` from a `GroundingStubConfig` — no network, no state beyond
 * the config, satisfying the real port interface (packages/platform-ports/src/grounding-port.ts)
 * exactly, so it drops in for `StaticGroundingAdapter` with zero brain-side changes.
 */
export function makeStubGrounding(cfg: GroundingStubConfig): GroundingPort {
  const policy: StorePolicy = cfg.policy ?? { returns: "", shipping: "" };
  const baseProducts: Product[] = cfg.products ?? [];
  // Overlay priceConfirmed:false onto every product when requested, mirroring the A1b hydrate
  // step's shape (a per-product boolean on the SAME Product, never a separate field/list).
  const products: Product[] =
    cfg.priceConfirmed === false ? baseProducts.map((p) => ({ ...p, priceConfirmed: false })) : baseProducts;

  return {
    async getContext(tenantId: string): Promise<GroundingContext> {
      if (cfg.throwOnGetContext) throw new Error("stub getContext failure");
      // Per-call copy, exactly like StaticGroundingAdapter, so a caller mutating the returned
      // context/products can never corrupt this stub's own config across calls.
      return {
        tenantId,
        brandName: "Test Store",
        products: products.map((p) => ({ ...p })),
        policy: { ...policy },
      };
    },

    async getShell(tenantId: string): Promise<GroundingShell> {
      // S2 — brand + policy ONLY, no products. Deliberately independent of `throwOnGetContext`
      // (that flag names `getContext` specifically); the Layer-1 harness never enables catalog
      // retrieval so this method is not on the path these cases exercise, but it must still satisfy
      // the port contract for any caller that does reach it.
      return { tenantId, brandName: "Test Store", policy: { ...policy } };
    },

    async getProductsByIds(_tenantId: string, ids: string[]): Promise<Product[]> {
      // Contract: unknown ids are OMITTED, never a throw/placeholder; ids.length===0 => [].
      if (ids.length === 0) return [];
      const byId = new Map(products.map((p) => [p.id, p]));
      const out: Product[] = [];
      for (const id of ids) {
        const p = byId.get(id);
        if (p) out.push({ ...p });
      }
      return out;
    },
  };
}
