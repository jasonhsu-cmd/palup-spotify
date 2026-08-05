// Grounding port (ADR-0001): first-party facts the agent may ground on — catalog + policy for a
// tenant. Feature code depends on this interface; adapters (static demo, Shopify Storefront/Catalog,
// …) implement it. Grounding is what turns a generic model into the *merchant's* agent that
// recommends THEIR products and never invents ones they don't carry.

export interface Product {
  id: string;
  title: string;
  description: string;
  /** Display price string, e.g. "$28". The agent never invents or alters this. */
  price: string;
  tags?: string[];
  /**
   * The product's ingredient list (INCI / label order), if the merchant publishes one. OPTIONAL:
   * adapters populate it when the source has it (the demo fixture; a Shopify metafield/parsed label)
   * and leave it undefined otherwise. It grounds honest allergy answers — the agent scans this actual
   * list rather than guessing — but is never a safety guarantee (cross-contact still applies).
   */
  ingredients?: string[];
  /**
   * Whether the product can be bought right now. OPTIONAL and THREE-STATE on purpose:
   *   true      -> confirmed purchasable
   *   false     -> confirmed not purchasable
   *   undefined -> UNKNOWN (this adapter/source does not report it) => the agent must say it cannot
   *                confirm. Absent must never read as "available"; see the CATALOG rule in brain.ts.
   *
   * Deliberately a BOOLEAN, not a stock count. Shopify's Storefront API exposes both
   * `Product.availableForSale: Boolean!` ("Indicates if at least one product variant is available for
   * sale") and `ProductVariant.quantityAvailable: Int` — but the latter is documented as requiring extra
   * token access, and a stock NUMBER is precisely the raw material for manufactured urgency ("only 2
   * left!"), which §8a invariant 11 forbids and which a self-improving sales agent would be tempted to
   * reach for. Not carrying the number makes that fabrication impossible rather than merely against the
   * rules, and keeps the adapter inside its stated least-privilege boundary (no inventory scope).
   * Verified against shopify.dev Storefront API 2026-07 docs, retrieved 2026-08-05.
   */
  availableForSale?: boolean;
}

export interface StorePolicy {
  returns: string;
  shipping: string;
  /** Merchant's published allergen statement, if any — grounds honest allergy answers (never a guarantee). */
  allergens?: string;
}

export interface GroundingContext {
  tenantId: string;
  brandName: string;
  products: Product[];
  policy: StorePolicy;
}

export interface GroundingPort {
  /** Tenant-scoped (isolation): only ever returns the given tenant's own catalog/policy. */
  getContext(tenantId: string): Promise<GroundingContext>;
}
