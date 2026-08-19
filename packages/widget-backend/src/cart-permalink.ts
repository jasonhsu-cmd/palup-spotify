// C1 — Shopify cart permalink builder. Pure functions that turn a recommended product's variant into a
// pre-filled cart deep link `https://{shopDomain}/cart/{variantId}:{qty}` so a shopper can convert in one
// tap. This generates a LINK ONLY — it never adds to cart, never purchases, and the shopper must still act
// on it (reversible → auto per the C1 governance tag; never auto-purchase). Every function is pure and
// fail-safe: on ANY invalid input it returns undefined rather than a malformed or cross-origin URL.

// Mirrors shopify-grounding.ts's SHOP_HOST: the permalink host must be a Shopify store domain, never an
// arbitrary/attacker host (the link is shown to the shopper, so a bad host would be an open-redirect-style
// hazard). Kept as a local copy rather than an import to avoid coupling this pure helper to the fetch code.
const SHOP_HOST = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i;
// Shopify cart permalinks use the NUMERIC variant id (e.g. /cart/4567:1), not the GID.
const NUMERIC_VARIANT_ID = /^[0-9]{1,20}$/;
/** A sane per-line quantity for a one-tap recommendation link; above it we refuse rather than believe. */
export const MAX_PERMALINK_QTY = 99;

/**
 * True only for a plain `<label>.myshopify.com` string — the same host rule `cartPermalink` itself
 * enforces. Exported (rather than kept private, unlike the sibling permalink builders in this package)
 * so the multi-line CartPort permalink adapter (`cart-permalink-adapter.ts`) can reuse this exact check
 * instead of re-deriving its own copy of SHOP_HOST.
 */
export function isValidShopDomain(shopDomain: string): boolean {
  return SHOP_HOST.test(shopDomain);
}

/**
 * Extract the numeric variant id a cart permalink needs from a Shopify ProductVariant GID
 * (`gid://shopify/ProductVariant/4567` → `"4567"`), or accept an already-numeric id. Returns undefined for
 * anything else — never guesses. Pure.
 */
export function variantNumericId(variantIdOrGid: string): string | undefined {
  const trimmed = variantIdOrGid.trim();
  if (NUMERIC_VARIANT_ID.test(trimmed)) return trimmed;
  const m = trimmed.match(/^gid:\/\/shopify\/ProductVariant\/([0-9]{1,20})$/);
  return m ? m[1] : undefined;
}

/**
 * Build a Shopify cart permalink, or undefined if any input is invalid (bad host, non-numeric/absent
 * variant id, or out-of-range quantity). Never throws, never returns a partial/unsafe URL.
 */
export function cartPermalink(shopDomain: string, variantIdOrGid: string, qty = 1): string | undefined {
  if (!isValidShopDomain(shopDomain)) return undefined;
  const variantId = variantNumericId(variantIdOrGid);
  if (variantId === undefined) return undefined;
  if (!Number.isInteger(qty) || qty < 1 || qty > MAX_PERMALINK_QTY) return undefined;
  return `https://${shopDomain}/cart/${variantId}:${qty}`;
}
