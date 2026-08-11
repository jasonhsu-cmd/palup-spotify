import { describe, it, expect } from "vitest";
import { createCachingGroundingPort, invalidateGroundingCache } from "../src/grounding-cache.js";
import { InMemoryRuntimeStore } from "../src/in-memory-runtime-store.js";
import type { GroundingContext, GroundingPort } from "../src/grounding-port.js";

function ctxFor(tenantId: string, n = 1): GroundingContext {
  return { tenantId, brandName: `Brand-${tenantId}`, products: Array.from({ length: n }, (_, i) => ({ id: `p${i}`, title: `P${i}`, price: "$1", description: "d" })), policy: { returns: "r", shipping: "s" } };
}

// A controllable inner adapter: counts calls, can be made to fail or hang.
function fakeInner() {
  const state = { calls: 0, mode: "ok" as "ok" | "throw" | "hang", ctx: (t: string) => ctxFor(t) };
  const port: GroundingPort = {
    async getContext(tenantId) {
      state.calls++;
      if (state.mode === "throw") throw new Error("shopify down");
      if (state.mode === "hang") return new Promise<GroundingContext>(() => {}); // never resolves
      return state.ctx(tenantId);
    },
  };
  return { state, port };
}

describe("createCachingGroundingPort", () => {
  it("serves a fresh cache hit without refetching within the TTL", async () => {
    const { state, port } = fakeInner();
    let t = 1000;
    const cached = createCachingGroundingPort(port, new InMemoryRuntimeStore(), { ttlSeconds: 60, now: () => t });
    const a = await cached.getContext("demo");
    const b = await cached.getContext("demo");
    expect(a.brandName).toBe("Brand-demo");
    expect(b).toEqual(a);
    expect(state.calls).toBe(1); // second call was a cache hit
  });

  it("refetches once the TTL has elapsed", async () => {
    const { state, port } = fakeInner();
    let t = 0;
    const cached = createCachingGroundingPort(port, new InMemoryRuntimeStore(), { ttlSeconds: 60, now: () => t });
    await cached.getContext("demo");
    t += 61_000; // past TTL
    await cached.getContext("demo");
    expect(state.calls).toBe(2);
  });

  it("serves STALE-WHILE-ERROR: on upstream failure with a warm cache, returns the last-known-good", async () => {
    const { state, port } = fakeInner();
    let t = 0;
    const cached = createCachingGroundingPort(port, new InMemoryRuntimeStore(), { ttlSeconds: 60, now: () => t });
    const good = await cached.getContext("demo"); // populate
    state.mode = "throw";
    t += 61_000; // stale → will refetch → fails
    const out = await cached.getContext("demo");
    expect(out).toEqual(good); // stale, not safe-empty
  });

  it("fails CLOSED to a safe-empty context on a cold upstream failure (no cache)", async () => {
    const { state, port } = fakeInner();
    state.mode = "throw";
    const cached = createCachingGroundingPort(port, new InMemoryRuntimeStore(), { ttlSeconds: 60 });
    const out = await cached.getContext("demo");
    expect(out.products).toEqual([]);
    expect(out.tenantId).toBe("demo");
  });

  it("degrades (does not hang) when the upstream exceeds the timeout", async () => {
    const { state, port } = fakeInner();
    state.mode = "hang";
    const cached = createCachingGroundingPort(port, new InMemoryRuntimeStore(), { ttlSeconds: 60, timeoutMs: 20 });
    const out = await cached.getContext("demo"); // cold + hang → safe-empty via timeout
    expect(out.products).toEqual([]);
  });

  it("does not hang when the STORE hangs — read/write are timeout-bounded (F1)", async () => {
    const { port } = fakeInner();
    // A store whose get/put never resolve. The wrapper must still answer (fetch inner, return it).
    const hungStore = { get: () => new Promise(() => {}), put: () => new Promise(() => {}) } as unknown as InMemoryRuntimeStore;
    const cached = createCachingGroundingPort(port, hungStore, { ttlSeconds: 60, timeoutMs: 20 });
    const out = await cached.getContext("demo"); // hung get → miss → fetch inner; hung put → fire-and-forget
    expect(out.brandName).toBe("Brand-demo");
  });

  it("fails closed (never launders) when the upstream returns a MISMATCHED tenant (F2)", async () => {
    const inner: GroundingPort = { async getContext() { return ctxFor("attacker-tenant", 3); } }; // wrong tenant!
    const cached = createCachingGroundingPort(inner, new InMemoryRuntimeStore(), { ttlSeconds: 60 });
    const out = await cached.getContext("victim");
    expect(out.tenantId).toBe("victim");
    expect(out.products).toEqual([]); // safe-empty, NOT the attacker-tenant catalog
  });

  it("treats a corrupt cached row as a miss (F5)", async () => {
    const { state, port } = fakeInner();
    const store = new InMemoryRuntimeStore();
    // Poison the cache row with a malformed shape.
    await store.put({ tenantId: "demo" }, "grounding", "context", { garbage: true } as never);
    const cached = createCachingGroundingPort(port, store, { ttlSeconds: 60 });
    const out = await cached.getContext("demo");
    expect(out.brandName).toBe("Brand-demo"); // fetched fresh, not the corrupt row
    expect(state.calls).toBe(1);
  });

  it("is tenant-isolated — one tenant's cached catalog is never served to another", async () => {
    const { state, port } = fakeInner();
    let t = 0;
    const store = new InMemoryRuntimeStore();
    const cached = createCachingGroundingPort(port, store, { ttlSeconds: 60, now: () => t });
    const a = await cached.getContext("acme");
    const b = await cached.getContext("northwind");
    expect(a.brandName).toBe("Brand-acme");
    expect(b.brandName).toBe("Brand-northwind");
    expect(state.calls).toBe(2); // separate tenants → separate fetches, separate cache rows
    // re-read acme → its own cache, not northwind's
    expect((await cached.getContext("acme")).brandName).toBe("Brand-acme");
    expect(state.calls).toBe(2);
  });
});

describe("invalidateGroundingCache — go-live hygiene", () => {
  it("evicts a tenant's cached context so the next getContext is a fresh miss", async () => {
    const { state, port } = fakeInner();
    const store = new InMemoryRuntimeStore();
    const cached = createCachingGroundingPort(port, store, { ttlSeconds: 60 });

    await cached.getContext("t"); // populates + caches
    await cached.getContext("t"); // fresh hit — inner NOT re-invoked
    expect(state.calls).toBe(1);

    await invalidateGroundingCache(store, "t");

    await cached.getContext("t"); // cache miss after invalidation — inner IS re-invoked
    expect(state.calls).toBe(2);
  });

  it("invalidating one tenant never evicts another tenant's cache", async () => {
    const { state, port } = fakeInner();
    const store = new InMemoryRuntimeStore();
    const cached = createCachingGroundingPort(port, store, { ttlSeconds: 60 });

    await cached.getContext("t"); // populates "t"
    await cached.getContext("other"); // populates "other"
    expect(state.calls).toBe(2);

    await invalidateGroundingCache(store, "t");

    await cached.getContext("other"); // still a fresh hit — "t"'s invalidation did not touch it
    expect(state.calls).toBe(2);

    await cached.getContext("t"); // "t" was evicted — a fresh fetch
    expect(state.calls).toBe(3);
  });

  it("rejects a blank tenantId rather than deleting under a meaningless key", async () => {
    const store = new InMemoryRuntimeStore();
    await expect(invalidateGroundingCache(store, "")).rejects.toThrow(/tenantId/);
  });
});
