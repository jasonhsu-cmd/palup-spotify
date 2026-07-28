// Commerce port (ADR-0001): order/policy/subscription reads for support. The Shopify adapter
// implements this later; a mock adapter backs it for now. Feature code never calls Shopify directly.

export interface OrderItem {
  title: string;
  price: string;
}

export interface Order {
  id: string;
  /** Owner — the brain verifies this against the current shopper before revealing anything. */
  shopperId: string;
  status: string;
  /** Human ETA string, or undefined if genuinely unknown (never fabricate one). */
  eta?: string;
  placedDaysAgo: number;
  total: number;
  items: OrderItem[];
  /** Has it shipped? Gates whether an order can still be cancelled / address changed. */
  fulfilled: boolean;
}

export interface Subscription {
  id: string;
  shopperId: string;
  active: boolean;
}

export interface CommercePolicy {
  returnWindowDays: number;
  /** Refunds above this are HITL — the agent may never auto-approve them. */
  refundCeiling: number;
  returns: string;
  shipping: string;
}

export interface CommercePort {
  getOrder(orderId: string): Promise<Order | null>;
  /** The shopper's most recent order — used when they ask "where's my order?" with no number. */
  getRecentOrder(shopperId: string): Promise<Order | null>;
  getPolicy(): Promise<CommercePolicy>;
  getSubscription(shopperId: string): Promise<Subscription | null>;
}
