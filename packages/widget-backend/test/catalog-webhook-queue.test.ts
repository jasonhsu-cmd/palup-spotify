import { describe, it, expect } from "vitest";
import { createInMemoryQueue } from "@palup/platform-ports";
import { CATALOG_RECONCILE_TOPIC, catalogReconcileMessage, subscribeCatalogReconcile } from "../src/catalog-webhook-queue.js";

// A3 (D4) — the webhook→reconcile seam. The message carries ONLY the tenantId (never product data), and
// the worker dispatches on nothing but that.

describe("catalogReconcileMessage", () => {
  it("uses Shopify's delivery id (so a retried delivery dedups within the group) and carries only the tenant", () => {
    const m = catalogReconcileMessage("acme", "products/update", "wh-123", 1_700_000_000_000);
    expect(m).toEqual({
      id: "wh-123",
      type: "catalog.products/update",
      tenantKey: "acme",
      payload: { tenantId: "acme", topic: "products/update", at: new Date(1_700_000_000_000).toISOString() },
    });
    // no product data crosses the port
    expect(JSON.stringify(m)).not.toMatch(/price|title|variant|inventory_item/i);
  });

  it("falls back to a synthetic id when Shopify sent none (reconcile is idempotent regardless)", () => {
    const m = catalogReconcileMessage("acme", "inventory_levels/update", undefined, 42);
    expect(m.id).toBe("acme:inventory_levels/update:42");
    expect(m.tenantKey).toBe("acme");
  });
});

describe("subscribeCatalogReconcile", () => {
  it("calls reconcile with the tenant from a published message", async () => {
    const q = createInMemoryQueue({});
    const seen: string[] = [];
    subscribeCatalogReconcile(q, async (t) => { seen.push(t); });
    await q.publish(CATALOG_RECONCILE_TOPIC, catalogReconcileMessage("acme", "products/update", "w1", 1));
    expect(seen).toEqual(["acme"]);
  });

  it("skips a message whose payload carries no usable tenantId (never reconciles a blank scope)", async () => {
    const q = createInMemoryQueue({});
    const seen: string[] = [];
    subscribeCatalogReconcile(q, async (t) => { seen.push(t); });
    await q.publish(CATALOG_RECONCILE_TOPIC, { id: "x", type: "catalog.products/update", tenantKey: "acme", payload: { tenantId: "  " } });
    await q.publish(CATALOG_RECONCILE_TOPIC, { id: "y", type: "catalog.products/update", tenantKey: "acme", payload: {} });
    expect(seen).toEqual([]);
  });

  it("dedups a retried delivery within the group (same id delivered once)", async () => {
    const q = createInMemoryQueue({});
    let calls = 0;
    subscribeCatalogReconcile(q, async () => { calls++; });
    const msg = catalogReconcileMessage("acme", "products/update", "dup-1", 1);
    await q.publish(CATALOG_RECONCILE_TOPIC, msg);
    await q.publish(CATALOG_RECONCILE_TOPIC, msg);
    expect(calls).toBe(1);
  });
});
