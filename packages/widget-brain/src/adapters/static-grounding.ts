import type { GroundingContext, GroundingPort } from "@palup/platform-ports";

// Rich in-memory demo catalog (the "Auria" store) — stands in for the Shopify Storefront-MCP/Catalog
// adapter, which implements the same port later (ADR-0001). Tenant-scoped.
const AURIA: GroundingContext = {
  tenantId: "demo",
  brandName: "Auria",
  products: [
    // Cleansers
    { id: "cleanser-gentle", title: "Gentle Daily Cleanser", price: "$18", description: "Sulfate-free, non-stripping gel cleanser for daily use; calms sensitive and dry skin.", tags: ["cleanser", "sensitive", "dry"] },
    { id: "cleanser-foam", title: "Clarifying Foam Cleanser", price: "$20", description: "Salicylic-acid foaming cleanser that clears excess oil and unclogs pores.", tags: ["cleanser", "oily", "acne", "salicylic"] },
    // Serums
    { id: "serum-vc", title: "Vitamin-C Brightening Serum", price: "$34", description: "Fragrance-free, patch-tested; evens tone and adds glow. Once daily, AM.", tags: ["serum", "brightening", "sensitive-ok", "vitamin-c"] },
    { id: "serum-niacinamide", title: "Niacinamide 10% Serum", price: "$28", description: "Regulates oil and minimizes the look of pores; pairs well with most routines.", tags: ["serum", "oily", "pores", "niacinamide"] },
    { id: "serum-ha", title: "Hyaluronic Hydra Serum", price: "$26", description: "Multi-weight hyaluronic acid for lightweight, lasting hydration.", tags: ["serum", "hydration", "all-skin", "hyaluronic"] },
    // Treatments
    { id: "treat-retinol", title: "Gentle Retinol Night Treatment", price: "$38", description: "Encapsulated 0.3% retinol for smoother texture; start 2 nights/week.", tags: ["treatment", "retinol", "anti-aging", "night"] },
    { id: "treat-aha", title: "Weekly AHA Resurfacing Mask", price: "$30", description: "10% glycolic weekly mask for dullness and uneven texture.", tags: ["mask", "exfoliant", "aha", "brightening"] },
    // Moisturizers
    { id: "moist-daily", title: "Daily Moisturizer", price: "$24", description: "Non-comedogenic, unscented, lightweight — great for oily/combination skin.", tags: ["moisturizer", "oily", "non-comedogenic"] },
    { id: "moist-rich", title: "Barrier Repair Cream", price: "$32", description: "Ceramide + squalane rich cream for dry, compromised, or winter skin.", tags: ["moisturizer", "dry", "ceramide", "barrier"] },
    // Eye + SPF
    { id: "eye-caffeine", title: "Caffeine Eye Cream", price: "$26", description: "Caffeine + niacinamide to reduce the look of puffiness and dark circles.", tags: ["eye", "dark-circles", "puffiness"] },
    { id: "spf-daily", title: "Daily Mineral SPF 40", price: "$28", description: "Zinc-based broad-spectrum sunscreen; no white cast, fragrance-free.", tags: ["spf", "sunscreen", "mineral", "sensitive-ok"] },
    // Sets
    { id: "set-starter", title: "Sensitive-Skin Starter Set", price: "$60", description: "Gentle Cleanser + Hydra Serum + Daily Moisturizer; a calm, simple routine.", tags: ["set", "sensitive", "bundle", "gift"] },
    { id: "set-glow", title: "Brightening Glow Set", price: "$78", description: "Vitamin-C Serum + AHA Mask + Daily SPF for radiance and even tone.", tags: ["set", "brightening", "bundle", "gift"] },
  ],
  policy: {
    returns: "30-day returns on unopened items; opened items reviewed case-by-case for reactions.",
    shipping: "Free US shipping over $75; 3–5 business days. Subscriptions ship free and can be paused or cancelled anytime.",
    allergens: "Our formulas do not use tree-nut oils or peanut oil; fragrance-free products are labelled 'fragrance-free'. A full ingredient list is on each product page.",
  },
};

export class StaticGroundingAdapter implements GroundingPort {
  async getContext(tenantId: string): Promise<GroundingContext> {
    return { ...AURIA, tenantId };
  }
}
