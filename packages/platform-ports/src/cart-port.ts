// CartPort (ADR-0001) — Pillar 2a. Portability seam for "turn recommended lines into something the
// shopper can pay with". Today the only adapter is a Shopify checkout-permalink builder (pure string
// construction, no new OAuth scope: a `/cart/` deep link is just a URL the shopper opens to complete
// checkout on Shopify — see `packages/widget-backend/src/cart-permalink-adapter.ts`). A future
// Storefront-Cart-write adapter will implement this same interface against Shopify's Cart API (or another
// commerce platform's cart primitive) and return a real cart's checkoutUrl — callers never need to know
// which. INERT: nothing in this package wires a caller to this port yet.

export interface CartLine {
  variantId: string;
  quantity: number;
}

export interface CartCheckout {
  checkoutUrl: string;
}

export interface CartPort {
  /**
   * Build a checkout for these lines. Returns null when NO valid line resolves. A permalink adapter
   * returns a Shopify /cart/ deep link (no new scope; shopper completes on Shopify); a future
   * Storefront-Cart-write adapter returns a real cart's checkoutUrl.
   */
  createCheckout(lines: CartLine[]): Promise<CartCheckout | null>;
}
