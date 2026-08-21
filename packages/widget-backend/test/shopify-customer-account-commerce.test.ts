import { describe, it, expect } from "vitest";
import { InMemoryRuntimeStore, createEnvSecrets } from "@palup/platform-ports";
import type { CommercePort, Principal } from "@palup/platform-ports";
import { withRequestPrincipal } from "../src/commerce-guard.js";
import { createCustomerGrantStore, CAA_GRANT_KEY_SCOPE, CAA_GRANT_KEY_NAME } from "../src/customer-grant-store.js";
import { createCustomerAccountCommerceAdapter, CommerceReauthRequiredError, discoverCustomerApiEndpoint } from "../src/shopify-customer-account-commerce.js";

// ADR-0018 task 8 — the live CAA commerce READ adapter. IDOR-safety: the grant/token + query bind to the
// VERIFIED ALS principal, never the method arg. Fetch is mocked; wire facts verified at the ADR-0018 spike.

const SHOP = "acme-store.myshopify.com";
const ENDPOINT = "https://shopify.com/111/account/customer/api/2026-07/graphql";
const NOW = 1_700_000_000; // ~2023-11-14
const shopper = (id: string): Principal => ({ kind: "shopper", shopperId: id, source: "shopify", verified: true });

const ORDER_DATA = {
  data: { customer: { orders: { nodes: [{ id: "gid://shopify/Order/9", name: "#1009", financialStatus: "PAID", fulfillmentStatus: "FULFILLED", processedAt: "2023-11-10T00:00:00Z", totalPrice: { amount: "42.50", currencyCode: "USD" }, lineItems: { nodes: [{ title: "Barrier Serum", quantity: 1 }] } }] } } },
};
const SUB_DATA = { data: { customer: { subscriptionContracts: { nodes: [{ id: "gid://shopify/SubscriptionContract/7", status: "ACTIVE" }] } } } };
// WS-B2a — a multi-order fixture (unordered processedAt on purpose) to prove getOrderHistory computes
// count + first/last daysAgo from max/min processedAt, not from array order. See node calc: with
// NOW=1_700_000_000, "2023-11-10" -> 4 days ago, "2023-11-01" -> 13 days ago (oldest/first), "2023-11-13"
// -> 1 day ago (newest/last).
const MULTI_ORDER_DATA = {
  data: {
    customer: {
      orders: {
        nodes: [
          { id: "gid://shopify/Order/9", name: "#1009", processedAt: "2023-11-10T00:00:00Z" },
          { id: "gid://shopify/Order/3", name: "#1003", processedAt: "2023-11-01T00:00:00Z" },
          { id: "gid://shopify/Order/13", name: "#1013", processedAt: "2023-11-13T00:00:00Z" },
        ],
      },
    },
  },
};

