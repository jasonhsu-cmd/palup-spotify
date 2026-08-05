import type { GroundingContext, GroundingPort, Product, StorePolicy } from "@palup/platform-ports";
import type { ShopifyStoreCreds } from "./merchant-store.js";

// Shopify GroundingPort adapter (ADR-0012). Maps a merchant's Shopify **Storefront API** data onto the
// vendor-neutral GroundingContext, entirely behind GroundingPort (NN#3 — no Shopify types cross the
// port). Chosen over the Admin API for least-privilege (published storefront data only, no
// inventory/cost/PII).
//
// The GraphQL query + response shape below were VERIFIED against the Shopify Storefront API docs
// (version 2026-07, shopify.dev, retrieved 2026-07-30): products(first:){nodes{id,title,description,
// tags,priceRange{minVariantPrice{amount,currencyCode}}}} and shop{name,refundPolicy{body},
// shippingPolicy{body}} (ShopPolicy.body is String!). PalUp calls the Storefront API SERVER-SIDE, so
// it authenticates with a PRIVATE (delegate) Storefront access token via the `Shopify-Storefront-
// Private-Token` header (kept secret in the SecretsPort — not the public `X-Shopify-Storefront-Access-
// Token` browser header). The pure mapping is fixture-tested; the LIVE end-to-end call (auth + real
// response) was VERIFIED 2026-07-31 against the real store `palup-skincare-jason.myshopify.com` (HTTP 200;
// brand + refund/shipping policies + a real catalog returned) with the private token in Secret Manager
// `palup-secrets`. It is wired into the deployed service via `SHOPIFY_STORES` + `PALUP_SECRETS` in
// deploy-staging.yml (both REPLACE-set every deploy — see the note there).

/** Storefront product node (Storefront API 2026-07). */
export interface StorefrontProductNode {
  id: string;
  title: string;
  description?: string;
  tags?: string[];
  priceRange?: { minVariantPrice?: { amount?: string; currencyCode?: string } };
  /** `Product.availableForSale: Boolean!` — see the GroundingPort field for why not `quantityAvailable`. */
  availableForSale?: boolean;
}

/** Storefront query response (the fields this adapter requests). */
export interface StorefrontData {
  shop?: {
    name?: string;
    refundPolicy?: { body?: string };
    shippingPolicy?: { body?: string };
  };
  products?: { nodes?: StorefrontProductNode[] };
}

// Bounds on merchant-supplied catalog text before it flows into the system prompt: caps prompt bloat and
// limits the prompt-injection surface of merchant-authored fields (a merchant can only affect its OWN
// tenant's agent — not cross-tenant — but bounding is prudent; deeper sanitization is a follow-up).
const MAX_TITLE = 200;
const MAX_DESC = 600;
const MAX_TAGS = 20;
const bound = (s: string | undefined, max: number): string => (s ?? "").slice(0, max);

function formatPrice(p?: { amount?: string; currencyCode?: string }): string {
  if (!p?.amount) return "";
  return p.currencyCode && p.currencyCode !== "USD" ? `${p.amount} ${p.currencyCode}` : `$${p.amount}`;
}

/**
 * Pure mapping: Storefront response → GroundingContext. Stamps the REQUESTED tenantId (never a value
 * from the response), so a mis-scoped fetch can't smuggle another tenant's id past the cache's
 * tenant-match assertion. Bounds merchant text. Tested against synthetic fixtures.
 */
export function mapStorefrontToContext(tenantId: string, data: StorefrontData): GroundingContext {
  const products: Product[] = (data.products?.nodes ?? []).map((n) => ({
    id: n.id,
    title: bound(n.title, MAX_TITLE),
    description: bound(n.description, MAX_DESC),
    price: formatPrice(n.priceRange?.minVariantPrice),
    tags: (n.tags ?? []).slice(0, MAX_TAGS),
    // Only carried when Shopify actually returned a boolean. A missing/non-boolean value stays
    // UNDEFINED rather than collapsing to false, because "unknown" and "not purchasable" are different
    // claims to make to a shopper and the prompt handles them differently.
    availableForSale: typeof n.availableForSale === "boolean" ? n.availableForSale : undefined,
  }));
  const policy: StorePolicy = {
    returns: bound(data.shop?.refundPolicy?.body, MAX_DESC),
    shipping: bound(data.shop?.shippingPolicy?.body, MAX_DESC),
  };
  return { tenantId, brandName: bound(data.shop?.name, MAX_TITLE) || "this store", products, policy };
}

