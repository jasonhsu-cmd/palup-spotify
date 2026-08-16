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
  /**
   * A1b/D2 (ADR-0020) — SERVING freshness marker, NOT catalog data. Grounding adapters leave it unset
   * (absent === confirmed). The A1b hydrate step sets it `false` when the Tier-2 fact backing this price is
   * past the hard staleness ceiling — meaning the price can no longer be trusted as current. When `false`,
   * the CATALOG block renders NO number for this product and a rule tells the agent to offer to confirm the
   * current price rather than quote a stale one (money/NN#1 fail-honest). Absent/`true` ⇒ quote as normal.
   */
  priceConfirmed?: boolean;
  /**
   * C1 (ADR-0020) — the opaque per-product id used to build a one-tap cart/checkout deep link (a Shopify
   * variant id today). VENDOR-NEUTRAL: an opaque string the widget interpolates client-side; the
   * platform-specific cart-URL format is built in the WIDGET, never in the neutral layers (portability —
   * no Shopify URL crosses this port). OPTIONAL: absent when the source reports no purchasable variant.
   */
  variantId?: string;
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

export interface GroundingShell {
  tenantId: string;
  brandName: string;
  policy: StorePolicy;
}

export interface GroundingPort {
  /** Tenant-scoped (isolation): only ever returns the given tenant's own catalog/policy. */
  getContext(tenantId: string): Promise<GroundingContext>;
  /**
   * S2 — brand + policy ONLY (no products). The render path fetches this instead of the whole catalog,
   * so it can never hit the catalog-size ceiling. Tenant-scoped exactly like `getContext`.
   */
  getShell(tenantId: string): Promise<GroundingShell>;
}
