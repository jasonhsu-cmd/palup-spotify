import { normalizePrimaryDomain } from "@palup/platform-ports";
import type { MerchantRegistryPort, SecretsPort } from "@palup/platform-ports";
import type { MerchantCredentialRead } from "@palup/state-postgres";

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

// Custom-domain CSP support — the NAMED env fallback for `MerchantResolver.primaryDomainForShop`, at
// exactly the rank `SHOPIFY_STORES` holds for identity: consulted ONLY when the merchant registry has NO
// row at all for a shop (never when a row exists, even one with no primaryDomain — see
// merchant-resolver.ts). Keyed by SHOP DOMAIN directly (not by tenant, unlike `SHOPIFY_STORES`), because
// the panel route already has the shop and never the tenant id at the point it needs this. Both the key
// and the value are hostnames, so BOTH are normalized here — the read-side re-validation this repo
// requires for every hostname that reaches a CSP, applied even to an operator-supplied env var.
export function parsePrimaryDomains(raw: string | undefined = process.env.SHOPIFY_PRIMARY_DOMAINS): Record<string, string> {
  const map: Record<string, string> = Object.create(null);
  if (raw) {
    try {
      const o = JSON.parse(raw);
      if (o && typeof o === "object") {
        for (const [k, v] of Object.entries(o)) {
          if (typeof k !== "string" || !k.trim() || typeof v !== "string" || !v) continue;
          try {
            map[k.trim().toLowerCase()] = normalizePrimaryDomain(v);
          } catch {
            console.warn(`[config] SHOPIFY_PRIMARY_DOMAINS entry for "${k}" is not a bare hostname — skipped`);
          }
        }
      }
    } catch {
      console.warn("[config] SHOPIFY_PRIMARY_DOMAINS is not valid JSON — no custom domains configured");
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
  const shopDomain = await resolveShopDomain(tenantId, domains, opts.shopDomainFor);
  if (!shopDomain) return undefined;
  const accessToken = await secrets.get(tenantId, SHOPIFY_TOKEN_SECRET);
  if (!accessToken) return undefined; // not fully configured → caller uses fixtures
  return { shopDomain, accessToken };
}

/** Resolve a tenant's shop domain (registry-first when shopDomainFor is given, else the SHOPIFY_STORES map). */
async function resolveShopDomain(
  tenantId: string,
  domains: Record<string, string> = parseStoreDomains(),
  shopDomainFor?: (tenantId: string) => Promise<string | undefined>,
): Promise<string | undefined> {
  if (shopDomainFor) return shopDomainFor(tenantId);
  return Object.hasOwn(domains, tenantId) ? domains[tenantId] : undefined;
}

/**
 * Walk EVERY active merchant via `MerchantRegistryPort.listActive`'s keyset cursor (Task 1,
 * merchant-registry-port.ts), following `nextCursor` until a page comes back without one — a short
 * (including empty) page already proves there is nothing after it, per that method's own contract, so
 * this never issues one extra round-trip "to be sure". Returns tenantIds in page order.
 *
 * ADR-0023 F-E: `listActive` is an INTERNAL, sync-plane-only capability — this helper exists so the two
 * sanctioned callers (the catalog-sync scheduler and the retention sweep, both `packages/widget-backend/
 * src/jobs/*`) enumerate identically rather than each hand-rolling its own cursor loop. It must never be
 * reached from the public/merchant or runtime-agent surfaces.
 */
export async function listActiveTenantIds(registry: Pick<MerchantRegistryPort, "listActive">): Promise<string[]> {
  const tenantIds: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await registry.listActive(cursor === undefined ? {} : { cursor });
    for (const item of page.items) tenantIds.push(item.tenantId);
    if (page.nextCursor === undefined) return tenantIds;
    cursor = page.nextCursor;
  }
}

export type CredentialOutcome =
  | { status: "live"; creds: ShopifyStoreCreds }
  | { status: "fixtures" }
  | { status: "refuse"; reason: "undecryptable" | "malformed-record" };

export interface StorefrontCredentialDeps {
  secrets: SecretsPort;
  /** The credential store's read(). Present ⇒ read-back is possible; consulted only when readbackEnabled. */
  credRead?: (tenantId: string) => Promise<MerchantCredentialRead>;
  readbackEnabled?: boolean;
  domains?: Record<string, string>;
  shopDomainFor?: (tenantId: string) => Promise<string | undefined>;
}

/**
 * D2: the token source. When read-back is ON we read the custodied delegate credential first; an
 * `unreadable` credential REFUSES (never fixtures, never fallback), a `missing` one falls back to the
 * hand-provisioned SecretsPort token (keeps the demo/staging tenant serving), and `found` yields live
 * creds. When OFF, this delegates to the unchanged `resolveShopifyStore` (SecretsPort only) — no refusal.
 */
export async function resolveStorefrontCredential(
  tenantId: string,
  deps: StorefrontCredentialDeps,
): Promise<CredentialOutcome> {
  if (!tenantId) return { status: "fixtures" };
  if (deps.readbackEnabled && deps.credRead) {
    const r = await deps.credRead(tenantId);
    if (r.status === "unreadable") return { status: "refuse", reason: r.reason };
    if (r.status === "found") {
      const shopDomain = await resolveShopDomain(tenantId, deps.domains, deps.shopDomainFor);
      if (!shopDomain) return { status: "fixtures" };
      return { status: "live", creds: { shopDomain, accessToken: r.token } };
    }
    // r.status === "missing" → fall through to the SecretsPort fallback.
  }
  const creds = await resolveShopifyStore(
    tenantId,
    deps.secrets,
    deps.domains,
    deps.shopDomainFor ? { shopDomainFor: deps.shopDomainFor } : {},
  );
  return creds ? { status: "live", creds } : { status: "fixtures" };
}
