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
}

export interface StorePolicy {
  returns: string;
  shipping: string;
  /** Store-level allergen/ingredient statement the agent may ground an allergy question on — WITHOUT
   * ever guaranteeing personal safety (real stores publish this; the Shopify adapter maps it). */
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
