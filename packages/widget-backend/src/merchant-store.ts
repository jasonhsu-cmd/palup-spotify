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

export interface ResolveShopifyStoreOpts {
  /**
   * D1 — the registry-backed shop-domain resolver (`MerchantResolver.shopDomainFor`, merchant-resolver.ts).
   * When supplied it REPLACES the `domains` map entirely, because the resolver already contains the
   * `SHOPIFY_STORES` fallback plus the two things the raw map cannot express: a registry row WINS over a
   * stale env entry, and a REVOKED merchant resolves to nothing at all rather than to their old env host.
   *
   * Optional so the callers that must stay byte-identical do: `jobs/catalog-index.ts` (which enumerates
   * `SHOPIFY_STORES` because `MerchantRegistryPort` has no enumeration operation — see merchant-resolver.ts's
   * header) passes nothing and behaves exactly as before D1.
   */
  shopDomainFor?: (tenantId: string) => Promise<string | undefined>;
}

/**
 * Resolve a tenant's Shopify credentials, or undefined if the store isn't FULLY configured (missing
 * domain or missing token). Tenant-isolated: the token is fetched via the tenant-scoped SecretsPort and
 * the domain via an own-property lookup (or, under D1, through the merchant resolver). Never logs the token.
 *
 * THE TOKEN IS STILL `SecretsPort`, AND THAT IS THE WHOLE ANSWER TO "where does the Storefront token come
 * from". D1 moved the DOMAIN to the registry and deliberately did NOT move the CREDENTIAL: B2's encrypted
 * `MerchantCredentialStore` (#186) holds the delegate token an install obtains, but serving does not read it.
 * There is exactly ONE source of truth for the token — `shopify_storefront_token` in `PALUP_SECRETS`,
 * hand-provisioned per tenant. THE CONSEQUENCE, so nobody has to discover it: a merchant who installs
 * through C1's OAuth flow now resolves a shop DOMAIN (from their registry row) but has no
 * `shopify_storefront_token`, so `resolveShopifyStore` returns undefined and their shoppers get the built-in
 * FIXTURE catalog, not their own products. Reading B2 here is D2.
 */
export async function resolveShopifyStore(
  tenantId: string,
  secrets: SecretsPort,
  domains: Record<string, string> = parseStoreDomains(),
  opts: ResolveShopifyStoreOpts = {},
): Promise<ShopifyStoreCreds | undefined> {
  if (!tenantId) return undefined;
  const shopDomain = opts.shopDomainFor
    ? await opts.shopDomainFor(tenantId)
    : Object.hasOwn(domains, tenantId)
      ? domains[tenantId]
      : undefined;
  if (!shopDomain) return undefined;
  const accessToken = await secrets.get(tenantId, SHOPIFY_TOKEN_SECRET);
  if (!accessToken) return undefined; // not fully configured → caller uses fixtures
  return { shopDomain, accessToken };
}
