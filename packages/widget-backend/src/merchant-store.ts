import type { SecretsPort } from "@palup/platform-ports";

// Tenant → Shopify store resolution (M2). Splits into a NON-SECRET part (the shop domain, which merely
// names which store a tenant maps to — safe in config) and a SECRET part (the Storefront access token,
// which must come from the SecretsPort, never code/env-in-repo/logs). A tenant is "Shopify-configured"
// only when BOTH resolve; otherwise the grounding composition root falls back to fixtures (slice 4).

export interface ShopifyStoreCreds {
  /** e.g. "acme-store.myshopify.com" — not a secret. */
  shopDomain: string;
  /** Storefront API access token — SECRET, resolved via the SecretsPort. */
  accessToken: string;
}

/** SecretsPort name under which a tenant's Storefront token is stored. */
export const SHOPIFY_TOKEN_SECRET = "shopify_storefront_token";

// Non-secret tenant→shopDomain map, JSON via env (like the publishable embed-key registry). Null-proto
// so inherited keys can't resolve a domain.
export function parseStoreDomains(raw: string | undefined = process.env.SHOPIFY_STORES): Record<string, string> {
  const map: Record<string, string> = Object.create(null);
  if (raw) {
    try {
      const o = JSON.parse(raw);
      if (o && typeof o === "object") {
        for (const [k, v] of Object.entries(o)) if (typeof v === "string" && v) map[k] = v;
      }
    } catch {
      console.warn("[config] SHOPIFY_STORES is not valid JSON — no Shopify stores configured");
    }
  }
  return map;
}

/**
 * Resolve a tenant's Shopify credentials, or undefined if the store isn't FULLY configured (missing
 * domain or missing token). Tenant-isolated: the token is fetched via the tenant-scoped SecretsPort and
 * the domain via an own-property lookup. Never logs the token.
 */
export async function resolveShopifyStore(
  tenantId: string,
  secrets: SecretsPort,
  domains: Record<string, string> = parseStoreDomains(),
): Promise<ShopifyStoreCreds | undefined> {
  if (!tenantId || !Object.hasOwn(domains, tenantId)) return undefined;
  const shopDomain = domains[tenantId];
  const accessToken = await secrets.get(tenantId, SHOPIFY_TOKEN_SECRET);
  if (!shopDomain || !accessToken) return undefined; // not fully configured → caller uses fixtures
  return { shopDomain, accessToken };
}
