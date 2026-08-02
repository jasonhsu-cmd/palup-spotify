import type { CommercePort, Order, Subscription, Principal } from "@palup/platform-ports";
import { shopperIdTenant } from "@palup/platform-ports";
import { currentPrincipal, isVerifiedShopper } from "./commerce-guard.js";
import type { CustomerGrantStore } from "./customer-grant-store.js";

// ADR-0018 task 8 — the LIVE Customer Account API commerce READ adapter. IDOR-safe by construction: it
// reads orders/subscriptions AS the VERIFIED request principal (from the commerce-guard ALS), looks up
// THAT principal's stored OAuth grant, and queries the CAA GraphQL with the shopper's OWN access token —
// never a method arg / tool output / brain input; the token never reaches the client. getPolicy + the
// ADR-0016 writes delegate to `fallback` (policy is shopper-agnostic — grounding's job; writes stay
// human-routed until ADR-0016 enactment). Returns a typed CommerceReauthRequiredError when the grant is
// absent / expired / rejected (refresh is task 7; the widget re-triggers sign-in — task 10).
//
// Wire facts VERIFIED (shopify.dev + the live discovery doc, 2026-08-02): the GraphQL endpoint is
// discovered via `https://{shop}/.well-known/customer-account-api` →
// `https://shopify.com/<shop-id>/account/customer/api/2026-07/graphql` (host shopify.com); the request
// authenticates with `Authorization: <access_token>` (NO "Bearer" prefix) + `Content-Type: application/json`;
// Order exposes id/name/financialStatus/fulfillmentStatus/totalPrice{amount currencyCode}/processedAt/
// lineItems, and `customer.subscriptionContracts` is queryable (fully available since the 2024-10 Customer
// API). Exact enum values + LineItem sub-fields are confirmed at the live smoke (task 12).

const SHOPIFY_HOST = /^([a-z0-9-]+\.)*shopify\.com$/i; // the endpoint host (same pin as the OAuth adapter)
const SHOP_HOST = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i; // the discovery host
const isShopifyHttps = (u: string): boolean => {
  try {
    const x = new URL(u);
    return x.protocol === "https:" && SHOPIFY_HOST.test(x.hostname);
  } catch {
    return false;
  }
};

/** Absent / expired / rejected grant ⇒ the shopper must re-authorize. Typed so the caller can prompt sign-in. */
export class CommerceReauthRequiredError extends Error {
  constructor(public readonly method: string) {
    super(`reauth_required: ${method}`);
    this.name = "CommerceReauthRequiredError";
  }
}

/**
 * Discover the CAA GraphQL endpoint for a shop from `{shop}/.well-known/customer-account-api`, host-pinned
 * to shopify.com (the access token is put on this URL). The exact JSON field name isn't pinned, so pick the
 * shopify.com https value that looks like the graphql endpoint. Null on any failure (⇒ caller reauths).
 */
