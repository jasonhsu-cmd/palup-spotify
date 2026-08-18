import type { FastifyInstance, FastifyRequest } from "fastify";
import type { GroundingContext, StorePolicy } from "@palup/platform-ports";
import { cartPermalink } from "../cart-permalink.js";
import { productPermalink } from "../product-permalink.js";

// WS2 — public storefront catalog read endpoint. Backs the sample storefront's product grid + PDP + cart
// (it renders the SAME live catalog the assistant is grounded on, so page and agent finally agree). It
// exposes only PUBLISHED storefront data (brand, policy, products) — the same data a shopper already sees
// on the merchant's real store — never a secret, a token, or PII. Design mirrors routes/embed.ts:
// dependency-injected so the projection + wiring are unit-testable without booting the whole server.
//
// SECURITY posture (see /security-review notes in the plan): (1) NOT AN ORACLE — every non-ok tenant
// resolution returns the SAME uniform 404, exactly like /widget/token's uniform 401, so it can't be probed
// for which shops exist or were suspended; (2) NO SSRF — `shop` is only ever passed to the resolver; the
// actual Shopify fetch host comes from server-side config (shopDomainFor + the adapter's *.myshopify.com
// guard), never from client input; (3) NO SECRET/PII EGRESS — only the neutral, already-published Product
// fields cross the wire; (4) DENIAL-OF-WALLET — per-IP rate limit here + the 30-min grounding cache means a
// cold Shopify fetch happens at most ~once per tenant per TTL regardless of request volume; (5) OUTPUT is
// JSON (safe transport) and merchant-authored text is length-bounded by the adapter — the storefront page
// still renders every string via textContent (never innerHTML), which is where HTML-escaping belongs.

/** One product as the storefront page consumes it. `id` (Shopify gid) is for the widget's cart bridge
 *  (getProductsByIds); `variantId` (numeric) drives the checkout permalink — both are returned per the
 *  WS2 id contract. `cartUrl`/`productUrl` are absent unless their inputs validated. */
export interface StorefrontProductWire {
  id: string;
  title: string;
  price: string;
  priceConfirmed?: boolean;
  availableForSale?: boolean;
  tags?: string[];
  imageUrl?: string;
  handle?: string;
  description: string;
  ingredients?: string[];
  variantId?: string;
  cartUrl?: string;
  productUrl?: string;
}

export interface StorefrontCatalogWire {
  brandName: string;
  policy: StorePolicy;
  products: StorefrontProductWire[];
}

/**
 * Pure projection: a tenant's GroundingContext → the storefront wire shape, building the platform-specific
 * cart/product URLs HERE in the wire layer (never across the neutral port). `cartUrl` only when a numeric
 * variant + a real shop domain are present; `productUrl` only when a valid handle + shop domain are present;
 * both fail-safe to absent (cart-permalink.ts / product-permalink.ts return undefined on any bad input).
 */
export function projectStorefrontCatalog(
  context: GroundingContext,
  shopDomain: string | undefined,
): StorefrontCatalogWire {
  const products: StorefrontProductWire[] = context.products.map((p) => ({
    id: p.id,
    title: p.title,
    price: p.price,
    priceConfirmed: p.priceConfirmed,
    availableForSale: p.availableForSale,
    tags: p.tags,
    imageUrl: p.imageUrl,
    handle: p.handle,
    description: p.description,
    ingredients: p.ingredients,
    variantId: p.variantId,
    cartUrl: shopDomain && p.variantId ? cartPermalink(shopDomain, p.variantId) : undefined,
    productUrl: shopDomain && p.handle ? productPermalink(shopDomain, p.handle) : undefined,
  }));
  return { brandName: context.brandName, policy: context.policy, products };
}

const EMPTY_CATALOG: StorefrontCatalogWire = {
  brandName: "this store",
  policy: { returns: "", shipping: "" },
  products: [],
};

export interface StorefrontCatalogDeps {
  /** Registry/env tenant resolution by shop domain. Non-ok (unknown/revoked/region-unset/error) → uniform 404. */
  resolveTenant(shop: string | undefined): Promise<{ ok: boolean; tenantId?: string }>;
  /** The cached grounding port; fails closed to a safe-empty context (never a wrong tenant's catalog). */
  getContext(tenantId: string): Promise<GroundingContext>;
  /** The tenant's *.myshopify.com domain (server-side config), for building cart/product URLs. */
  shopDomainFor(tenantId: string): Promise<string | undefined>;
  /** Per-IP rate check (public, unauthenticated). true = allowed. Fail-OPEN like /widget/token. */
  allowIp(ipKey: string): Promise<boolean>;
  /** Client IP key from the request (server composes from x-forwarded-for + req.ip). */
  ipKeyFor(req: FastifyRequest): string;
}

const CORS_ORIGIN = "*"; // published data, no credentials, no cookies — deliberately public.

export function registerStorefrontCatalogRoutes(app: FastifyInstance, deps: StorefrontCatalogDeps): void {
  app.options("/storefront/catalog", async (_req, reply) => {
    reply.header("access-control-allow-origin", CORS_ORIGIN);
    reply.header("access-control-allow-methods", "GET, OPTIONS");
    reply.header("access-control-max-age", "600");
    reply.code(204);
    return null;
  });

  app.get("/storefront/catalog", async (req, reply) => {
    reply.header("access-control-allow-origin", CORS_ORIGIN);

    // Per-IP rate limit first (fail-open: the endpoint is cheap behind the grounding cache, and a store
    // failure must not take the storefront down — matches /widget/token's own fail-open mint limiter).
    const ipKey = deps.ipKeyFor(req);
    try {
      if (!(await deps.allowIp(ipKey))) {
        reply.code(429);
        return { error: "rate limited" };
      }
    } catch {
      /* fail-open */
    }

    // Resolve BEFORE any grounding fetch: cheap, and it keeps the 404 path from doing any work / being an
    // oracle. One uniform 404 body for every non-ok outcome.
    const shop = (req.query as { shop?: string } | undefined)?.shop;
    const resolved = await deps.resolveTenant(shop);
    if (!resolved.ok || !resolved.tenantId) {
      reply.code(404);
      return { error: "not found" };
    }
    const tenantId = resolved.tenantId;

    // The cached grounding port already fails closed to safe-empty; guard a genuine throw too so a cold
    // Shopify failure degrades to an honest empty catalog (200) rather than a 500.
    let context: GroundingContext | null = null;
    try {
      context = await deps.getContext(tenantId);
    } catch {
      context = null;
    }
    const shopDomain = await deps.shopDomainFor(tenantId).catch(() => undefined);

    reply.header("cache-control", "public, max-age=300, stale-while-revalidate=600");
    return context ? projectStorefrontCatalog(context, shopDomain) : EMPTY_CATALOG;
  });
}