export type StorefrontFetch = (creds: ShopifyStoreCreds) => Promise<StorefrontData>;

/** Current Storefront API version (verified 2026-07-30 against shopify.dev). */
export const STOREFRONT_API_VERSION = "2026-07";

// The Storefront token is sent in a header to `shopDomain`, so refuse any host that isn't a Shopify
// store host — a misconfigured/typo'd domain must never leak the token to an arbitrary server (SSRF /
// credential-exfil defense-in-depth). shopDomain is operator config (not client), so this guards
// operator error. Custom storefront domains would need an explicit allowlist — a follow-up.
const SHOP_HOST = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i;

const STOREFRONT_QUERY = `query PalUpGrounding($first: Int!) {
  shop { name refundPolicy { body } shippingPolicy { body } }
  products(first: $first) {
    nodes { id title description tags availableForSale priceRange { minVariantPrice { amount currencyCode } } }
  }
}`;

/**
 * The live Storefront GraphQL fetch. POSTs the verified query to
 * `https://{shopDomain}/api/{version}/graphql.json` with the server-side `Shopify-Storefront-Private-Token` header.
 * `fetchFn` is injectable for tests (defaults to global fetch). Throws on a non-2xx response or a GraphQL
 * error so the caching wrapper degrades safely (stale/safe-empty). AbortSignal.timeout cancels the
 * underlying request on timeout (caching-review F3). Large catalogs (>first) need pagination — follow-up.
 */
export function storefrontFetch(
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
  opts: { version?: string; first?: number; timeoutMs?: number; log?: (info: { host: string; status: number; ok: boolean; ms: number }) => void } = {},
): StorefrontFetch {
  const version = opts.version ?? STOREFRONT_API_VERSION;
  const first = opts.first ?? 250; // Storefront max page size
  const timeoutMs = opts.timeoutMs ?? 4000;
  // (c) Egress observability: log host + HTTP status + latency per fetch (NEVER the token) so operators
  // can see Shopify health/misrouting during rollout. Injectable for tests; defaults to console.log →
  // Cloud Logging. The thrown errors stay static + unlogged (F1); this line is structured + token-free.
  const log = opts.log ?? ((info: { host: string; status: number; ok: boolean; ms: number }) => console.log("[grounding.shopify] " + JSON.stringify(info)));
  return async (creds) => {
    if (!SHOP_HOST.test(creds.shopDomain)) {
      throw new Error("refusing Shopify fetch: shopDomain is not a *.myshopify.com host"); // never leak the token
    }
    const url = `https://${creds.shopDomain}/api/${version}/graphql.json`;
    const start = Date.now();
    let status = 0;
    let ok = false;
    try {
      const res = await fetchFn(url, {
        method: "POST",
        headers: { "content-type": "application/json", "Shopify-Storefront-Private-Token": creds.accessToken },
        body: JSON.stringify({ query: STOREFRONT_QUERY, variables: { first } }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      status = res.status;
      ok = res.ok;
      // These errors are swallowed by the caching wrapper (degrade to stale/safe-empty) and must NEVER be
      // logged. Messages are STATIC — no vendor/credential content can ride an error into a future logger (F1).
      if (!res.ok) throw new Error("Shopify Storefront API request failed");
      const json = (await res.json()) as { data?: StorefrontData; errors?: Array<{ message?: string }> };
      if (Array.isArray(json.errors) && json.errors.length) {
        throw new Error("Shopify Storefront GraphQL error");
      }
      return json.data ?? {};
    } finally {
      // Observability must never break the fetch — swallow any (injected) logger error.
      try {
        log({ host: creds.shopDomain, status, ok, ms: Date.now() - start });
      } catch {
        /* ignore logging errors */
      }
    }
  };
}

/** GroundingPort backed by a merchant's Shopify store. `fetchImpl` defaults to the live Storefront call. */
export function createShopifyGroundingAdapter(
  creds: ShopifyStoreCreds,
  fetchImpl: StorefrontFetch = storefrontFetch(),
): GroundingPort {
  return {
    async getContext(tenantId: string): Promise<GroundingContext> {
      const data = await fetchImpl(creds);
      return mapStorefrontToContext(tenantId, data);
    },
  };
}
