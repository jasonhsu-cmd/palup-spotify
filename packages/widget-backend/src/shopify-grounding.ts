import type { GroundingContext, GroundingPort, Product, StorePolicy } from "@palup/platform-ports";
import type { ShopifyStoreCreds } from "./merchant-store.js";

// Shopify GroundingPort adapter (ADR-0012). Maps a merchant's Shopify **Storefront API** data onto the
// vendor-neutral GroundingContext, entirely behind GroundingPort (NN#3 — no Shopify types cross the
// port). Chosen over the Admin API for least-privilege (published storefront data only, no
// inventory/cost/PII).
//
// HONESTY / UNVERIFIED-LIVE: the assumed Storefront response shape below and the (not-yet-written)
// GraphQL query are RECOLLECTION of the Storefront API, NOT verified against current Shopify docs or a
// real store this session (knowledge cutoff Jan 2026). Per CLAUDE.md we do NOT ship a guessed network
// call: the live fetch is an explicit not-implemented stub. The MAPPING is pure logic, fixture-tested,
// and independent of the live call. Enabling the live path is a §7 human step: verify the query +
// field names against Shopify docs, provide a dev-store Storefront token, then implement `fetchImpl`.

/** Assumed Storefront product node (shape TO VERIFY against Shopify Storefront API docs). */
export interface StorefrontProductNode {
  id: string;
  title: string;
  description?: string;
  tags?: string[];
  priceRange?: { minVariantPrice?: { amount?: string; currencyCode?: string } };
}

/** Assumed Storefront query response (shape TO VERIFY). */
export interface StorefrontData {
  shop?: {
    name?: string;
    refundPolicy?: { body?: string };
    shippingPolicy?: { body?: string };
  };
  products?: { nodes?: StorefrontProductNode[] };
}

function formatPrice(p?: { amount?: string; currencyCode?: string }): string {
  if (!p?.amount) return "";
  return p.currencyCode && p.currencyCode !== "USD" ? `${p.amount} ${p.currencyCode}` : `$${p.amount}`;
}

/**
 * Pure mapping: Storefront response → GroundingContext. Stamps the REQUESTED tenantId (never a value
 * from the response), so a mis-scoped fetch can't smuggle another tenant's id past the cache's
 * tenant-match assertion. Tested against synthetic fixtures.
 */
export function mapStorefrontToContext(tenantId: string, data: StorefrontData): GroundingContext {
  const products: Product[] = (data.products?.nodes ?? []).map((n) => ({
    id: n.id,
    title: n.title,
    description: n.description ?? "",
    price: formatPrice(n.priceRange?.minVariantPrice),
    tags: n.tags,
  }));
  const policy: StorePolicy = {
    returns: data.shop?.refundPolicy?.body ?? "",
    shipping: data.shop?.shippingPolicy?.body ?? "",
  };
  return { tenantId, brandName: data.shop?.name ?? "this store", products, policy };
}

export type StorefrontFetch = (creds: ShopifyStoreCreds) => Promise<StorefrontData>;

// The live Storefront GraphQL call is intentionally NOT implemented: it needs a query verified against
// current Shopify docs + a real Storefront access token (§7 / ADR-0012). Throwing here means a tenant
// that is credential-configured but whose live path isn't wired degrades SAFELY via the caching
// wrapper (stale or safe-empty), rather than shipping a guessed network request.
const notImplementedFetch: StorefrontFetch = async () => {
  throw new Error(
    "Shopify Storefront live fetch not implemented — requires a query verified against Shopify docs + a real Storefront token (§7 / ADR-0012)",
  );
};

/** GroundingPort backed by a merchant's Shopify store. `fetchImpl` is injectable for tests. */
export function createShopifyGroundingAdapter(
  creds: ShopifyStoreCreds,
  fetchImpl: StorefrontFetch = notImplementedFetch,
): GroundingPort {
  return {
    async getContext(tenantId: string): Promise<GroundingContext> {
      const data = await fetchImpl(creds);
      return mapStorefrontToContext(tenantId, data);
    },
  };
}
