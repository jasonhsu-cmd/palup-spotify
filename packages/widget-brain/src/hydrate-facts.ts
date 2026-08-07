import type { Product, ProductFact } from "@palup/platform-ports";

// A1b (ADR-0020) — HYDRATE-BY-ID: overlay the Tier-2 `ProductFactsPort`'s fresh money-facts (price,
// availability) onto the products the brain is about to render. Pure and total — no I/O, never throws.
//
// WHY AN OVERLAY, NOT A REPLACEMENT. `ProductFact` deliberately carries only the VOLATILE money facts
// (price, availableForSale) and NOT the stable ones (title, description, tags, ingredients) — see
// product-facts-port.ts. So a fact cannot build a `Product`; it can only refresh one. Title/description
// stay from the live `GroundingContext`; price/availability become the fresher Tier-2 values. This is the
// serving half of the freshness SLA (D2): the quoted price — a money/NN#1 fact — comes from the store the
// ingestion path (A3) keeps within the freshness target, not from the 30-min catalog cache.
//
// FAIL-SAFE / CONSERVATIVE. A product with NO matching fact is returned UNCHANGED (the fact store is a
// sparse overlay, never authoritative about which products exist — the live catalog is). `availableForSale`
// is overlaid ONLY when the fact states it (three-state preserved: a fact that omits it must not flip a
// product's known availability to "unknown"). Products keep their original ORDER and identity.
//
// GOVERNANCE. Changing which price the agent quotes is a money-fact change (NN#1), so this runs only behind
// the PRODUCT_FACTS_HYDRATION posture flag and, being a run-time behaviour change, is enabled only through
// the eval gate → shadow → canary → human promotion (HITL §5) — never by this build. Inert until then.

/**
 * Overlay fresh price/availability from `facts` onto `products`, matched by id. Returns a new array (new
 * objects only where a fact applied); `products` and `facts` are not mutated. Unmatched products pass
 * through unchanged. O(products + facts).
 */
export function hydrateProductFacts(products: Product[], facts: ProductFact[]): Product[] {
  if (facts.length === 0) return products;
  const byId = new Map<string, ProductFact>();
  // Last write wins on a duplicate id — matches ProductFactsPort.getMany's own de-dup contract.
  for (const f of facts) byId.set(f.productId, f);
  return products.map((p) => {
    const fact = byId.get(p.id);
    if (!fact) return p;
    const next: Product = { ...p, price: fact.price };
    // Only an explicitly-stated availability overwrites; an absent fact value leaves the product's own.
    if (fact.availableForSale !== undefined) next.availableForSale = fact.availableForSale;
    return next;
  });
}
