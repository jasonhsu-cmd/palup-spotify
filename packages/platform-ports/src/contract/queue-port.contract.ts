import { describe, it, expect } from "vitest";
import type { QueuePort, QueueMessage } from "../queue-port.js";

// Port contract (ADR-0001; ADR-0006; ADR-0020 D4): every QueuePort adapter (in-memory, Cloud Tasks,
// Pub/Sub, …) MUST pass this, so adapters stay behavior-equivalent and the backbone stays swappable.
// `makeAdapter` returns a FRESH, empty adapter each call. Adapters are constructed with maxAttempts=3 so
// the dead-letter assertion is deterministic.
export function runQueuePortContract(makeAdapter: () => QueuePort | Promise<QueuePort>): void {
  describe("QueuePort contract", () => {
    const m = (id: string, extra: Partial<QueueMessage> = {}): QueueMessage => ({
      id,
      type: "shopify.products/update",
      tenantKey: "tenant-a",
      payload: { p: id },
      ...extra,
    });

    it("delivers a published message to a subscribed group's handler", async () => {
      const q = await makeAdapter();
      const seen: QueueMessage[] = [];
      q.subscribe("catalog", "indexer", async (msg) => {
        seen.push(msg);
      });
      await q.publish("catalog", m("e1"));
      expect(seen).toEqual([m("e1")]);
    });

    it("fans out to EACH consumer group once", async () => {
      const q = await makeAdapter();
      const a: string[] = [];
      const b: string[] = [];
      q.subscribe("catalog", "indexer", async (msg) => void a.push(msg.id));
      q.subscribe("catalog", "audit", async (msg) => void b.push(msg.id));
      await q.publish("catalog", m("e1"));
      expect(a).toEqual(["e1"]);
      expect(b).toEqual(["e1"]);
    });

    it("is idempotent within a group — re-publishing the same id delivers once", async () => {
      const q = await makeAdapter();
      const seen: string[] = [];
      q.subscribe("catalog", "indexer", async (msg) => void seen.push(msg.id));
      await q.publish("catalog", m("e1"));
      await q.publish("catalog", m("e1")); // duplicate delivery (Shopify at-least-once)
      expect(seen).toEqual(["e1"]);
    });

    it("isolates topics — a group only receives its topic's messages", async () => {
      const q = await makeAdapter();
      const seen: string[] = [];
      q.subscribe("catalog", "indexer", async (msg) => void seen.push(msg.id));
      await q.publish("inventory", m("e1")); // different topic, no subscriber
      expect(seen).toEqual([]);
    });

    it("preserves per-tenant-key publish order", async () => {
      const q = await makeAdapter();
      const seen: string[] = [];
      q.subscribe("catalog", "indexer", async (msg) => void seen.push(msg.id));
      await q.publish("catalog", m("e1"));
      await q.publish("catalog", m("e2"));
      await q.publish("catalog", m("e3"));
      expect(seen).toEqual(["e1", "e2", "e3"]);
    });

    it("retries a transiently-failing handler, then succeeds (not dead-lettered)", async () => {
      const q = await makeAdapter();
      let calls = 0;
      q.subscribe("catalog", "indexer", async () => {
        calls++;
        if (calls < 2) throw new Error("transient");
      });
      await q.publish("catalog", m("e1"));
      expect(calls).toBe(2);
      expect(q.deadLettered()).toEqual([]);
    });

    it("dead-letters a permanently-failing handler instead of retrying forever", async () => {
      const q = await makeAdapter();
      let calls = 0;
      q.subscribe("catalog", "indexer", async () => {
        calls++;
        throw new Error("poison");
      });
      await q.publish("catalog", m("e1"));
      expect(calls).toBeGreaterThan(1); // retried
      const dlq = q.deadLettered();
      expect(dlq).toHaveLength(1);
      expect(dlq[0]!.msg.id).toBe("e1");
      expect(dlq[0]!.group).toBe("indexer");
    });

    it("stops delivering after unsubscribe", async () => {
      const q = await makeAdapter();
      const seen: string[] = [];
      const sub = q.subscribe("catalog", "indexer", async (msg) => void seen.push(msg.id));
      await q.publish("catalog", m("e1"));
      sub.unsubscribe();
      await q.publish("catalog", m("e2"));
      expect(seen).toEqual(["e1"]);
    });

    it("does not replay messages published BEFORE a group subscribed", async () => {
      const q = await makeAdapter();
      await q.publish("catalog", m("e1")); // no subscribers yet
      const seen: string[] = [];
      q.subscribe("catalog", "indexer", async (msg) => void seen.push(msg.id));
      await q.publish("catalog", m("e2"));
      expect(seen).toEqual(["e2"]);
    });

    it("rejects a blank topic / tenantKey / id (fail-closed)", async () => {
      const q = await makeAdapter();
      await expect(q.publish("", m("e1"))).rejects.toThrow(/topic/i);
      await expect(q.publish("catalog", m("e1", { tenantKey: "" }))).rejects.toThrow(/tenant/i);
      await expect(q.publish("catalog", m("", { id: "" }))).rejects.toThrow(/id/i);
    });
  });
}
