import { describe, it, expect } from "vitest";
import { InMemoryRuntimeStore } from "@palup/platform-ports";
import { accumulateArmTally } from "@palup/state-postgres";
import { readMeasuredOutcomeSignal, toGateMeasuredOutcome } from "../src/measured-outcome-signal.js";

// Revenue-flywheel Wave-2 (D), item 1 — the READ-SIDE adapter over the W2-A outcome ledger. Verifies the
// wiring end-to-end: accumulate arm tallies (as W2-B/C would), read the pair, derive the lift/power
// signal, and shape it for the evolution gate.

const T = "acme";
const PLAY = "cart-recovery";
const PERIOD = "2026-08";

describe("readMeasuredOutcomeSignal (Wave-2 D, item 1: the read-side adapter)", () => {
  it("no ledger activity at all ⇒ underpowered, zero lift, zero power (honest default, never fabricated)", async () => {
    const store = new InMemoryRuntimeStore();
    const signal = await readMeasuredOutcomeSignal(store, T, PLAY, PERIOD);
    expect(signal.underpowered).toBe(true);
    expect(signal.incrementalLift).toBe(0);
    expect(signal.power).toBe(0);
    expect(signal.method).toMatch(/underpowered/);
  });

  it("well-powered, positive lift ⇒ a finite incrementalLift and a power in (0,1], underpowered=false", async () => {
    const store = new InMemoryRuntimeStore();
    // 300 exposures/arm, treated converts meaningfully better than control.
    await accumulateArmTally(store, { tenantId: T, play: PLAY, period: PERIOD, arm: "treated", exposures: 300, orders: 60, revenue: 3000 });
    await accumulateArmTally(store, { tenantId: T, play: PLAY, period: PERIOD, arm: "control", exposures: 300, orders: 15, revenue: 750 });
    const signal = await readMeasuredOutcomeSignal(store, T, PLAY, PERIOD);
    expect(signal.underpowered).toBe(false);
    expect(signal.incrementalLift).toBeGreaterThan(0);
    expect(signal.power).toBeGreaterThan(0);
    expect(signal.power).toBeLessThanOrEqual(1);
  });

  it("below the per-arm exposure floor ⇒ underpowered even with a real-looking gap", async () => {
    const store = new InMemoryRuntimeStore();
    await accumulateArmTally(store, { tenantId: T, play: PLAY, period: PERIOD, arm: "treated", exposures: 10, orders: 5, revenue: 500 });
    await accumulateArmTally(store, { tenantId: T, play: PLAY, period: PERIOD, arm: "control", exposures: 10, orders: 0, revenue: 0 });
    const signal = await readMeasuredOutcomeSignal(store, T, PLAY, PERIOD);
    expect(signal.underpowered).toBe(true);
    expect(signal.incrementalLift).toBe(0); // clamped — never a positive figure the measurement can't support
  });

  it("reads are blast-radius isolated per (tenantId, play, period)", async () => {
    const store = new InMemoryRuntimeStore();
    await accumulateArmTally(store, { tenantId: T, play: PLAY, period: PERIOD, arm: "treated", exposures: 300, orders: 60, revenue: 3000 });
    await accumulateArmTally(store, { tenantId: T, play: PLAY, period: PERIOD, arm: "control", exposures: 300, orders: 15, revenue: 750 });
    const other = await readMeasuredOutcomeSignal(store, "other-tenant", PLAY, PERIOD);
    expect(other.underpowered).toBe(true);
    expect(other.incrementalLift).toBe(0);
  });
});

describe("toGateMeasuredOutcome (Wave-2 D, item 2: shaping the signal for PolicyMetrics.measuredOutcome)", () => {
  it("projects exactly {incrementalLift, relativeLift, power} — nothing else (durability NOW-2: relativeLift is carried through, not dropped)", () => {
    const shaped = toGateMeasuredOutcome({ incrementalLift: 42, relativeLift: 0.3, power: 0.9, underpowered: false, method: "m" });
    expect(shaped).toEqual({ incrementalLift: 42, relativeLift: 0.3, power: 0.9 });
  });
});
