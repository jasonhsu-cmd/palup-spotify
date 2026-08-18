import { describe, it, expect } from "vitest";
import { InMemoryRuntimeStore, createEnvSecrets } from "@palup/platform-ports";
import type { Principal } from "@palup/platform-ports";
import { createCommercePort } from "../src/model.js";
import { guardCommercePort, withRequestPrincipal, CommerceGuardRefusalError } from "../src/commerce-guard.js";
import { createCustomerGrantStore, CAA_GRANT_KEY_SCOPE, CAA_GRANT_KEY_NAME } from "../src/customer-grant-store.js";

// Wave-1 E (revenue-flywheel plan) — wires the live Customer Account API (CAA) commerce adapter into the
// composition root's `createCommercePort()`, behind the SAME `caaEnabled` posture server.ts computes as
// `CAA_ENABLED` (SHOPPER_AUTH + WIDGET_AUTH_REQUIRED + a configured redirect_uri + shopper-token secret).
// Ships DARK: the default (no deps / caaEnabled false or absent) MUST stay byte-identical to the
// pre-Wave-1-E mock — that is ALSO pinned by commerce-fixture-marker.test.ts, which calls
// `createCommercePort()` with NO ARGS at all; this file adds the explicit on/off matrix plus the live path.

const SHOP = "acme-store.myshopify.com";
const ENDPOINT = "https://shopify.com/111/account/customer/api/2026-07/graphql";
const NOW = 1_700_000_000;
const shopper = (id: string): Principal => ({ kind: "shopper", shopperId: id, source: "shopify", verified: true });

const ORDER_DATA = {
  data: {
    customer: {
      orders: {
        nodes: [
          {
            id: "gid://shopify/Order/9",
            name: "#1009",
            financialStatus: "PAID",
            fulfillmentStatus: "FULFILLED",
            processedAt: "2023-11-10T00:00:00Z",
            totalPrice: { amount: "42.50", currencyCode: "USD" },
            lineItems: { nodes: [{ title: "Barrier Serum", quantity: 1 }] },
          },
        ],
      },
    },
  },
};

type FetchFn = typeof globalThis.fetch;
function makeFetch(): FetchFn {
  return (async (url: unknown) => {
    const u = String(url);
    if (u.endsWith("/.well-known/customer-account-api")) {
      return { ok: true, status: 200, json: async () => ({ graphql_api: ENDPOINT }) };
    }
    if (u === ENDPOINT) {
      return { ok: true, status: 200, json: async () => ORDER_DATA };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  }) as unknown as FetchFn;
}

async function grantsWithOneShopper(): Promise<ReturnType<typeof createCustomerGrantStore>> {
  const store = new InMemoryRuntimeStore();
  const secrets = createEnvSecrets(JSON.stringify({ [CAA_GRANT_KEY_SCOPE]: { [CAA_GRANT_KEY_NAME]: "gk" } }));
  const grants = createCustomerGrantStore(store, secrets);
  await grants.put("acme", "shopify:acme:1", { accessToken: "TOKEN-1", grantedAt: NOW });
  return grants;
}

describe("createCommercePort — CAA disabled (the default; ships dark)", () => {
  it("no deps at all ⇒ the mock, isLive:false (mirrors commerce-fixture-marker.test.ts)", () => {
    const { port, isLive } = createCommercePort();
    expect(isLive).toBe(false);
    expect(port.isFixtureData).toBe(true);
  });

  it("caaEnabled explicitly false ⇒ still the mock, isLive:false, even with grants/shopDomainForTenant present", async () => {
    const grants = await grantsWithOneShopper();
    const { port, isLive } = createCommercePort({
      grants,
      shopDomainForTenant: () => SHOP,
      caaEnabled: false,
    });
    expect(isLive).toBe(false);
    expect(port.isFixtureData).toBe(true);
  });

  it("caaEnabled true but grants/shopDomainForTenant missing ⇒ falls back to the mock (never half-wires live)", () => {
    const { port, isLive } = createCommercePort({ caaEnabled: true });
    expect(isLive).toBe(false);
    expect(port.isFixtureData).toBe(true);
  });
});

describe("createCommercePort — CAA enabled: the live adapter", () => {
  it("a grant present ⇒ returns the live adapter, isLive:true, and getOrder reads real order data", async () => {
    const grants = await grantsWithOneShopper();
    const { port, isLive } = createCommercePort({
      grants,
      shopDomainForTenant: (t) => (t === "acme" ? SHOP : undefined),
      caaEnabled: true,
      fetchFn: makeFetch(),
    });
    expect(isLive).toBe(true);
    expect(port.isFixtureData).toBeUndefined(); // NOT fixture data — a live adapter must never carry this marker

    const order = await withRequestPrincipal(shopper("shopify:acme:1"), () => port.getOrder("#1009"));
    // `model.ts`'s `createCommercePort` does not expose a `now` override (only the adapter itself does,
    // exercised directly by shopify-customer-account-commerce.test.ts), so `placedDaysAgo` is computed
    // against the REAL clock here — assert it separately rather than pin a value that drifts with time.
    const expectedPlacedDaysAgo = Math.max(0, Math.floor((Date.now() / 1000 - Date.parse("2023-11-10T00:00:00Z") / 1000) / 86_400));
    expect(order?.placedDaysAgo).toBe(expectedPlacedDaysAgo);
    expect(order).toEqual({
      id: "#1009",
      shopperId: "shopify:acme:1",
      status: "fulfilled",
      placedDaysAgo: expectedPlacedDaysAgo,
      total: 42.5,
      items: [{ title: "Barrier Serum", price: "" }],
      fulfilled: true,
    });
  });

  it("an async shopDomainForTenant (mirrors MerchantResolver.shopDomainFor) works identically", async () => {
    const grants = await grantsWithOneShopper();
    const { port } = createCommercePort({
      grants,
      shopDomainForTenant: async (t) => (t === "acme" ? SHOP : undefined),
      caaEnabled: true,
      fetchFn: makeFetch(),
    });
    const order = await withRequestPrincipal(shopper("shopify:acme:1"), () => port.getOrder("#1009"));
    expect(order?.id).toBe("#1009");
  });
});

describe("createCommercePort — the ADR-0016 fail-closed guard auto-activates on the live path", () => {
  it("live (isLive:true) + no bound principal (anonymous) ⇒ the guard refuses", async () => {
    const grants = await grantsWithOneShopper();
    const { port, isLive } = createCommercePort({
      grants,
      shopDomainForTenant: () => SHOP,
      caaEnabled: true,
      fetchFn: makeFetch(),
    });
    const guarded = guardCommercePort(port, isLive);
    await expect(guarded.getOrder("#1009")).rejects.toBeInstanceOf(CommerceGuardRefusalError);
  });

  it("live (isLive:true) + a verified shopper principal ⇒ the guard lets the real call through", async () => {
    const grants = await grantsWithOneShopper();
    const { port, isLive } = createCommercePort({
      grants,
      shopDomainForTenant: () => SHOP,
      caaEnabled: true,
      fetchFn: makeFetch(),
    });
    const guarded = guardCommercePort(port, isLive);
    const order = await withRequestPrincipal(shopper("shopify:acme:1"), () => guarded.getOrder("#1009"));
    expect(order?.id).toBe("#1009");
  });

  it("mock (isLive:false, the default/dark path) ⇒ the guard is a no-op regardless of principal", async () => {
    const { port, isLive } = createCommercePort();
    const guarded = guardCommercePort(port, isLive);
    await expect(guarded.getPolicy()).resolves.toBeTruthy(); // no bound principal at all — still resolves
  });
});
