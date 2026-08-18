import { describe, expect, it } from "vitest";
import { InMemoryRuntimeStore, computeIncrementalLift, type OutcomeLedgerEntry } from "@palup/platform-ports";
import {
  accumulateArmTally,
  appendOutcomeLedgerEntry,
  listArmTallies,
  readArmAggPair,
  readArmTally,
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
