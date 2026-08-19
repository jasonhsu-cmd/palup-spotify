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
// D2 STALENESS CEILING — LANDED (S3 §D). The overlay honours a hard staleness ceiling: when `staleness`
// is supplied, a fact older than `maxAgeMs` (or with no/invalid `updatedAt`) is NOT quoted — it renders
// `priceConfirmed:false` and drops availability, so serving says "let me confirm current price" rather than
// quote a stale number (money/NN#1 fail-honest). The serve path always supplies the ceiling when hydration
// is on: `PRODUCT_FACTS_MAX_AGE_MS` (server.ts) defaults to 15 min and is always a number, so
// `productFactsMaxAgeMs` is never undefined on the hydration path. The A1b security-review blocker
// ("a stale fact would be quoted verbatim with no upper bound on age") is therefore CLOSED.
//
// STILL A §5 PROMOTION, NOT A FLIP. Enabling PRODUCT_FACTS_HYDRATION in any live stage remains a money/NN#1
// human promotion (eval gate → shadow → canary → named-human approval, HITL §5) with the ≤15-min ceiling in
// force as a recorded pre-shadow acceptance criterion. This code does NOT enable it (flag OFF; and even
// flag-on the store is empty until the A3/S3 producers run). No S3 code flips the flag.

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
  /**
   * Pillar 1 (price truth) — whether the merchant's freshness CHANNEL (webhook subscription + producer) is
   * provably LIVE. A fact's `updatedAt` only proves the row was WRITTEN recently, not that the pipe keeping
   * it fresh is still alive: a webhook subscription can die silently while an old poll-written row still
   * looks recent. So when `channelHealthy` is explicitly `false`, every matched fact renders
   * `priceConfirmed:false` regardless of its own age — a recent row from a dead channel is not a confirmed
   * price (money/NN#1 fail-honest). Omitted or `true` ⇒ freshness is judged on `updatedAt` alone, exactly
   * as before (byte-identical). Only ever consulted on the already-flag-gated hydration path, and only when
   * a serve-path caller supplies it (behind its own posture flag).
   */
  channelHealthy?: boolean;
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
    // Pillar 1 — the freshness CHANNEL must be provably live to quote a confirmed price. When channel health
    // is supplied and NOT healthy, a matched fact is unconfirmed regardless of its own `updatedAt`: a recent
    // row proves only that it was written recently, not that the webhook/producer keeping it fresh is still
    // alive (money/NN#1 fail-honest). `channelHealthy` omitted/true ⇒ judged on `updatedAt` alone (unchanged).
    if (staleness.channelHealthy === false) return true;
    // No updatedAt ⇒ freshness UNPROVABLE ⇒ treat as stale (fail-honest); a malformed date does too.
    if (!fact.updatedAt) return true;
    const at = new Date(fact.updatedAt).getTime();
    if (Number.isNaN(at)) return true;
    return staleness.now.getTime() - at > staleness.maxAgeMs;
  };
  return products.map((p) => {
    const fact = byId.get(p.id);
    if (!fact) return p;
    // STALE: do not quote the fact's price or availability. The base catalog price is left in place but
    // the priceConfirmed:false flag makes the renderer withhold it (money/NN#1 fail-honest). Availability
    // is DROPPED (set undefined), not left at the product's own last-known value: the fact's existence
    // means an availability-affecting event fired for this product, so the pre-fact value can no longer be
    // trusted either — "unknown" is honest, a stale "true"/"false" is not.
    if (isStale(fact)) return { ...p, priceConfirmed: false, availableForSale: undefined };
    const next: Product = { ...p, price: fact.price };
    // Only an explicitly-stated availability overwrites; an absent fact value leaves the product's own.
    if (fact.availableForSale !== undefined) next.availableForSale = fact.availableForSale;
    return next;
  });
}
