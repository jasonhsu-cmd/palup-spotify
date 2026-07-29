import { describe, it, expect } from "vitest";
import { createCachingGroundingPort } from "../src/grounding-cache.js";
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