export async function discoverCustomerApiEndpoint(shopDomain: string, fetchFn: typeof globalThis.fetch = globalThis.fetch, timeoutMs = 4000): Promise<string | null> {
  if (!SHOP_HOST.test(shopDomain)) return null;
  try {
    const res = await fetchFn(`https://${shopDomain}/.well-known/customer-account-api`, { redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const j = (await res.json()) as Record<string, unknown>;
    const values = j && typeof j === "object" ? Object.values(j).filter((v): v is string => typeof v === "string") : [];
    return values.find((v) => isShopifyHttps(v) && /\/graphql\b/.test(v)) ?? null;
  } catch {
    return null;
  }
}

const ORDERS_QUERY = `query PalUpOrders($first: Int!) {
  customer { orders(first: $first, reverse: true) {
    nodes { id name financialStatus fulfillmentStatus processedAt totalPrice { amount currencyCode } lineItems(first: 5) { nodes { title quantity } } }
  } }
}`;
const SUBS_QUERY = `query PalUpSubs($first: Int!) { customer { subscriptionContracts(first: $first) { nodes { id status } } } }`;

interface RawOrder {
  id: string;
  name?: string;
  financialStatus?: string;
  fulfillmentStatus?: string;
  processedAt?: string;
  totalPrice?: { amount?: string; currencyCode?: string };
  lineItems?: { nodes?: Array<{ title?: string; quantity?: number }> };
}
interface RawSub {
  id: string;
  status?: string;
}

function mapStatus(fulfillment?: string, financial?: string): string {
  switch ((fulfillment ?? "").toUpperCase()) {
    case "FULFILLED":
      return "fulfilled";
    case "IN_TRANSIT":
    case "OUT_FOR_DELIVERY":
      return "in transit";
    case "PARTIALLY_FULFILLED":
      return "partially fulfilled";
    case "UNFULFILLED":
      return "processing";
    default:
      return ((financial ?? fulfillment) ?? "unknown").toLowerCase();
  }
}

function mapOrder(o: RawOrder, shopperId: string, now: () => number): Order {
  const items = (o.lineItems?.nodes ?? []).map((li) => ({ title: li.title ?? "item", price: "" })); // never fabricate a per-line price
  const total = o.totalPrice?.amount ? Number(o.totalPrice.amount) : 0;
  const processedSec = o.processedAt ? Math.floor(Date.parse(o.processedAt) / 1000) : NaN;
  const placedDaysAgo = Number.isFinite(processedSec) ? Math.max(0, Math.floor((now() - processedSec) / 86_400)) : 0;
  return {
    id: o.name || o.id,
    shopperId,
    status: mapStatus(o.fulfillmentStatus, o.financialStatus),
    placedDaysAgo,
    total: Number.isFinite(total) ? total : 0,
    items,
    fulfilled: (o.fulfillmentStatus ?? "").toUpperCase() === "FULFILLED",
  };
}

function mapSub(s: RawSub, shopperId: string): Subscription {
  const st = (s.status ?? "").toUpperCase();
  return { id: s.id, shopperId, active: st === "ACTIVE", paused: st === "PAUSED" };
}

export interface CaaCommerceDeps {
  grants: CustomerGrantStore;
  /** tenant → its `*.myshopify.com` domain (from parseStoreDomains) — used to discover the CAA endpoint. */
  shopDomainForTenant: (tenant: string) => string | undefined;
  /** getPolicy + the ADR-0016 writes delegate here (shopper-agnostic / gated). */
  fallback: CommercePort;
  fetchFn?: typeof globalThis.fetch;
  /** The verified request principal; defaults to the commerce-guard ALS (IDOR-safe — never a method arg). */
  getPrincipal?: () => Principal;
  now?: () => number; // unix seconds
  timeoutMs?: number;
}

export function createCustomerAccountCommerceAdapter(deps: CaaCommerceDeps): CommercePort {
  const fetchFn = deps.fetchFn ?? globalThis.fetch;
  const getPrincipal = deps.getPrincipal ?? currentPrincipal;
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const timeoutMs = deps.timeoutMs ?? 4000;

  // Resolve the verified shopper → their grant → the CAA endpoint. Everything derives from the ALS
  // principal (never the method arg). Throws CommerceReauthRequiredError on any missing/expired piece.
  async function resolve(method: string): Promise<{ shopperId: string; endpoint: string; accessToken: string }> {
    const p = getPrincipal();
    if (!isVerifiedShopper(p)) throw new CommerceReauthRequiredError(method); // the guard also refuses; never trust an arg
    const tenant = shopperIdTenant(p.shopperId);
    if (!tenant) throw new CommerceReauthRequiredError(method);
    const grant = await deps.grants.get(tenant, p.shopperId);
    if (!grant || (grant.expiresAt !== undefined && grant.expiresAt <= now())) throw new CommerceReauthRequiredError(method); // absent/expired ⇒ reauth (refresh = task 7)
    const shopDomain = deps.shopDomainForTenant(tenant);
    if (!shopDomain) throw new CommerceReauthRequiredError(method);
    const endpoint = await discoverCustomerApiEndpoint(shopDomain, fetchFn, timeoutMs);
    if (!endpoint) throw new CommerceReauthRequiredError(method);
    return { shopperId: p.shopperId, endpoint, accessToken: grant.accessToken };
  }

  // Discriminated so the caller can tell a REJECTED TOKEN (401/403 ⇒ reauth) apart from a transient/
  // schema/network problem (⇒ "unavailable", surfaced as null — NOT reauth). Collapsing everything to
  // reauth would loop the shopper through sign-in on a throttle or a query/schema bug (security-reviewer
  // concern B/D). "ok" carries data even when a list is empty (⇒ legitimately "no orders").
  async function gql<T>(endpoint: string, accessToken: string, query: string, variables: Record<string, unknown>): Promise<{ kind: "ok"; data: T } | { kind: "reauth" } | { kind: "unavailable" }> {
    try {
      const res = await fetchFn(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: accessToken }, // CAA: raw token, NO Bearer prefix
        body: JSON.stringify({ query, variables }),
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 401 || res.status === 403) return { kind: "reauth" }; // token rejected
      if (!res.ok) return { kind: "unavailable" }; // 5xx / throttle
      const j = (await res.json()) as { data?: T; errors?: unknown[] };
      if (Array.isArray(j.errors) && j.errors.length) return { kind: "unavailable" }; // query/schema error — do NOT loop reauth
      return j.data != null ? { kind: "ok", data: j.data } : { kind: "unavailable" };
    } catch {
      return { kind: "unavailable" }; // network / abort
    }
  }

  return {
    async getRecentOrder(_shopperId: string): Promise<Order | null> {
      const c = await resolve("getRecentOrder"); // NB: ignores the arg — binds to the ALS principal
      const r = await gql<{ customer?: { orders?: { nodes?: RawOrder[] } } }>(c.endpoint, c.accessToken, ORDERS_QUERY, { first: 1 });
      if (r.kind === "reauth") throw new CommerceReauthRequiredError("getRecentOrder");
      if (r.kind === "unavailable") return null; // transient/schema — no data; don't loop reauth
      const node = r.data.customer?.orders?.nodes?.[0];
      return node ? mapOrder(node, c.shopperId, now) : null;
    },
    async getOrder(orderId: string): Promise<Order | null> {
      // The token only ever sees the authenticated customer's OWN orders; we match the id within that set
      // (never a cross-account fetch by arbitrary id).
      const c = await resolve("getOrder");
      const r = await gql<{ customer?: { orders?: { nodes?: RawOrder[] } } }>(c.endpoint, c.accessToken, ORDERS_QUERY, { first: 10 });
      if (r.kind === "reauth") throw new CommerceReauthRequiredError("getOrder");
      if (r.kind === "unavailable") return null;
      const node = (r.data.customer?.orders?.nodes ?? []).find((n) => n.id === orderId || n.name === orderId);
      return node ? mapOrder(node, c.shopperId, now) : null;
    },
    async getSubscription(_shopperId: string): Promise<Subscription | null> {
      const c = await resolve("getSubscription");
      const r = await gql<{ customer?: { subscriptionContracts?: { nodes?: RawSub[] } } }>(c.endpoint, c.accessToken, SUBS_QUERY, { first: 5 });
      if (r.kind === "reauth") throw new CommerceReauthRequiredError("getSubscription");
      if (r.kind === "unavailable") return null;
      const nodes = r.data.customer?.subscriptionContracts?.nodes ?? [];
      const node = nodes.find((n) => (n.status ?? "").toUpperCase() === "ACTIVE") ?? nodes[0];
      return node ? mapSub(node, c.shopperId) : null;
    },
    // Shopper-agnostic / ADR-0016-gated ⇒ delegate to the fallback (mock today).
    getPolicy: () => deps.fallback.getPolicy(),
    skipNextDelivery: (s) => deps.fallback.skipNextDelivery(s),
    pauseSubscription: (s) => deps.fallback.pauseSubscription(s),
    resumeSubscription: (s) => deps.fallback.resumeSubscription(s),
    unskipNextDelivery: (s) => deps.fallback.unskipNextDelivery(s),
  };
}