type FetchFn = typeof globalThis.fetch;
function makeFetch(opts: { graphql?: unknown; status?: number; onAuth?: (auth: unknown) => void } = {}): FetchFn {
  return (async (url: unknown, init?: { headers?: Record<string, string> }) => {
    const u = String(url);
    if (u.endsWith("/.well-known/customer-account-api")) return { ok: true, status: 200, json: async () => ({ graphql_api: ENDPOINT, mcp_api: "https://shopify.com/111/account/customer/api/mcp" }) };
    if (u === ENDPOINT) {
      opts.onAuth?.(init?.headers?.authorization);
      const status = opts.status ?? 200;
      return { ok: status < 400, status, json: async () => opts.graphql ?? {} };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  }) as unknown as FetchFn;
}

const fallbackPolicy = { returnWindowDays: 30, refundCeiling: 50, returns: "R", shipping: "S" };
const fallback: CommercePort = {
  getOrder: async () => null,
  getRecentOrder: async () => null,
  getOrderHistory: async () => null,
  getPolicy: async () => fallbackPolicy,
  getSubscription: async () => null,
  skipNextDelivery: async () => ({ ok: false, detail: "no", reversalPath: "n/a" }),
  pauseSubscription: async () => ({ ok: false, detail: "no", reversalPath: "n/a" }),
  resumeSubscription: async () => ({ ok: false, detail: "no", reversalPath: "n/a" }),
  unskipNextDelivery: async () => ({ ok: false, detail: "no", reversalPath: "n/a" }),
};

async function harness(fetchFn: FetchFn, grantsFor: Record<string, string> = { "shopify:acme:1": "TOKEN-1" }) {
  const store = new InMemoryRuntimeStore();
  const secrets = createEnvSecrets(JSON.stringify({ [CAA_GRANT_KEY_SCOPE]: { [CAA_GRANT_KEY_NAME]: "gk" } }));
  const grants = createCustomerGrantStore(store, secrets);
  for (const [sid, at] of Object.entries(grantsFor)) await grants.put("acme", sid, { accessToken: at, grantedAt: NOW });
  const adapter = createCustomerAccountCommerceAdapter({ grants, shopDomainForTenant: (t) => (t === "acme" ? SHOP : undefined), fallback, fetchFn, now: () => NOW });
  return { adapter, grants };
}

describe("discoverCustomerApiEndpoint", () => {
  it("returns the shopify.com graphql endpoint; a non-shopify host is rejected", async () => {
    expect(await discoverCustomerApiEndpoint(SHOP, makeFetch())).toBe(ENDPOINT);
    const evil = (async () => ({ ok: true, status: 200, json: async () => ({ graphql_api: "https://attacker.example/graphql" }) })) as unknown as FetchFn;
    expect(await discoverCustomerApiEndpoint(SHOP, evil)).toBeNull();
    expect(await discoverCustomerApiEndpoint("evil.example.com", makeFetch())).toBeNull();
  });
});

describe("createCustomerAccountCommerceAdapter — reads", () => {
  it("getRecentOrder maps the CAA order for the verified shopper", async () => {
    const { adapter } = await harness(makeFetch({ graphql: ORDER_DATA }));
    const order = await withRequestPrincipal(shopper("shopify:acme:1"), () => adapter.getRecentOrder("shopify:acme:1"));
    expect(order).toEqual({ id: "#1009", shopperId: "shopify:acme:1", status: "fulfilled", placedDaysAgo: 4, total: 42.5, items: [{ title: "Barrier Serum", price: "" }], fulfilled: true });
  });

  it("IDOR: uses the ALS principal's token, NEVER the method arg", async () => {
    let usedAuth: unknown;
    const { adapter } = await harness(makeFetch({ graphql: ORDER_DATA, onAuth: (a) => (usedAuth = a) }), { "shopify:acme:1": "TOKEN-1", "shopify:acme:2": "TOKEN-2" });
    // Principal is shopper 1, but the arg names shopper 2 — the adapter must ignore the arg.
    const order = await withRequestPrincipal(shopper("shopify:acme:1"), () => adapter.getRecentOrder("shopify:acme:2"));
    expect(usedAuth).toBe("TOKEN-1"); // shopper 1's token, not shopper 2's
    expect(order?.shopperId).toBe("shopify:acme:1");
  });

  it("getSubscription maps an active subscription contract", async () => {
    const { adapter } = await harness(makeFetch({ graphql: SUB_DATA }));
    const sub = await withRequestPrincipal(shopper("shopify:acme:1"), () => adapter.getSubscription("shopify:acme:1"));
    expect(sub).toEqual({ id: "gid://shopify/SubscriptionContract/7", shopperId: "shopify:acme:1", active: true, paused: false });
  });

  it("empty orders ⇒ null (no order), NOT reauth", async () => {
    const { adapter } = await harness(makeFetch({ graphql: { data: { customer: { orders: { nodes: [] } } } } }));
    expect(await withRequestPrincipal(shopper("shopify:acme:1"), () => adapter.getRecentOrder("shopify:acme:1"))).toBeNull();
  });

  it("getOrderHistory maps a multi-order fixture to count + max/min-processedAt daysAgo (WS-B2a)", async () => {
    const { adapter } = await harness(makeFetch({ graphql: MULTI_ORDER_DATA }));
    const history = await withRequestPrincipal(shopper("shopify:acme:1"), () => adapter.getOrderHistory("shopify:acme:1"));
    expect(history).toEqual({ orderCount: 3, lastOrderDaysAgo: 1, firstOrderDaysAgo: 13 });
  });

  it("getOrderHistory: empty orders ⇒ a well-formed zero summary (known account, no orders — NOT null)", async () => {
    const { adapter } = await harness(makeFetch({ graphql: { data: { customer: { orders: { nodes: [] } } } } }));
    const history = await withRequestPrincipal(shopper("shopify:acme:1"), () => adapter.getOrderHistory("shopify:acme:1"));
    expect(history).toEqual({ orderCount: 0, lastOrderDaysAgo: null, firstOrderDaysAgo: null });
  });
});

describe("createCustomerAccountCommerceAdapter — reauth paths", () => {
  it("no grant for the shopper ⇒ CommerceReauthRequiredError", async () => {
    const { adapter } = await harness(makeFetch({ graphql: ORDER_DATA }), {}); // no grants
    await expect(withRequestPrincipal(shopper("shopify:acme:1"), () => adapter.getRecentOrder("shopify:acme:1"))).rejects.toBeInstanceOf(CommerceReauthRequiredError);
  });

  it("an EXPIRED grant ⇒ reauth (refresh is task 7)", async () => {
    const store = new InMemoryRuntimeStore();
    const secrets = createEnvSecrets(JSON.stringify({ [CAA_GRANT_KEY_SCOPE]: { [CAA_GRANT_KEY_NAME]: "gk" } }));
    const grants = createCustomerGrantStore(store, secrets);
    await grants.put("acme", "shopify:acme:1", { accessToken: "T", expiresAt: NOW - 1, grantedAt: NOW - 3600 });
    const adapter = createCustomerAccountCommerceAdapter({ grants, shopDomainForTenant: () => SHOP, fallback, fetchFn: makeFetch({ graphql: ORDER_DATA }), now: () => NOW });
    await expect(withRequestPrincipal(shopper("shopify:acme:1"), () => adapter.getRecentOrder("shopify:acme:1"))).rejects.toBeInstanceOf(CommerceReauthRequiredError);
  });

  it("an anonymous / unverified principal ⇒ reauth (never trusts an arg)", async () => {
    const { adapter } = await harness(makeFetch({ graphql: ORDER_DATA }));
    // No withRequestPrincipal ⇒ the ALS is empty ⇒ currentPrincipal() is anonymous.
    await expect(adapter.getRecentOrder("shopify:acme:1")).rejects.toBeInstanceOf(CommerceReauthRequiredError);
  });

  it("a 401 from the CAA GraphQL ⇒ reauth (token rejected)", async () => {
    const { adapter } = await harness(makeFetch({ graphql: {}, status: 401 }));
    await expect(withRequestPrincipal(shopper("shopify:acme:1"), () => adapter.getRecentOrder("shopify:acme:1"))).rejects.toBeInstanceOf(CommerceReauthRequiredError);
  });

  it("a GraphQL errors response (schema/query) ⇒ null, NOT reauth (no sign-in loop) — reviewer concern B", async () => {
    const { adapter } = await harness(makeFetch({ graphql: { errors: [{ message: "Field 'fulfillmentStatus' doesn't exist" }] } }));
    expect(await withRequestPrincipal(shopper("shopify:acme:1"), () => adapter.getRecentOrder("shopify:acme:1"))).toBeNull();
  });

  it("a 5xx / throttle ⇒ null, NOT reauth (transient) — reviewer concern D", async () => {
    const { adapter } = await harness(makeFetch({ graphql: {}, status: 503 }));
    expect(await withRequestPrincipal(shopper("shopify:acme:1"), () => adapter.getSubscription("shopify:acme:1"))).toBeNull();
  });

  it("getOrderHistory: no grant ⇒ reauth, same as the other reads (WS-B2a)", async () => {
    const { adapter } = await harness(makeFetch({ graphql: MULTI_ORDER_DATA }), {}); // no grants
    await expect(withRequestPrincipal(shopper("shopify:acme:1"), () => adapter.getOrderHistory("shopify:acme:1"))).rejects.toBeInstanceOf(CommerceReauthRequiredError);
  });

  it("getOrderHistory: a 5xx / throttle ⇒ null, NOT reauth (transient degrade path, WS-B2a)", async () => {
    const { adapter } = await harness(makeFetch({ graphql: {}, status: 503 }));
    expect(await withRequestPrincipal(shopper("shopify:acme:1"), () => adapter.getOrderHistory("shopify:acme:1"))).toBeNull();
  });
});

describe("createCustomerAccountCommerceAdapter — delegation", () => {
  it("getPolicy + writes delegate to the fallback (shopper-agnostic / ADR-0016-gated)", async () => {
    const { adapter } = await harness(makeFetch());
    expect(await adapter.getPolicy()).toEqual(fallbackPolicy);
    expect(await adapter.skipNextDelivery("shopify:acme:1")).toEqual({ ok: false, detail: "no", reversalPath: "n/a" });
  });
});
