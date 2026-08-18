import { describe, it, expect } from "vitest";
import { InMemoryRuntimeStore, createInMemoryQueue } from "@palup/platform-ports";
import { readArmTally } from "@palup/state-postgres";
import { assignHoldoutArm } from "../src/holdout.js";
import { mintOrderJoinToken } from "../src/order-join-token.js";
import {
  ORDER_ARM_COLLECTION,
  ORDER_ATTRIBUTION_TOPIC,
  applyOrderAttribution,
  orderAttributionMessage,
  subscribeOrderAttribution,
  type OrderAttributionPayload,
} from "../src/order-attribution-queue.js";

// W2-C (item 2) — the worker: resolve a token → tally onto the W2-A ledger, off the webhook's own
// request/response cycle. Exercised directly against `applyOrderAttribution` (no HTTP layer — that is
// order-webhook-routes.test.ts's job) and through `subscribeOrderAttribution` for the QueuePort wiring.

const TENANT = "acme";
const IDENTITY = "shopper:1";
const PERIOD = "2026-08";
const PLAY = "agent";

async function mintedToken(store: InMemoryRuntimeStore, fraction: number): Promise<{ token: string; arm: "treated" | "control" }> {
  await store.put({ tenantId: TENANT }, "holdout", "config", { enabled: true, fraction });
  const arm = await assignHoldoutArm(store, TENANT, { enabled: true, fraction }, IDENTITY, PERIOD);
  const token = await mintOrderJoinToken(store, TENANT, IDENTITY, PERIOD);
  if (!token) throw new Error("test setup: expected a token");
  return { token, arm };
}

describe("applyOrderAttribution — orders/create", () => {
  it("a valid token tallies orders:+1, revenue:+=total onto the resolved arm", async () => {
    const store = new InMemoryRuntimeStore();
    const { token, arm } = await mintedToken(store, 0); // fraction 0 ⇒ treated

    const outcome = await applyOrderAttribution(store, "msg-1", {
      tenantId: TENANT,
      topic: "orders/create",
      kind: "order",
      orderId: "1001",
      joinToken: token,
      amount: 409.94,
      currency: "USD",
      at: new Date().toISOString(),
    });
    expect(outcome).toBe("tallied");

    const tally = await readArmTally(store, TENANT, PLAY, PERIOD, arm);
    expect(tally).toMatchObject({ orders: 1, revenue: 409.94 });
  });

  it("HMAC/route concerns aside, a message with NO join token, NO order id, or NO amount is unattributed — no crash, no tally, no PII stored", async () => {
    const store = new InMemoryRuntimeStore();
    const base: OrderAttributionPayload = { tenantId: TENANT, topic: "orders/create", kind: "order", at: new Date().toISOString() };
    expect(await applyOrderAttribution(store, "m-a", { ...base, orderId: "1", amount: 10 })).toBe("unattributed");
    expect(await applyOrderAttribution(store, "m-b", { ...base, joinToken: "tok", amount: 10 })).toBe("unattributed");
    expect(await applyOrderAttribution(store, "m-c", { ...base, joinToken: "tok", orderId: "1" })).toBe("unattributed");
    expect(await store.list({ tenantId: TENANT }, ORDER_ARM_COLLECTION)).toEqual([]);
  });

  it("an UNKNOWN or EXPIRED token is unattributed — never guesses an arm", async () => {
    const store = new InMemoryRuntimeStore();
    const outcome = await applyOrderAttribution(store, "m-2", {
      tenantId: TENANT,
      topic: "orders/create",
      kind: "order",
      orderId: "1002",
      joinToken: "no-such-token",
      amount: 50,
      at: new Date().toISOString(),
    });
    expect(outcome).toBe("unattributed");
    const tally = await readArmTally(store, TENANT, PLAY, PERIOD, "treated");
    expect(tally).toBeNull();
  });

  it("a REDELIVERED message (same id) never double-counts", async () => {
    const store = new InMemoryRuntimeStore();
    const { token, arm } = await mintedToken(store, 0);
    const payload: OrderAttributionPayload = {
      tenantId: TENANT,
      topic: "orders/create",
      kind: "order",
      orderId: "1003",
      joinToken: token,
      amount: 100,
      at: new Date().toISOString(),
    };
    expect(await applyOrderAttribution(store, "dup-msg", payload)).toBe("tallied");
    expect(await applyOrderAttribution(store, "dup-msg", payload)).toBe("duplicate");
    expect(await applyOrderAttribution(store, "dup-msg", payload)).toBe("duplicate");

    const tally = await readArmTally(store, TENANT, PLAY, PERIOD, arm);
    expect(tally).toMatchObject({ orders: 1, revenue: 100 });
  });

  it("orders/create and orders/updated BOTH resolving the same order tally exactly ONCE (interchangeable completions)", async () => {
    const store = new InMemoryRuntimeStore();
    const { token, arm } = await mintedToken(store, 0);
    const base = { tenantId: TENANT, orderId: "1004", joinToken: token, amount: 75, at: new Date().toISOString() };
    expect(await applyOrderAttribution(store, "create-msg", { ...base, topic: "orders/create", kind: "order" })).toBe("tallied");
    // A DIFFERENT message id (a genuinely different delivery: orders/updated firing for the same order)
    // must still be treated as a duplicate of the ORDER's attribution, not a second tally.
    expect(await applyOrderAttribution(store, "updated-msg", { ...base, topic: "orders/updated", kind: "order" })).toBe("duplicate");

    const tally = await readArmTally(store, TENANT, PLAY, PERIOD, arm);
    expect(tally).toMatchObject({ orders: 1, revenue: 75 });
  });
});

