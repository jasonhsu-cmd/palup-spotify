import type { GroundingContext, GroundingPort } from "@palup/platform-ports";

// Rich in-memory demo catalog (the "Auria" store) — stands in for the Shopify Storefront-MCP/Catalog
// adapter, which implements the same port later (ADR-0001). Tenant-scoped.
const AURIA: GroundingContext = {
  tenantId: "demo",
  brandName: "Auria",
  products: [
    // Cleansers
    { id: "cleanser-gentle", title: "Gentle Daily Cleanser", price: "$18", description: "Sulfate-free, non-stripping gel cleanser for daily use; calms sensitive and dry skin.", tags: ["cleanser", "sensitive", "dry"], ingredients: ["Aqua", "Glycerin", "Decyl Glucoside", "Panthenol", "Allantoin", "Sodium Hyaluronate", "Citric Acid", "Phenoxyethanol"] },
    { id: "cleanser-foam", title: "Clarifying Foam Cleanser", price: "$20", description: "Salicylic-acid foaming cleanser that clears excess oil and unclogs pores.", tags: ["cleanser", "oily", "acne", "salicylic"], ingredients: ["Aqua", "Glycerin", "Decyl Glucoside", "Salicylic Acid", "Niacinamide", "Panthenol", "Citric Acid", "Phenoxyethanol"] },
    // Serums
    { id: "serum-vc", title: "Vitamin-C Brightening Serum", price: "$34", description: "Fragrance-free, patch-tested; evens tone and adds glow. Once daily, AM.", tags: ["serum", "brightening", "sensitive-ok", "vitamin-c"], ingredients: ["Aqua", "Ascorbic Acid", "Glycerin", "Ferulic Acid", "Tocopherol", "Panthenol", "Sodium Hyaluronate", "Phenoxyethanol"] },
    { id: "serum-niacinamide", title: "Niacinamide 10% Serum", price: "$28", description: "Regulates oil and minimizes the look of pores; pairs well with most routines.", tags: ["serum", "oily", "pores", "niacinamide"], ingredients: ["Aqua", "Niacinamide", "Glycerin", "Zinc PCA", "Panthenol", "Xanthan Gum", "Phenoxyethanol"] },
    { id: "serum-ha", title: "Hyaluronic Hydra Serum", price: "$26", description: "Multi-weight hyaluronic acid for lightweight, lasting hydration.", tags: ["serum", "hydration", "all-skin", "hyaluronic"], ingredients: ["Aqua", "Sodium Hyaluronate", "Glycerin", "Panthenol", "Allantoin", "Xanthan Gum", "Phenoxyethanol"] },
    // Treatments
    { id: "treat-retinol", title: "Gentle Retinol Night Treatment", price: "$38", description: "Encapsulated 0.3% retinol for smoother texture; start 2 nights/week.", tags: ["treatment", "retinol", "anti-aging", "night"], ingredients: ["Aqua", "Retinol", "Glycerin", "Squalane", "Tocopherol", "Panthenol", "Dimethicone", "Phenoxyethanol"] },
    { id: "treat-aha", title: "Weekly AHA Resurfacing Mask", price: "$30", description: "10% glycolic weekly mask for dullness and uneven texture.", tags: ["mask", "exfoliant", "aha", "brightening"], ingredients: ["Aqua", "Glycolic Acid", "Glycerin", "Aloe Barbadensis Leaf Juice", "Panthenol", "Xanthan Gum", "Sodium Hydroxide", "Phenoxyethanol"] },
    // Moisturizers
    { id: "moist-daily", title: "Daily Moisturizer", price: "$24", description: "Non-comedogenic, unscented, lightweight — great for oily/combination skin.", tags: ["moisturizer", "oily", "non-comedogenic"], ingredients: ["Aqua", "Glycerin", "Dimethicone", "Niacinamide", "Cetearyl Alcohol", "Squalane", "Sodium Hyaluronate", "Phenoxyethanol"] },
    { id: "moist-rich", title: "Barrier Repair Cream", price: "$32", description: "Ceramide + squalane rich cream for dry, compromised, or winter skin.", tags: ["moisturizer", "dry", "ceramide", "barrier"], ingredients: ["Aqua", "Glycerin", "Ceramide NP", "Squalane", "Cetearyl Alcohol", "Panthenol", "Tocopherol", "Phenoxyethanol"] },
    // Eye + SPF
    { id: "eye-caffeine", title: "Caffeine Eye Cream", price: "$26", description: "Caffeine + niacinamide to reduce the look of puffiness and dark circles.", tags: ["eye", "dark-circles", "puffiness"], ingredients: ["Aqua", "Caffeine", "Niacinamide", "Glycerin", "Panthenol", "Sodium Hyaluronate", "Xanthan Gum", "Phenoxyethanol"] },
    { id: "spf-daily", title: "Daily Mineral SPF 40", price: "$28", description: "Zinc-based broad-spectrum sunscreen; no white cast, fragrance-free.", tags: ["spf", "sunscreen", "mineral", "sensitive-ok"], ingredients: ["Aqua", "Zinc Oxide", "Glycerin", "Caprylic/Capric Triglyceride", "Cetearyl Alcohol", "Niacinamide", "Tocopherol", "Phenoxyethanol"] },
    // Sets (bundles of the products above — no separate ingredient list; they inherit their components')
    { id: "set-starter", title: "Sensitive-Skin Starter Set", price: "$60", description: "Gentle Cleanser + Hydra Serum + Daily Moisturizer; a calm, simple routine.", tags: ["set", "sensitive", "bundle", "gift"] },
    { id: "set-glow", title: "Brightening Glow Set", price: "$78", description: "Vitamin-C Serum + AHA Mask + Daily SPF for radiance and even tone.", tags: ["set", "brightening", "bundle", "gift"] },
  ],
  policy: {
    returns: "30-day returns on unopened items; opened items reviewed case-by-case for reactions.",
    shipping: "Free US shipping over $75; 3–5 business days. Subscriptions ship free and can be paused or cancelled anytime.",
    allergens: "Our products are formulated without tree-nut oils, but they're made in a facility that also handles nut-derived ingredients, so we can't guarantee against cross-contact — always check the full ingredient list on the product page.",
  },
};

