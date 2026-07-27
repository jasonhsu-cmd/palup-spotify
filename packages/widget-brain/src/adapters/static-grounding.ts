import type { GroundingContext, GroundingPort } from "@palup/platform-ports";

// In-memory demo catalog (the "Auria" store). Lets the widget ground offline. The real
// ShopifyGroundingAdapter (Storefront MCP / Catalog API) implements the same port next — feature
// code won't change (ADR-0001). Tenant-scoped: returns only this tenant's catalog.
const AURIA: GroundingContext = {
  tenantId: "demo",
  brandName: "Auria",
  products: [
    { id: "serum-vc", title: "Vitamin-C Brightening Serum", price: "$34", description: "Fragrance-free, patch-tested; once daily for dullness and uneven tone.", tags: ["serum", "brightening", "sensitive-ok"] },
    { id: "cleanser-gentle", title: "Gentle Daily Cleanser", price: "$18", description: "Sulfate-free, non-stripping; suits sensitive and dry skin.", tags: ["cleanser", "sensitive"] },
    { id: "toner-travel", title: "Travel Toner", price: "$12", description: "Fragrance-free hydrating toner, TSA-friendly size.", tags: ["toner", "travel", "sensitive-ok"] },
    { id: "moist-daily", title: "Daily Moisturizer", price: "$24", description: "Non-comedogenic, unscented; lightweight for oily and combination skin.", tags: ["moisturizer", "oily", "non-comedogenic"] },
    { id: "eye-caffeine", title: "Caffeine Eye Cream", price: "$26", description: "Caffeine + niacinamide to reduce the look of puffiness and dark circles.", tags: ["eye", "dark-circles", "puffiness"] },
  ],
  policy: {
    returns: "30-day returns on unopened items; opened items case-by-case.",
    shipping: "Free shipping over $75; 3–5 business days in the US.",
  },
};

export class StaticGroundingAdapter implements GroundingPort {
  async getContext(tenantId: string): Promise<GroundingContext> {
    // Demo adapter carries one tenant; a real adapter looks up by tenantId (and enforces isolation).
    return { ...AURIA, tenantId };
  }
}
