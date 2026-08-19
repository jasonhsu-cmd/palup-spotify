import { describe, it, expect, vi } from "vitest";
import { InMemoryRuntimeStore } from "@palup/platform-ports";
import { createBrandNameResolver } from "../src/brand-cache.js";

// Pillar 5 (auto-brand) — the merchant brand NAME must be resolved from the merchant's own store and cached,
// never a hardcoded per-tenant literal and never a per-request Shopify fetch. These pin the durable
// contract: one bounded fetch per tenant per TTL, fail-closed to `undefined` (→ neutral default), and the
// "this store" fail-closed sentinel is never served or cached as a real brand.

const T = "palup-skincare-jason";

describe("Pillar 5 — createBrandNameResolver (cached, write-through, fail-closed)", () => {
  it("fetches on a cold miss, returns the real name, and caches it (no second fetch)", async () => {
    const store = new InMemoryRuntimeStore();
    const fetchShopName = vi.fn(async () => "Auria");
    const resolve = createBrandNameResolver({ store, fetchShopName });

    expect(await resolve(T)).toBe("Auria");
    expect(fetchShopName).toHaveBeenCalledTimes(1);

    // second call is a fresh cache hit — no second Shopify fetch (COGS scales with merchants, not traffic)
    expect(await resolve(T)).toBe("Auria");
    expect(fetchShopName).toHaveBeenCalledTimes(1);
  });

  it("refetches once the cached row is older than the TTL", async () => {
    const store = new InMemoryRuntimeStore();
    let clock = 1_000_000;
    const fetchShopName = vi.fn(async () => "Auria");
    const resolve = createBrandNameResolver({ store, fetchShopName, now: () => clock, ttlSeconds: 100 });

    expect(await resolve(T)).toBe("Auria");
    clock += 99_000; // still fresh
    expect(await resolve(T)).toBe("Auria");
    expect(fetchShopName).toHaveBeenCalledTimes(1);
    clock += 2_000; // now past the 100s TTL
    expect(await resolve(T)).toBe("Auria");
    expect(fetchShopName).toHaveBeenCalledTimes(2);
  });

  it("treats the 'this store' fail-closed sentinel (and blanks) as absent — never serves/caches it", async () => {
    const store = new InMemoryRuntimeStore();
    const fetchShopName = vi.fn(async () => "this store");
    const resolve = createBrandNameResolver({ store, fetchShopName });

    expect(await resolve(T)).toBeUndefined();
    // the sentinel must not have been cached as a brand — a later real name is picked up
    fetchShopName.mockResolvedValueOnce("Auria");
    expect(await resolve(T)).toBe("Auria");

    const blank = createBrandNameResolver({ store: new InMemoryRuntimeStore(), fetchShopName: async () => "   " });
    expect(await blank(T)).toBeUndefined();
  });

  it("never throws when the fetch fails — returns undefined (or the stale name if one is cached)", async () => {
    const store = new InMemoryRuntimeStore();
    let clock = 1_000_000;
    const fetchShopName = vi
      .fn<[], Promise<string | undefined>>()
      .mockResolvedValueOnce("Auria")
      .mockRejectedValue(new Error("shopify down"));
    const resolve = createBrandNameResolver({ store, fetchShopName, now: () => clock, ttlSeconds: 100 });

    expect(await resolve(T)).toBe("Auria"); // warms the cache
    clock += 200_000; // force a refetch, which now fails
    await expect(resolve(T)).resolves.toBe("Auria"); // stale-while-error, never throws

    // cold tenant whose very first fetch fails → undefined, still no throw
    const cold = createBrandNameResolver({ store: new InMemoryRuntimeStore(), fetchShopName: async () => { throw new Error("down"); } });
    await expect(cold("other-tenant")).resolves.toBeUndefined();
  });

  it("returns undefined for a blank tenant without fetching", async () => {
    const fetchShopName = vi.fn(async () => "Auria");
    const resolve = createBrandNameResolver({ store: new InMemoryRuntimeStore(), fetchShopName });
    expect(await resolve("")).toBeUndefined();
    expect(fetchShopName).not.toHaveBeenCalled();
  });
});