// A second fixture tenant (a different vertical) so multi-tenant grounding + isolation are verifiable
// now, without live Shopify — tenant "northwind" must never see "demo"'s catalog and vice-versa.
const NORTHWIND: GroundingContext = {
  tenantId: "northwind",
  brandName: "Northwind Coffee",
  products: [
    { id: "beans-house", title: "House Blend Whole Beans (12oz)", price: "$16", description: "Balanced medium roast — cocoa and toasted nut; great for drip or espresso.", tags: ["beans", "medium", "blend"] },
    { id: "beans-decaf", title: "Swiss-Water Decaf Beans (12oz)", price: "$17", description: "Chemical-free decaf; smooth and low-acid.", tags: ["beans", "decaf"] },
    { id: "gear-dripper", title: "Ceramic Pour-Over Dripper", price: "$24", description: "Single-cup pour-over cone; fits standard #2 filters.", tags: ["gear", "brewer"] },
    { id: "sub-monthly", title: "Monthly Bean Subscription", price: "$15/mo", description: "A fresh 12oz bag each month; pause or cancel anytime.", tags: ["subscription"] },
  ],
  policy: {
    returns: "Unopened bags returnable within 14 days; opened coffee is not returnable for freshness.",
    shipping: "Flat $5 US shipping; free over $40. Roasted-to-order, ships in 1–2 business days.",
  },
};

// Fixtures-backed grounding: the demo/dev stand-in for the Shopify adapter (same GroundingPort,
// ADR-0001). An UNKNOWN tenant gets a SAFE-EMPTY context (no products) so the brain honestly says it
// can't find products rather than ever returning another merchant's catalog. The real Shopify adapter
// swaps in behind this same port (M2 / ADR-0012).
const FIXTURES: Record<string, GroundingContext> = { demo: AURIA, northwind: NORTHWIND };

export class StaticGroundingAdapter implements GroundingPort {
  async getContext(tenantId: string): Promise<GroundingContext> {
    if (Object.hasOwn(FIXTURES, tenantId)) {
      const fx = FIXTURES[tenantId];
      // Return a per-call copy so a downstream mutation of ctx can't corrupt the shared module fixture.
      return { tenantId, brandName: fx.brandName, products: fx.products.map((p) => ({ ...p })), policy: { ...fx.policy } };
    }
    return { tenantId, brandName: "this store", products: [], policy: { returns: "", shipping: "" } };
  }
}
