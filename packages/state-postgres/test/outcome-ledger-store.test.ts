import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryRuntimeStore, computeIncrementalLift, type OutcomeLedgerEntry } from "@palup/platform-ports";
import {
  accumulateArmTally,
  appendOutcomeLedgerEntry,
  listArmTallies,
  readArmAggPair,
  readArmTally,
  readArmTallyShards,
  readOutcomeLedger,
} from "../src/outcome-ledger-store.js";

// Wave 2 / W2-A — durable-store round-trip tests for `ArmTally` accumulation and `OutcomeLedgerEntry`
// append/read, over `InMemoryRuntimeStore` (the behavioral oracle the Postgres adapter must match).

describe("accumulateArmTally + readArmTally (round-trip)", () => {
  it("accumulates deltas rather than overwriting", async () => {
    const store = new InMemoryRuntimeStore();
    await accumulateArmTally(store, { tenantId: "acme", play: "cart_recovery", period: "2026-08", arm: "treated", exposures: 100, orders: 5, revenue: 500 });
    await accumulateArmTally(store, { tenantId: "acme", play: "cart_recovery", period: "2026-08", arm: "treated", exposures: 50, orders: 3, revenue: 300 });
    const t = await readArmTally(store, "acme", "cart_recovery", "2026-08", "treated");
    expect(t).toEqual({
      tenantId: "acme",
      play: "cart_recovery",
      period: "2026-08",
      arm: "treated",
      exposures: 150,
      orders: 8,
      revenue: 800,
    });
  });

  it("missing tally reads as null", async () => {
    const store = new InMemoryRuntimeStore();
    expect(await readArmTally(store, "acme", "cart_recovery", "2026-08", "control")).toBeNull();
  });

  it("blast radius: tallies are isolated per tenant, and per (play, period, arm) key", async () => {
    const store = new InMemoryRuntimeStore();
    await accumulateArmTally(store, { tenantId: "tenant-a", play: "cart_recovery", period: "2026-08", arm: "treated", exposures: 10, orders: 1, revenue: 10 });
    expect(await readArmTally(store, "tenant-b", "cart_recovery", "2026-08", "treated")).toBeNull();
    expect(await readArmTally(store, "tenant-a", "upsell", "2026-08", "treated")).toBeNull();
    expect(await readArmTally(store, "tenant-a", "cart_recovery", "2026-07", "treated")).toBeNull();
    expect(await readArmTally(store, "tenant-a", "cart_recovery", "2026-08", "control")).toBeNull();
  });

  it("accumulations are audited", async () => {
    const store = new InMemoryRuntimeStore();
    await accumulateArmTally(store, { tenantId: "acme", play: "cart_recovery", period: "2026-08", arm: "treated", exposures: 10, orders: 1, revenue: 10 });
    const audit = await store.readAudit({ tenantId: "acme" });
    expect(audit.some((a) => a.action === "arm_tally.accumulate")).toBe(true);
  });

  it("listArmTallies returns every accumulated row for a tenant", async () => {
    const store = new InMemoryRuntimeStore();
    await accumulateArmTally(store, { tenantId: "acme", play: "cart_recovery", period: "2026-08", arm: "treated", exposures: 10, orders: 1, revenue: 10 });
    await accumulateArmTally(store, { tenantId: "acme", play: "cart_recovery", period: "2026-08", arm: "control", exposures: 10, orders: 0, revenue: 0 });
    const rows = await listArmTallies(store, "acme");
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.arm).sort()).toEqual(["control", "treated"]);
  });
});

describe("readArmAggPair — the interface computeIncrementalLift consumes", () => {
  it("reads both arms and hands them straight to computeIncrementalLift", async () => {
    const store = new InMemoryRuntimeStore();
    await accumulateArmTally(store, { tenantId: "acme", play: "cart_recovery", period: "2026-08", arm: "treated", exposures: 1000, orders: 100, revenue: 10_000 });
    await accumulateArmTally(store, { tenantId: "acme", play: "cart_recovery", period: "2026-08", arm: "control", exposures: 1000, orders: 20, revenue: 2_000 });
    const { treated, control } = await readArmAggPair(store, "acme", "cart_recovery", "2026-08");
    const lift = computeIncrementalLift({ treated, control });
    expect(lift.underpowered).toBe(false);
    expect(lift.incrementalLift).toBeCloseTo(8_000);
  });

  it("defaults a never-populated arm to the honest zero (EMPTY_ARM_AGG), not a fabricated number", async () => {
    const store = new InMemoryRuntimeStore();
    await accumulateArmTally(store, { tenantId: "acme", play: "cart_recovery", period: "2026-08", arm: "treated", exposures: 1000, orders: 100, revenue: 10_000 });
    const { treated, control } = await readArmAggPair(store, "acme", "cart_recovery", "2026-08");
    expect(treated).toEqual({ exposures: 1000, orders: 100, revenue: 10_000 });
    expect(control).toEqual({ exposures: 0, orders: 0, revenue: 0 });
    expect(computeIncrementalLift({ treated, control }).underpowered).toBe(true); // zero/absent control
  });
});

