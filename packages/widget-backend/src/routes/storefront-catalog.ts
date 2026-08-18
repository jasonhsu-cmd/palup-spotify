import type { FastifyInstance, FastifyRequest } from "fastify";
import type { GroundingContext, StorePolicy } from "@palup/platform-ports";
import { cartPermalink } from "../cart-permalink.js";
import { productPermalink } from "../product-permalink.js";
import { safeImageUrl } from "../shopify-grounding.js";

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
  /** Cursor for the next page; absent when there are no more products (drives the grid's "Load more"). */
  nextCursor?: string;
}

/** Products per grid page. A browsable subset — the grid pages, so any catalog size renders. */
export const STOREFRONT_PAGE_LIMIT = 24;

/**
 * Pure projection: a tenant's GroundingContext → the storefront wire shape, building the platform-specific
 * cart/product URLs HERE in the wire layer (never across the neutral port). `cartUrl` only when a numeric
 * variant + a real shop domain are present; `productUrl` only when a valid handle + shop domain are present;
 * both fail-safe to absent (cart-permalink.ts / product-permalink.ts return undefined on any bad input).
 */
export function projectStorefrontCatalog(
  context: GroundingContext,
  shopDomain: string | undefined,
  nextCursor?: string,
): StorefrontCatalogWire {
  const products: StorefrontProductWire[] = context.products.map((p) => ({
    id: p.id,
    title: p.title,
    price: p.price,
    priceConfirmed: p.priceConfirmed,
    availableForSale: p.availableForSale,
    tags: p.tags,
    // Defense in depth (security-review LOW): re-validate at the wire, not just at the adapter, so a
    // future non-conforming GroundingPort adapter can never surface an unvalidated `<img src>` URL.
    imageUrl: safeImageUrl(p.imageUrl),
    handle: p.handle,
    description: p.description,
    ingredients: p.ingredients,
    variantId: p.variantId,
    cartUrl: shopDomain && p.variantId ? cartPermalink(shopDomain, p.variantId) : undefined,
    productUrl: shopDomain && p.handle ? productPermalink(shopDomain, p.handle) : undefined,
  }));
  return { brandName: context.brandName, policy: context.policy, products, nextCursor };
}

const EMPTY_CATALOG: StorefrontCatalogWire = {
  brandName: "this store",
  policy: { returns: "", shipping: "" },
  products: [],
};

export interface StorefrontCatalogDeps {
  /** Registry/env tenant resolution by shop domain. Non-ok (unknown/revoked/region-unset/error) → uniform 404. */
  resolveTenant(shop: string | undefined): Promise<{ ok: boolean; tenantId?: string }>;
  /** Paginated grid fetch — ONE page of products (+ brand/policy) and a cursor for the next page. Fails
   *  closed to a safe-empty context. Unlike the assistant's whole-catalog getContext, this NEVER hits the
   *  1000-SKU ceiling, so it renders any catalog size (browsable subset + "load more"). */
  getCatalogPage(tenantId: string, first: number, after?: string): Promise<{ context: GroundingContext; nextCursor?: string }>;
  /** The tenant's *.myshopify.com domain (server-side config), for building cart/product URLs. */
  shopDomainFor(tenantId: string): Promise<string | undefined>;
  /** Per-IP rate check (public, unauthenticated). true = allowed. Fail-OPEN like /widget/token. */
  allowIp(ipKey: string): Promise<boolean>;
  /**
   * Per-TENANT rate ceiling (security-review MEDIUM — denial-of-wallet backstop). This endpoint fronts the
   * cold `getContext` fetch on the merchant's PRIVATE Shopify token; the per-IP limiter is spoofable via
   * X-Forwarded-For, so an attacker who knows a public *.myshopify.com domain could otherwise stampede a
   * merchant's Storefront API quota at each cache-TTL boundary. This ceiling is keyed by the SERVER-derived
   * tenantId (unspoofable) and MUST fail CLOSED — the server impl denies on any store error. true = allowed. */
  allowTenant(tenantId: string): Promise<boolean>;
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
    // oracle. One uniform 404 body for every non-ok outcome. The resolver swallows its own errors today,
    // but guard a throw too (security-review LOW) so a future throwing resolver can't create a 500-vs-404
    // oracle (error distinguishable from unknown) — every failure collapses to the same 404.
    const q = (req.query as { shop?: string; cursor?: string } | undefined) ?? {};
    const shop = q.shop;
    let resolved: { ok: boolean; tenantId?: string };
    try {
      resolved = await deps.resolveTenant(shop);
    } catch {
      resolved = { ok: false };
    }
    if (!resolved.ok || !resolved.tenantId) {
      reply.code(404);
      return { error: "not found" };
    }
    const tenantId = resolved.tenantId;

    // Per-tenant cost ceiling (security-review MEDIUM). Keyed by the SERVER-derived tenantId (unspoofable),
    // fails CLOSED in the server impl — the real denial-of-wallet backstop for the cold-fetch path, since
    // the per-IP limiter above is spoofable and fail-open. Checked AFTER resolution so an unknown shop can
    // never consume a real tenant's budget.
    if (!(await deps.allowTenant(tenantId))) {
      reply.code(429);
      return { error: "rate limited" };
    }

    // Opaque cursor from the client, bounded (it is echoed back to Shopify's `after`; a length cap keeps a
    // hostile value from bloating the request). Absent ⇒ first page.
    const cursor = typeof q.cursor === "string" && q.cursor.length > 0 && q.cursor.length <= 512 ? q.cursor : undefined;

    // Fetch ONE page. Guard a genuine throw so a cold Shopify failure degrades to an honest empty catalog
    // (200) rather than a 500 — and, unlike the assistant's getContext, this never fails on a >1000-SKU store.
    let page: { context: GroundingContext; nextCursor?: string } | null = null;
    try {
      page = await deps.getCatalogPage(tenantId, STOREFRONT_PAGE_LIMIT, cursor);
    } catch {
      page = null;
    }
    const shopDomain = await deps.shopDomainFor(tenantId).catch(() => undefined);

    reply.header("cache-control", "public, max-age=300, stale-while-revalidate=600");
    return page ? projectStorefrontCatalog(page.context, shopDomain, page.nextCursor) : EMPTY_CATALOG;
  });
}
