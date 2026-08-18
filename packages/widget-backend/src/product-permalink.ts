// WS2 — Shopify product-page permalink builder. Pure, fail-safe sibling of cart-permalink.ts: turns a
// product's neutral `handle` into a canonical storefront product URL `https://{shopDomain}/products/{handle}`
// so the storefront/widget can link to the real product page. This is the WIRE (platform-specific) layer —
// the neutral GroundingPort never carries a URL (portability: no Shopify URL crosses the port). Like
// cart-permalink, EVERY input is validated and any invalid input returns undefined rather than a malformed
// or cross-origin URL (the link is shown to a shopper, so a bad host would be an open-redirect hazard).

// Mirrors shopify-grounding.ts's SHOP_HOST / cart-permalink.ts: the permalink host must be a Shopify store
// domain, never an arbitrary/attacker host. Local copy (not an import) to keep this pure helper uncoupled.
const SHOP_HOST = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i;
// Shopify handles are lowercase alphanumerics + hyphens (underscores permitted historically); reject
// anything else so a malformed slug can never smuggle a path/host into the rendered URL.
const HANDLE_SHAPE = /^[a-z0-9][a-z0-9_-]*$/i;
/** A sane handle length bound (matches the adapter's MAX_HANDLE) — refuse rather than believe above it. */
export const MAX_PRODUCT_HANDLE = 200;

/**
 * Build a Shopify product-page permalink, or undefined if any input is invalid (bad host, empty/illegal/
 * overlong handle). Never throws, never returns a partial/unsafe URL.
 */
export function productPermalink(shopDomain: string, handle: string): string | undefined {
  if (!SHOP_HOST.test(shopDomain)) return undefined;
  const h = handle.trim();
  if (h.length === 0 || h.length > MAX_PRODUCT_HANDLE || !HANDLE_SHAPE.test(h)) return undefined;
  return `https://${shopDomain}/products/${h}`;
}
