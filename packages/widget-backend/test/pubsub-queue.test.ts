import { describe, it, expect } from "vitest";
import { createPubSubQueue, type PubSubClientLike } from "../src/pubsub-queue.js";

// P4 — the Pub/Sub publish adapter's message-building + guards, against an injected fake client (no real
// Pub/Sub; the live path is staging-verified — UNVERIFIED-LIVE).
function fakeClient() {
  const published: { topic: string; data: Buffer; attributes?: Record<string, string>; orderingKey?: string }[] = [];
  const client: PubSubClientLike = {
    topic(name) {
      return {
        async publishMessage(args) {
          published.push({ topic: name, ...args });
          return "mid-1";
        },
      };
    },
  };
  return { client, published };
}

describe("P4 — PubSubQueue publish adapter", () => {
  it("publishes the payload as JSON with id/type/tenantKey attributes + tenantKey ordering key", async () => {
    const { client, published } = fakeClient();
    const q = createPubSubQueue({ client, topicName: (t) => `pl-${t}` });
    await q.publish("catalog.reconcile", { id: "w1", type: "catalog.products/update", tenantKey: "acme", payload: { tenantId: "acme", topic: "products/update" } });
    expect(published).toHaveLength(1);
    expect(published[0]!.topic).toBe("pl-catalog.reconcile");
    expect(published[0]!.attributes).toEqual({ id: "w1", type: "catalog.products/update", tenantKey: "acme" });
    expect(published[0]!.orderingKey).toBe("acme"); // per-tenant order preserved
    expect(JSON.parse(published[0]!.data.toString("utf8"))).toEqual({ tenantId: "acme", topic: "products/update" });
  });

  it("rejects a blank topic / tenantKey / id (scope + idempotency)", async () => {
    const { client } = fakeClient();
    const q = createPubSubQueue({ client, topicName: (t) => t });
    await expect(q.publish("", { id: "w", type: "t", tenantKey: "a", payload: {} })).rejects.toThrow(/topic/i);
    await expect(q.publish("x", { id: "w", type: "t", tenantKey: " ", payload: {} })).rejects.toThrow(/tenantKey/i);
    await expect(q.publish("x", { id: " ", type: "t", tenantKey: "a", payload: {} })).rejects.toThrow(/id/i);
  });

  it("subscribe() THROWS (push-mode) — never a silent no-op that drops work", () => {
    const { client } = fakeClient();
    expect(() => createPubSubQueue({ client, topicName: (t) => t }).subscribe("t", "g", async () => {})).toThrow(/push-mode/i);
  });

  it("deadLettered() is [] — Pub/Sub dead-letters server-side", () => {
    const { client } = fakeClient();
    expect(createPubSubQueue({ client, topicName: (t) => t }).deadLettered()).toEqual([]);
  });
});
