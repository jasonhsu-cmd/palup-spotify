import { describe, expect, it, vi } from "vitest";
import { makeApiClient, ApiError, type PaymentsView } from "../src/app/api.js";

// W5 (Task 10) — ApiClient.getOrders / getPayments. Mirrors the TDD shape already used by
// src/app/api.test.ts (mockFetch + headersOf helpers) for each new method: right path/verb, the
// bearer token attached, a typed parse of the response, and error propagation on a non-2xx.

function mockFetch(impl: (url: string, init: RequestInit) => Response | Promise<Response>) {
  return vi.fn<typeof fetch>((url, init) => Promise.resolve(impl(String(url), (init ?? {}) as RequestInit)));
}

function headersOf(init: RequestInit | undefined): Record<string, string> {
  return init!.headers as Record<string, string>;
}

const PAYMENTS_BODY: PaymentsView = {
  period: "2026-08",
  payouts: [],
  payoutTotalUsd: 0,
  fee: { chargeable: false, ratePct: 6, baseIncrementalUsd: null, computedFeeUsd: null, reason: "attribution_underpowered" },
  payoutsAdminPath: "admin/settings/payments",
  trustNote: "PalUp never touches your money.",
};

describe("ApiClient W5 — getOrders", () => {
  it("issues a GET to /orders", async () => {
    const fetchSpy = mockFetch(() => new Response(JSON.stringify({ items: [], source: "unavailable", sourceNote: "x" }), { status: 200 }));
    const api = makeApiClient({ baseUrl: "/api", getToken: async () => "t", fetch: fetchSpy });
    await api.getOrders();
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("/api/orders");
    expect(init?.method).toBeUndefined(); // GET is the fetch default; api.ts never sets `method` for reads
  });

  it("sends the App Bridge session token as a bearer", async () => {
    const fetchSpy = mockFetch(() => new Response(JSON.stringify({ items: [], source: "unavailable", sourceNote: "x" }), { status: 200 }));
    const api = makeApiClient({ baseUrl: "/api", getToken: async () => "sess-orders", fetch: fetchSpy });
    await api.getOrders();
    expect(headersOf(fetchSpy.mock.calls[0]![1]).Authorization).toBe("Bearer sess-orders");
  });

  it("returns the typed items/source/sourceNote envelope, unavailable case", async () => {
    const fetchSpy = mockFetch(
      () =>
        new Response(
          JSON.stringify({ items: [], source: "unavailable", sourceNote: "Order read-through is not connected yet." }),
          { status: 200 },
        ),
    );
    const api = makeApiClient({ baseUrl: "/api", getToken: async () => "t", fetch: fetchSpy });
    const result = await api.getOrders();
    expect(result).toEqual({ items: [], source: "unavailable", sourceNote: "Order read-through is not connected yet." });
  });

  it("returns a live order carrying its factual touchpoints and admin deep-link — no incremental $", async () => {
    const order = {
      id: "gid://order/1",
      orderNumber: "#1001",
      placedAt: "2026-08-20T00:00:00.000Z",
      totalUsd: 42.5,
      currency: "USD",
      financialStatus: "paid",
      fulfillmentStatus: "fulfilled",
      customerLabel: "Jamie R.",
      touchpoints: [{ orderRef: "gid://order/1", seq: 3, at: "2026-08-20T00:05:00.000Z", actor: "agent-winback", action: "proposal.executed" }],
      adminPath: "admin/orders/1",
    };
    const fetchSpy = mockFetch(
      () => new Response(JSON.stringify({ items: [order], source: "live", sourceNote: "Shopify is the system of record." }), { status: 200 }),
    );
    const api = makeApiClient({ baseUrl: "/api", getToken: async () => "t", fetch: fetchSpy });
    const result = await api.getOrders();
    expect(result.source).toBe("live");
    expect(result.items).toEqual([order]);
    // The OrderView type carries no incremental/attributed-revenue field — only the factual order
    // total (totalUsd, a real Shopify order amount) and per-order agent touchpoints.
    expect(Object.keys(order)).not.toContain("incrementalUsd");
    expect(Object.keys(order)).not.toContain("attributedRevenue");
  });

  it("propagates a non-2xx as a typed ApiError", async () => {
    const fetchSpy = mockFetch(() => new Response(JSON.stringify({ error: "boom" }), { status: 500 }));
    const api = makeApiClient({ baseUrl: "/api", getToken: async () => "t", fetch: fetchSpy });
    await expect(api.getOrders()).rejects.toBeInstanceOf(ApiError);
  });
});

describe("ApiClient W5 — getPayments", () => {
  it("issues a GET to /payments", async () => {
    const fetchSpy = mockFetch(() => new Response(JSON.stringify(PAYMENTS_BODY), { status: 200 }));
    const api = makeApiClient({ baseUrl: "/api", getToken: async () => "t", fetch: fetchSpy });
    await api.getPayments();
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("/api/payments");
    expect(init?.method).toBeUndefined();
  });

  it("sends the App Bridge session token as a bearer", async () => {
    const fetchSpy = mockFetch(() => new Response(JSON.stringify(PAYMENTS_BODY), { status: 200 }));
    const api = makeApiClient({ baseUrl: "/api", getToken: async () => "sess-payments", fetch: fetchSpy });
    await api.getPayments();
    expect(headersOf(fetchSpy.mock.calls[0]![1]).Authorization).toBe("Bearer sess-payments");
  });

  it("returns the typed PaymentsView, with fee.chargeable always false", async () => {
    const fetchSpy = mockFetch(() => new Response(JSON.stringify(PAYMENTS_BODY), { status: 200 }));
    const api = makeApiClient({ baseUrl: "/api", getToken: async () => "t", fetch: fetchSpy });
    const result = await api.getPayments();
    expect(result).toEqual(PAYMENTS_BODY);
    expect(result.fee.chargeable).toBe(false);
  });

  it("propagates a non-2xx as a typed ApiError", async () => {
    const fetchSpy = mockFetch(() => new Response(JSON.stringify({ error: "boom" }), { status: 500 }));
    const api = makeApiClient({ baseUrl: "/api", getToken: async () => "t", fetch: fetchSpy });
    await expect(api.getPayments()).rejects.toBeInstanceOf(ApiError);
  });
});
