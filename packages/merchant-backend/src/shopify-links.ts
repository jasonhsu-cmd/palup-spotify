// W5 — Shopify admin deep-links for money/read-through actions. Returns admin-RELATIVE paths (no shop
// origin): the embedded console resolves them against the merchant's admin via App Bridge, so the
// server never needs the shop domain and no host is hard-coded here (portability). Money actions
// (issuing a refund, viewing a payout) always land IN Shopify — PalUp never performs them.

/** Deep-link to an order's page in Shopify admin (where the merchant issues a refund / edits it). */
export function shopifyOrderAdminPath(orderId: string): string {
  return `admin/orders/${orderId}`;
}

/** Deep-link to the Shopify payments/payouts settings page. */
export function shopifyPayoutsAdminPath(): string {
  return "admin/settings/payments";
}
