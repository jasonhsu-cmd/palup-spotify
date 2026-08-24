import { describe, expect, it } from "vitest";
import { InMemoryRuntimeStore } from "@palup/platform-ports";
import { SandboxOrderDirectory, type MerchantOrderSummary } from "@palup/platform-ports";
import { buildServer } from "../src/server.js";
import { makeTestIdentity, bearer } from "./helpers/test-identity.js";

// W5 Task 3: GET /orders — read-through of the tenant's Shopify orders (Task 1's optional
// CommercePort.listOrders / SandboxOrderDirectory), annotated with Task 2's per-order agent
// touchpoints, plus a Shopify admin deep-link. Proves: live read-through + touchpoint annotation,
// honest "unavailable" (never a fabricated row) when the adapter doesn't implement listOrders,
// tenant scoping, RBAC/401, and — the money-boundary invariant — NO incremental $/attributed
// revenue anywhere on the response (touchpoints are factual per-order only).

const order = (id: string): MerchantOrderSummary => ({
  id,
  orderNumber: `#${id}`,
  placedAt: "2026-08-20T00:00:00Z",
  totalUsd: 42,
  currency: "USD",
  financialStatus: "paid",
  fulfillmentStatus: "unfulfilled",
  customerLabel: "Guest",
});

describe("GET /orders", () => {
  it("returns the tenant's orders annotated with (empty) touchpoints + a Shopify admin deep-link", async () => {
    const store = new InMemoryRuntimeStore();
    const orderCommerce = new SandboxOrderDirectory({ "shop-1": [order("1001")] });
    const app = await buildServer({ store, identity: makeTestIdentity("shop-1"), orderCommerce });
    const res = await app.inject({ method: "GET", url: "/orders", headers: bearer() });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.source).toBe("live");
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ id: "1001", adminPath: "admin/orders/1001", touchpoints: [] });
    await app.close();
  });

  it("annotates an order with its real agent touchpoints, and never with an incremental-$ field", async () => {
    const store = new InMemoryRuntimeStore();
    const ctx = { tenantId: "shop-1" };
    await store.audit(ctx, { actor: "win_back_agent", action: "agent.action.auto", input: { action: { params: { orderId: "1001" } } } }, "2026-08-20T01:00:00.000Z");
    // Excluded from touchpoints: a merely-created proposal is not a factual thing the agent did yet.
    await store.audit(ctx, { actor: "win_back_agent", action: "proposal.created", input: { action: { params: { orderId: "1001" } } } }, "2026-08-20T02:00:00.000Z");
    const orderCommerce = new SandboxOrderDirectory({ "shop-1": [order("1001")] });
    const app = await buildServer({ store, identity: makeTestIdentity("shop-1"), orderCommerce });
    const res = await app.inject({ method: "GET", url: "/orders", headers: bearer() });
    const body = res.json();
    expect(body.items[0].touchpoints).toEqual([
      { orderRef: "1001", seq: 1, at: "2026-08-20T01:00:00.000Z", actor: "win_back_agent", action: "agent.action.auto" },
    ]);
    // Money-boundary invariant (W5 spec): no incremental $ / attributed revenue on this surface.
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("incremental");
    expect(raw).not.toContain("attributed");
    await app.close();
  });

  it("reports source=unavailable (never a fake row) when the adapter cannot list orders", async () => {
    const store = new InMemoryRuntimeStore();
    const app = await buildServer({ store, identity: makeTestIdentity("shop-1"), orderCommerce: {} as never });
    const res = await app.inject({ method: "GET", url: "/orders", headers: bearer() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ source: "unavailable", items: [] });
    await app.close();
  });

  it("tenant scoping: another tenant's orders never appear", async () => {
    const store = new InMemoryRuntimeStore();
    const orderCommerce = new SandboxOrderDirectory({ "other-shop": [order("9999")] });
    const app = await buildServer({ store, identity: makeTestIdentity("shop-1"), orderCommerce });
    const res = await app.inject({ method: "GET", url: "/orders", headers: bearer() });
    expect(res.json().items).toEqual([]);
    await app.close();
  });

  it("401s without a token", async () => {
    const app = await buildServer({ store: new InMemoryRuntimeStore(), identity: makeTestIdentity("shop-1") });
    expect((await app.inject({ method: "GET", url: "/orders" })).statusCode).toBe(401);
    await app.close();
  });
});
