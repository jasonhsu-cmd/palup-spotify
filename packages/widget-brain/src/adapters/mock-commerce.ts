import type { CommercePolicy, CommercePort, Order, Subscription } from "@palup/platform-ports";

// Demo commerce data (stands in for the Shopify adapter). Shopper "shopper-demo" owns #1042/#1050/#2000
// and a subscription; #9999 belongs to someone else (used to test ownership verification).
const ORDERS: Record<string, Order> = {
  "1042": { id: "1042", shopperId: "shopper-demo", status: "in transit", eta: "arriving in about 2 days", placedDaysAgo: 3, total: 68, items: [{ title: "Gentle Daily Cleanser", price: "$18" }, { title: "Vitamin-C Brightening Serum", price: "$34" }], fulfilled: true },
  "1050": { id: "1050", shopperId: "shopper-demo", status: "stuck in transit (no movement for 4 days)", placedDaysAgo: 9, total: 40, items: [{ title: "Daily Moisturizer", price: "$24" }], fulfilled: true },
  "2000": { id: "2000", shopperId: "shopper-demo", status: "delivered", placedDaysAgo: 5, total: 180, items: [{ title: "Brightening Glow Set", price: "$78" }, { title: "Barrier Repair Cream", price: "$32" }], fulfilled: true },
  "3100": { id: "3100", shopperId: "shopper-demo", status: "not yet shipped", placedDaysAgo: 0, total: 26, items: [{ title: "Caffeine Eye Cream", price: "$26" }], fulfilled: false },
  "9999": { id: "9999", shopperId: "someone-else", status: "delivered", placedDaysAgo: 2, total: 50, items: [], fulfilled: true },
};

const POLICY: CommercePolicy = {
  returnWindowDays: 30,
  refundCeiling: 75,
  returns: "unopened items are fully refundable within 30 days; opened items are reviewed case-by-case.",
  shipping: "free over $75; 3–5 business days in the US. Lost/undelivered packages: reship or refund after a carrier check.",
};

export class MockCommerceAdapter implements CommercePort {
  async getOrder(orderId: string): Promise<Order | null> {
    return ORDERS[orderId.replace(/[^0-9]/g, "")] ?? null;
  }
  async getRecentOrder(shopperId: string): Promise<Order | null> {
    const owned = Object.values(ORDERS).filter((o) => o.shopperId === shopperId);
    // "most relevant recent" for a where-is-it question = the one still in transit, else newest.
    return owned.find((o) => o.status.includes("transit")) ?? owned[0] ?? null;
  }
  async getPolicy(): Promise<CommercePolicy> {
    return POLICY;
  }
  async getSubscription(shopperId: string): Promise<Subscription | null> {
    return shopperId === "shopper-demo" ? { id: "sub-1", shopperId, active: true } : null;
  }
}
