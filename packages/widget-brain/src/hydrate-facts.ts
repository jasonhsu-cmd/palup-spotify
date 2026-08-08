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
//
// PROMOTION BLOCKER — READ BEFORE ENABLING (security review, A1b #252). This overlay reads only
// `fact.price`/`fact.availableForSale` and IGNORES `fact.updatedAt`, so a well-formed but semantically
// STALE fact would be quoted verbatim with no upper bound on age. ADR-0020 D2's fail-honest rule ("past a
// hard staleness ceiling the agent says 'let me confirm current price/availability' rather than quote a
// stale number") is DEFERRED and NOT implemented here. Enabling PRODUCT_FACTS_HYDRATION in ANY live stage
// (shadow/canary/prod) is therefore blocked until D2 fail-honest lands — otherwise a stale fact silently
// poisons a money/NN#1 fact. The promoter MUST record "D2 staleness ceiling implemented" as an explicit
// pre-shadow acceptance criterion. Safe to merge now only because the feature is inert (flag OFF; even
// flag-on the store is empty until the A3 producer lands).

/**
 * D2 (ADR-0020) — the hard STALENESS CEILING for hydration. When `staleness` is supplied, a fact whose
 * `updatedAt` is older than `maxAgeMs` (relative to `now`) — OR that carries NO `updatedAt` at all, so its
 * freshness cannot be proven — is treated as STALE: its price is NOT quoted (`priceConfirmed: false`), and
 * its (equally stale) availability is dropped. Fail-honest: a quoted price is a money/NN#1 fact, so an
 * unconfirmable one becomes "let me confirm" downstream rather than a stale number. When `staleness` is
 * OMITTED, no ceiling applies and every matched fact is overlaid (the pre-D2 behaviour, byte-identical).
 */
export interface HydrationStaleness {
  now: Date;
  maxAgeMs: number;
}

/**
 * Overlay fresh price/availability from `facts` onto `products`, matched by id. Returns a new array (new
 * objects only where a fact applied); `products` and `facts` are not mutated. Unmatched products pass
 * through unchanged. A fact past the staleness ceiling (see `HydrationStaleness`) is NOT quoted — the
 * product is marked `priceConfirmed: false` instead. O(products + facts).
 */
export function hydrateProductFacts(products: Product[], facts: ProductFact[], staleness?: HydrationStaleness): Product[] {
  if (facts.length === 0) return products;
  const byId = new Map<string, ProductFact>();
  // Last write wins on a duplicate id — matches ProductFactsPort.getMany's own de-dup contract.
  for (const f of facts) byId.set(f.productId, f);
  const isStale = (fact: ProductFact): boolean => {
    if (!staleness) return false; // no ceiling configured ⇒ never stale (pre-D2 behaviour)
    // No updatedAt ⇒ freshness UNPROVABLE ⇒ treat as stale (fail-honest); a malformed date does too.
    if (!fact.updatedAt) return true;
    const at = new Date(fact.updatedAt).getTime();
    if (Number.isNaN(at)) return true;
    return staleness.now.getTime() - at > staleness.maxAgeMs;
  };
  return products.map((p) => {
    const fact = byId.get(p.id);
    if (!fact) return p;
    // STALE: do not quote the fact's price or availability; mark the product so serving says "let me
    // confirm" instead of quoting a stale number. The base catalog price is left in place but the
    // priceConfirmed:false flag makes the renderer withhold it (money/NN#1 fail-honest).
    if (isStale(fact)) return { ...p, priceConfirmed: false };
    const next: Product = { ...p, price: fact.price };
    // Only an explicitly-stated availability overwrites; an absent fact value leaves the product's own.
    if (fact.availableForSale !== undefined) next.availableForSale = fact.availableForSale;
    return next;
  });
}
