// Pillar 2a — CartPort adapter: multi-line Shopify checkout permalink. Extends C1's single-line
// `cartPermalink` (cart-permalink.ts) to N lines: `https://<shopDomain>/cart/<v1>:<q1>,<v2>:<q2>,...`.
// This is a `/cart/` DEEP LINK the shopper opens to complete checkout on Shopify themselves — it needs no
// new OAuth scope, adds nothing to a cart server-side, and makes no purchase. PURE: no I/O, no Shopify
// SDK/fetch, no secrets, just string construction, so it stays free of any shopper-facing capability claim
// (this file is scanned by shopper-promise-guard). INERT: no route/caller wires this in yet.
//
// Reuses cart-permalink.ts's validators rather than re-deriving them: `isValidShopDomain` (SHOP_HOST),
// `variantNumericId` (gid → numeric id), and `MAX_PERMALINK_QTY` (the per-line quantity cap).

import type { CartPort, CartLine, CartCheckout } from "@palup/platform-ports";
import { isValidShopDomain, variantNumericId, MAX_PERMALINK_QTY } from "./cart-permalink.js";

/**
 * Resolve one CartLine to a `variantId:qty` permalink segment, or undefined if the line is invalid
 * (unresolvable variant, or a sub-1/non-integer quantity — mirrors `cartPermalink`'s refusal for those
 * cases). A quantity above `MAX_PERMALINK_QTY` is clamped down to the cap rather than dropped, since a
 * capped quantity is still a safe, fulfillable line (unlike an unresolvable variant or a nonsensical qty).
 */
function resolveLine(line: CartLine): string | undefined {
  const variantId = variantNumericId(line.variantId);
  if (variantId === undefined) return undefined;
  if (!Number.isInteger(line.quantity) || line.quantity < 1) return undefined;
  const qty = Math.min(line.quantity, MAX_PERMALINK_QTY);
  return `${variantId}:${qty}`;
}

/**
 * Build a CartPort backed by a Shopify multi-line checkout permalink for `shopDomain`. Order-preserving:
 * invalid lines are dropped, valid ones keep their input order. Returns null if `shopDomain` is not a
 * `*.myshopify.com` host, if `lines` is empty, or if every line is invalid.
 */
export function createCartPermalinkAdapter(shopDomain: string): CartPort {
  return {
    async createCheckout(lines: CartLine[]): Promise<CartCheckout | null> {
      if (!isValidShopDomain(shopDomain)) return null;
      const segments = lines.map(resolveLine).filter((s): s is string => s !== undefined);
      if (segments.length === 0) return null;
      return { checkoutUrl: `https://${shopDomain}/cart/${segments.join(",")}` };
    },
  };
}