// Durability NOW-1 — sharded counters. `accumulateArmTally` now writes ONE randomly-chosen shard row
// per call instead of a single hot `(play, period, arm)` row; the reads (`readArmTally`/`readArmAggPair`)
// must transparently sum across shards so every OTHER caller sees an identical value to the pre-sharding
// single-row behavior.
//
// HONESTY NOTE: `InMemoryRuntimeStore.tx` serializes per tenant (see its own header comment) — it queues
// concurrent same-tenant transactions rather than letting them race, so the actual CONTENTION RELIEF
// sharding buys is a Postgres per-row-locking property (`PostgresRuntimeStore.tx` opens a real
// SERIALIZABLE transaction per call, so two writers on DIFFERENT shard rows no longer conflict) that
// cannot be observed on this in-memory adapter. What IS provable here, and is what these tests assert,
// is (a) sum CORRECTNESS across shards — no lost or double-counted delta — and (b) that writes actually
// DISTRIBUTE across multiple physical shard rows rather than converging on one.
describe("sharded arm_tally counters (durability NOW-1)", () => {
  const originalShardCountEnv = process.env.ARM_TALLY_SHARD_COUNT;

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalShardCountEnv === undefined) delete process.env.ARM_TALLY_SHARD_COUNT;
    else process.env.ARM_TALLY_SHARD_COUNT = originalShardCountEnv;
  });

  it("a write lands on the shard Math.random() picks, and readArmTallyShards sees exactly that physical row", async () => {
    process.env.ARM_TALLY_SHARD_COUNT = "4";
    const store = new InMemoryRuntimeStore();
    // floor(draw * 4) => 0, 1, 2, 3 — one deterministic draw per call, one shard per call.
    const draws = [0, 0.3, 0.6, 0.9];
    let i = 0;
    vi.spyOn(Math, "random").mockImplementation(() => draws[i++]);
    for (let call = 0; call < 4; call++) {
      await accumulateArmTally(store, { tenantId: "acme", play: "cart_recovery", period: "2026-08", arm: "treated", exposures: 10, orders: 1, revenue: 100 });
    }
    const shards = await readArmTallyShards(store, "acme", "cart_recovery", "2026-08", "treated");
    expect(shards).toHaveLength(4); // every one of the 4 shard rows was actually written
    expect(shards.map((s) => s.exposures)).toEqual([10, 10, 10, 10]); // each shard holds exactly ONE call's delta
  });

  it("many accumulations to the same arm distribute across multiple physical shard rows, not one hot row", async () => {
    process.env.ARM_TALLY_SHARD_COUNT = "8";
    const store = new InMemoryRuntimeStore();
    // Cycle deterministically through all 8 shards, 3 full cycles (24 calls) — proves the write path
    // varies `shardId` per call (a real random draw would do this with overwhelming probability; the
    // mock removes any chance of a flaky test asserting a probabilistic fact).
    let i = 0;
    vi.spyOn(Math, "random").mockImplementation(() => (i++ % 8) / 8);
    for (let call = 0; call < 24; call++) {
      await accumulateArmTally(store, { tenantId: "acme", play: "cart_recovery", period: "2026-08", arm: "control", exposures: 1 });
    }
    const shards = await readArmTallyShards(store, "acme", "cart_recovery", "2026-08", "control");
    expect(shards).toHaveLength(8); // spread across every shard, not converged on one row
    expect(shards.every((s) => s.exposures === 3)).toBe(true); // 24 calls / 8 shards, evenly cycled
  });

  it("sharded-sum correctness: readArmTally sums to EXACTLY the total of every accumulation, none lost or double-counted", async () => {
    const store = new InMemoryRuntimeStore(); // default ARM_TALLY_SHARD_COUNT (16), real random shard picks
    let expectedExposures = 0;
    let expectedOrders = 0;
    let expectedRevenue = 0;
    for (let i = 0; i < 50; i++) {
      const orders = i % 5 === 0 ? 1 : 0;
      const revenue = orders * 20;
      await accumulateArmTally(store, { tenantId: "acme", play: "cart_recovery", period: "2026-08", arm: "treated", exposures: 1, orders, revenue });
      expectedExposures += 1;
      expectedOrders += orders;
      expectedRevenue += revenue;
    }
    const tally = await readArmTally(store, "acme", "cart_recovery", "2026-08", "treated");
    expect(tally).toEqual({
      tenantId: "acme",
      play: "cart_recovery",
      period: "2026-08",
      arm: "treated",
      exposures: expectedExposures,
      orders: expectedOrders,
      revenue: expectedRevenue,
    });
    // Cross-check: the sum of every individual physical shard row equals the same total.
    const shards = await readArmTallyShards(store, "acme", "cart_recovery", "2026-08", "treated");
    expect(shards.reduce((s, r) => s + r.exposures, 0)).toBe(expectedExposures);
    expect(shards.reduce((s, r) => s + r.orders, 0)).toBe(expectedOrders);
    expect(shards.reduce((s, r) => s + r.revenue, 0)).toBe(expectedRevenue);
  });

  it("readArmAggPair sums correctly across shards for both arms, feeding computeIncrementalLift the exact same value as an unsharded row would", async () => {
    const store = new InMemoryRuntimeStore();
    for (let i = 0; i < 40; i++) {
      await accumulateArmTally(store, { tenantId: "acme", play: "cart_recovery", period: "2026-08", arm: "treated", exposures: 25, orders: 2, revenue: 200 });
    }
    for (let i = 0; i < 40; i++) {
      await accumulateArmTally(store, { tenantId: "acme", play: "cart_recovery", period: "2026-08", arm: "control", exposures: 25, orders: 0, revenue: 0 });
    }
    const { treated, control } = await readArmAggPair(store, "acme", "cart_recovery", "2026-08");
    expect(treated).toEqual({ exposures: 1000, orders: 80, revenue: 8_000 });
    expect(control).toEqual({ exposures: 1000, orders: 0, revenue: 0 });
    const lift = computeIncrementalLift({ treated, control });
    expect(lift.underpowered).toBe(false);
    expect(lift.incrementalLift).toBeCloseTo(8_000);
  });

  it("listArmTallies still returns exactly ONE row per (play, period, arm) even when shards split the writes across rows", async () => {
    process.env.ARM_TALLY_SHARD_COUNT = "4";
    const store = new InMemoryRuntimeStore();
    let i = 0;
    vi.spyOn(Math, "random").mockImplementation(() => (i++ % 4) / 4);
    for (let call = 0; call < 4; call++) {
      await accumulateArmTally(store, { tenantId: "acme", play: "cart_recovery", period: "2026-08", arm: "treated", exposures: 10 });
    }
    const rows = await listArmTallies(store, "acme");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ tenantId: "acme", play: "cart_recovery", period: "2026-08", arm: "treated", exposures: 40, orders: 0, revenue: 0 });
  });

  it("readArmTallyShards omits absent shards rather than fabricating zero rows", async () => {
    const store = new InMemoryRuntimeStore();
    await accumulateArmTally(store, { tenantId: "acme", play: "cart_recovery", period: "2026-08", arm: "treated", exposures: 5 });
    const shards = await readArmTallyShards(store, "acme", "cart_recovery", "2026-08", "treated");
    expect(shards).toHaveLength(1); // only the shard actually written exists — no fabricated empty rows
    expect(shards[0].exposures).toBe(5);
  });

  it("a fractional/zero/negative/garbage ARM_TALLY_SHARD_COUNT falls back to the default — never a silent 0 count that hides the whole tally", async () => {
    // Security-review HIGH: "0.5" previously passed `> 0` then floored to 0 → writes on shard 0 but reads
    // enumerate ZERO shards → the whole money tally reads as null/zero. Every bad value must fall back.
    for (const bad of ["0.5", "0", "-5", "", "abc", "Infinity", "1e-9"]) {
      process.env.ARM_TALLY_SHARD_COUNT = bad;
      const store = new InMemoryRuntimeStore();
      await accumulateArmTally(store, { tenantId: "acme", play: "cart_recovery", period: "2026-08", arm: "treated", exposures: 7, orders: 1, revenue: 20 });
      const tally = await readArmTally(store, "acme", "cart_recovery", "2026-08", "treated");
      expect(tally, `bad env ${JSON.stringify(bad)} must not zero the tally`).not.toBeNull();
      expect(tally!.exposures).toBe(7);
      expect(tally!.revenue).toBe(20);
    }
  });
});