describe("applyOrderAttribution — refunds/create", () => {
  it("a refund for an order the order-arm map already resolved is tallied as negative revenue on that SAME arm", async () => {
    const store = new InMemoryRuntimeStore();
    const { token, arm } = await mintedToken(store, 0);
    await applyOrderAttribution(store, "create-msg", {
      tenantId: TENANT,
      topic: "orders/create",
      kind: "order",
      orderId: "2001",
      joinToken: token,
      amount: 200,
      at: new Date().toISOString(),
    });

    const outcome = await applyOrderAttribution(store, "refund-msg", {
      tenantId: TENANT,
      topic: "refunds/create",
      kind: "refund",
      orderId: "2001",
      amount: 50,
      currency: "USD",
      at: new Date().toISOString(),
    });
    expect(outcome).toBe("tallied");

    const tally = await readArmTally(store, TENANT, PLAY, PERIOD, arm);
    expect(tally).toMatchObject({ orders: 1, revenue: 150 }); // 200 - 50
  });

  it("a refund whose order was never resolved (no token, unknown order) is unattributed — no crash, no tally", async () => {
    const store = new InMemoryRuntimeStore();
    const outcome = await applyOrderAttribution(store, "refund-msg-2", {
      tenantId: TENANT,
      topic: "refunds/create",
      kind: "refund",
      orderId: "no-such-order",
      amount: 50,
      at: new Date().toISOString(),
    });
    expect(outcome).toBe("unattributed");
  });

  it("a redelivered refund message never double-refunds", async () => {
    const store = new InMemoryRuntimeStore();
    const { token, arm } = await mintedToken(store, 0);
    await applyOrderAttribution(store, "create-msg", {
      tenantId: TENANT,
      topic: "orders/create",
      kind: "order",
      orderId: "2002",
      joinToken: token,
      amount: 200,
      at: new Date().toISOString(),
    });
    const refundPayload: OrderAttributionPayload = {
      tenantId: TENANT,
      topic: "refunds/create",
      kind: "refund",
      orderId: "2002",
      amount: 30,
      at: new Date().toISOString(),
    };
    expect(await applyOrderAttribution(store, "refund-dup", refundPayload)).toBe("tallied");
    expect(await applyOrderAttribution(store, "refund-dup", refundPayload)).toBe("duplicate");

    const tally = await readArmTally(store, TENANT, PLAY, PERIOD, arm);
    expect(tally).toMatchObject({ orders: 1, revenue: 170 }); // 200 - 30, once
  });
});

describe("orderAttributionMessage — the queue message carries NO PII", () => {
  it("only tenantId/topic/kind/orderId/joinToken/amount/currency/at are present", () => {
    const msg = orderAttributionMessage({
      tenantId: TENANT,
      topic: "orders/create",
      kind: "order",
      webhookId: "wh-1",
      nowMs: 1_700_000_000_000,
      orderId: "1",
      joinToken: "tok",
      amount: 10,
      currency: "USD",
    });
    expect(msg.tenantKey).toBe(TENANT);
    expect(msg.id).toBe("wh-1");
    const payload = msg.payload as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(["amount", "at", "currency", "joinToken", "kind", "orderId", "tenantId", "topic"]);
    expect(JSON.stringify(payload)).not.toMatch(/email|address|phone|customer/i);
  });

  it("falls back to a synthetic id when no webhookId is present", () => {
    const msg = orderAttributionMessage({ tenantId: TENANT, topic: "refunds/create", kind: "refund", webhookId: undefined, nowMs: 1000, orderId: "9" });
    expect(msg.id).toBe(`${TENANT}:refunds/create:9:1000`);
  });
});

describe("subscribeOrderAttribution — the QueuePort wiring", () => {
  it("a published message is tallied by the worker", async () => {
    const store = new InMemoryRuntimeStore();
    const { token, arm } = await mintedToken(store, 1); // fraction 1 ⇒ control
    const queue = createInMemoryQueue({});
    subscribeOrderAttribution(queue, store);

    await queue.publish(
      ORDER_ATTRIBUTION_TOPIC,
      orderAttributionMessage({ tenantId: TENANT, topic: "orders/create", kind: "order", webhookId: "wh-42", nowMs: Date.now(), orderId: "3001", joinToken: token, amount: 60 }),
    );

    const tally = await readArmTally(store, TENANT, PLAY, PERIOD, arm);
    expect(tally).toMatchObject({ orders: 1, revenue: 60 });
  });

  it("a malformed (tenant-less) message is dropped, not thrown", async () => {
    const store = new InMemoryRuntimeStore();
    const queue = createInMemoryQueue({});
    subscribeOrderAttribution(queue, store);
    await expect(
      queue.publish(ORDER_ATTRIBUTION_TOPIC, { id: "bad-1", type: "x", tenantKey: "__scratch__", payload: { topic: "orders/create" } }),
    ).resolves.toBeUndefined();
    expect(queue.deadLettered()).toEqual([]);
  });
});
