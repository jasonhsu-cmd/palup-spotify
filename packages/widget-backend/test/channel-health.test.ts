import { describe, it, expect } from "vitest";
import { InMemoryRuntimeStore } from "@palup/platform-ports";
import { createChannelHealth } from "../src/channel-health.js";

// Pillar 1 (price truth) — the per-tenant freshness-CHANNEL health signal. A merchant's price is "confirmed"
// only while the pipe that keeps its money-facts fresh is provably alive. `recordProducerOk` stamps a
// successful producer run (webhook reconcile or poll); `isHealthy` answers whether one happened recently
// enough. Fail-CLOSED by construction: no signal / any error / a stale stamp ⇒ NOT healthy (so serving
// hedges rather than quote a price backed by a channel that may be dead — money/NN#1).

const T = "palup-skincare-jason";

describe("Pillar 1 — createChannelHealth (per-tenant freshness-channel liveness, fail-closed)", () => {
  it("is NOT healthy before any producer run (fail-closed default — no evidence the channel is alive)", async () => {
    const health = createChannelHealth({ store: new InMemoryRuntimeStore() });
    expect(await health.isHealthy(T)).toBe(false);
  });

  it("becomes healthy after a producer run, and stays healthy inside the freshness window", async () => {
    let clock = 1_000_000_000;
    const health = createChannelHealth({ store: new InMemoryRuntimeStore(), now: () => clock, freshSeconds: 7200 });
    await health.recordProducerOk(T);
    expect(await health.isHealthy(T)).toBe(true);
    clock += 7199 * 1000; // still inside the 2h window
    expect(await health.isHealthy(T)).toBe(true);
  });

  it("goes UNhealthy once the last producer run is older than the freshness window (silent-death detection)", async () => {
    let clock = 1_000_000_000;
    const health = createChannelHealth({ store: new InMemoryRuntimeStore(), now: () => clock, freshSeconds: 7200 });
    await health.recordProducerOk(T);
    clock += 7201 * 1000; // just past 2h with no further producer run → the channel looks dead
    expect(await health.isHealthy(T)).toBe(false);
  });

  it("is tenant-isolated — a producer run for one tenant does not make another healthy", async () => {
    const health = createChannelHealth({ store: new InMemoryRuntimeStore() });
    await health.recordProducerOk(T);
    expect(await health.isHealthy(T)).toBe(true);
    expect(await health.isHealthy("other-tenant")).toBe(false);
  });

  it("never throws: a failing store read yields NOT healthy; a failing write is swallowed", async () => {
    const brokenRead = {
      get: async () => { throw new Error("store down"); },
      put: async () => { throw new Error("store down"); },
    } as unknown as Parameters<typeof createChannelHealth>[0]["store"];
    const health = createChannelHealth({ store: brokenRead });
    await expect(health.isHealthy(T)).resolves.toBe(false); // fail-closed, no throw
    await expect(health.recordProducerOk(T)).resolves.toBeUndefined(); // swallowed, never breaks the producer
  });

  it("a blank tenant is never healthy and recording is a no-op", async () => {
    const health = createChannelHealth({ store: new InMemoryRuntimeStore() });
    await expect(health.recordProducerOk("")).resolves.toBeUndefined();
    expect(await health.isHealthy("")).toBe(false);
  });
});