describe("appendOutcomeLedgerEntry + readOutcomeLedger (round-trip)", () => {
  const entry: OutcomeLedgerEntry = {
    merchantId: "acme",
    period: "2026-08",
    play: "cart_recovery",
    attributedIncrementalRevenue: 8_000,
    controlRef: "holdout-2026-08",
    method: "incrementality-v1:two-arm-holdout-lift+two-proportion-z",
    confidence: 0.99,
  };

  it("round-trips a ledger entry through the merchant's own stream", async () => {
    const store = new InMemoryRuntimeStore();
    await appendOutcomeLedgerEntry(store, entry);
    const rows = await readOutcomeLedger(store, "acme");
    expect(rows).toEqual([entry]);
  });

  it("is scoped by entry.merchantId — invisible under a different tenant", async () => {
    const store = new InMemoryRuntimeStore();
    await appendOutcomeLedgerEntry(store, entry);
    expect(await readOutcomeLedger(store, "someone-else")).toEqual([]);
  });

  it("appends are audited with the amount but never accumulated in place (append-only)", async () => {
    const store = new InMemoryRuntimeStore();
    await appendOutcomeLedgerEntry(store, entry);
    await appendOutcomeLedgerEntry(store, { ...entry, period: "2026-09", attributedIncrementalRevenue: 500 });
    const rows = await readOutcomeLedger(store, "acme");
    expect(rows).toHaveLength(2);
    const audit = await store.readAudit({ tenantId: "acme" });
    expect(audit.filter((a) => a.action === "outcome_ledger.append")).toHaveLength(2);
  });
});
