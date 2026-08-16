import { describe, it, expect, vi } from "vitest";
import { createReconcileCoalescer, CATALOG_RECONCILE_MAX_IDS } from "../src/catalog-reconcile-coalescer.js";

describe("S3 §C — per-tenant coalesce/debounce", () => {
  it("collapses a burst of product ids into ONE batched reconcile with a deduped id set", async () => {
    const reconcile = vi.fn(async () => {});
    const c = createReconcileCoalescer(reconcile, { windowMs: 50 });
    for (let i = 0; i < 50; i++) c.enqueue("acme", { productIds: [`gid://shopify/Product/${i % 10}`], reason: "product" });
    await c.flush("acme");
    expect(reconcile).toHaveBeenCalledTimes(1);
    const [tenant, opts] = reconcile.mock.calls[0]!;
    expect(tenant).toBe("acme");
    expect(new Set(opts.productIds).size).toBe(10); // deduped
    expect(opts.reason).toBe("product");
  });

  it("spills to a FULL reconcile above the id cap", async () => {
    const reconcile = vi.fn(async () => {});
    const c = createReconcileCoalescer(reconcile, { windowMs: 50 });
    for (let i = 0; i <= CATALOG_RECONCILE_MAX_IDS; i++) c.enqueue("acme", { productIds: [`gid://shopify/Product/${i}`], reason: "product" });
    await c.flush("acme");
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(reconcile.mock.calls[0]![1]).toMatchObject({ reason: "full" });
    expect(reconcile.mock.calls[0]![1].productIds).toBeUndefined();
  });

  it("an inventory-only batch triggers NO reconcile (covered by the serve-time ceiling + hourly backstop)", async () => {
    const reconcile = vi.fn(async () => {});
    const c = createReconcileCoalescer(reconcile, { windowMs: 50 });
    c.enqueue("acme", { reason: "inventory" });
    c.enqueue("acme", { reason: "inventory" });
    await c.flush("acme");
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("keeps tenants isolated (separate batches)", async () => {
    const reconcile = vi.fn(async () => {});
    const c = createReconcileCoalescer(reconcile, { windowMs: 50 });
    c.enqueue("a", { productIds: ["gid://shopify/Product/1"], reason: "product" });
    c.enqueue("b", { productIds: ["gid://shopify/Product/2"], reason: "product" });
    await c.flush();
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(new Set(reconcile.mock.calls.map((c2) => c2[0]))).toEqual(new Set(["a", "b"]));
  });

  it("a 'full' reason arriving mid-window latches full — ids in the same window are ignored", async () => {
    const reconcile = vi.fn(async () => {});
    const c = createReconcileCoalescer(reconcile, { windowMs: 50 });
    c.enqueue("acme", { productIds: ["gid://shopify/Product/1"], reason: "product" });
    c.enqueue("acme", { reason: "full" });
    c.enqueue("acme", { productIds: ["gid://shopify/Product/2"], reason: "product" });
    await c.flush("acme");
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(reconcile.mock.calls[0]![1]).toMatchObject({ reason: "full" });
    expect(reconcile.mock.calls[0]![1].productIds).toBeUndefined();
  });

  it("the window auto-flushes via the timer (fake timers, no real setTimeout wait) and resets for a later burst", async () => {
    vi.useFakeTimers();
    try {
      const reconcile = vi.fn(async () => {});
      const c = createReconcileCoalescer(reconcile, { windowMs: 50 });
      c.enqueue("acme", { productIds: ["gid://shopify/Product/1"], reason: "product" });
      c.enqueue("acme", { productIds: ["gid://shopify/Product/2"], reason: "product" });
      await vi.advanceTimersByTimeAsync(60);
      expect(reconcile).toHaveBeenCalledTimes(1);
      expect(new Set(reconcile.mock.calls[0]![1].productIds)).toEqual(
        new Set(["gid://shopify/Product/1", "gid://shopify/Product/2"]),
      );

      // Second burst AFTER the first window flushed must produce a SECOND, independent reconcile.
      c.enqueue("acme", { productIds: ["gid://shopify/Product/3"], reason: "product" });
      await vi.advanceTimersByTimeAsync(60);
      expect(reconcile).toHaveBeenCalledTimes(2);
      expect(reconcile.mock.calls[1]![1].productIds).toEqual(["gid://shopify/Product/3"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("unrefs its per-window timer (final review #5) so a pending window can never hold the process open", () => {
    const reconcile = vi.fn(async () => {});
    const c = createReconcileCoalescer(reconcile, { windowMs: 50 });
    let capturedTimer: NodeJS.Timeout | undefined;
    const realSetTimeout = global.setTimeout;
    const spy = vi.spyOn(global, "setTimeout").mockImplementation(((cb: () => void, ms?: number) => {
      capturedTimer = realSetTimeout(cb, ms);
      return capturedTimer;
    }) as typeof global.setTimeout);
    try {
      c.enqueue("acme", { productIds: ["gid://shopify/Product/1"], reason: "product" });
    } finally {
      spy.mockRestore();
    }
    expect(capturedTimer).toBeDefined();
    // A real Node Timeout: `hasRef()` reports false only once `.unref()` has actually been called on it.
    expect(capturedTimer!.hasRef()).toBe(false);
    clearTimeout(capturedTimer);
  });

  it("isolates a reconcile failure for one tenant from another tenant's pending flush", async () => {
    const reconcile = vi.fn(async (tenantId: string) => {
      if (tenantId === "bad") throw new Error("boom");
    });
    const c = createReconcileCoalescer(reconcile, { windowMs: 50 });
    c.enqueue("bad", { productIds: ["gid://shopify/Product/1"], reason: "product" });
    c.enqueue("good", { productIds: ["gid://shopify/Product/2"], reason: "product" });
    // flush() with no args flushes all tenants; a throw for "bad" must not prevent "good" from reconciling,
    // and must not surface as an unhandled rejection.
    await expect(c.flush()).resolves.not.toThrow();
    expect(reconcile).toHaveBeenCalledTimes(2);
    const goodCall = reconcile.mock.calls.find((call) => call[0] === "good");
    expect(goodCall?.[1].productIds).toEqual(["gid://shopify/Product/2"]);
  });
});
