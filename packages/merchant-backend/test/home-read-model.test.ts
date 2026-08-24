import { describe, it, expect } from "vitest";
import {
  InMemoryRuntimeStore,
  InMemoryPrimaryGoalStore,
  PLACEHOLDER_MODEL_PRICES,
  type TelemetryEvent,
} from "@palup/platform-ports";
import { accumulateArmTally, appendOutcomeLedgerEntry } from "@palup/state-postgres";
import {
  currentPeriod,
  readHomeSummary,
  HANDOFF_COLLECTION,
  HANDOFF_KEY,
  type OnboardingHandoff,
} from "../src/home/read-model.js";

// W2 Task 3: the Revenue Home read model. Every number is derived from the canonical spine
// (outcome ledger / arm tallies / telemetry rollup) — this suite proves each HONEST state the
// spec demands: still-measuring, not-yet-metered, unpriced-lower-bound, and net-negative.
//
// REVIEW-MANDATED ADJUSTMENT (applied here): the attributed "still measuring" state (the
// `attributed.underpowered` flag) is driven by `attributed.totalUsd === 0` (OR all live plays
// underpowered when there ARE live plays) — NOT by `periodEntries.length === 0` alone. This
// closes a latent honesty edge: without it, a powered live play with zero ledger entries would
// report `underpowered: false`, which a console could read as "measured" and render a bare
// "$0.00" next to a play the measurement table calls "Measured" — a dollar amount that looks
// real but isn't backed by any billed ledger entry yet. See the "still measuring" test below,
// which is the corrected version of the brief's original (self-contradictory) assertion.

const T = "t1";
const PERIOD = "2026-08";
const ctx = { tenantId: T };

function tele(at: string, model: string, inputTokens: number, outputTokens: number): TelemetryEvent {
  return { kind: "model_call", model, inputTokens, outputTokens, at };
}

async function seedPoweredPlay(store: InMemoryRuntimeStore): Promise<void> {
  // 300 exposures per arm clears MIN_EXPOSURES_PER_ARM=200 (the measured-outcome-signal.test.ts fixture).
  await accumulateArmTally(store, { tenantId: T, play: "win_back", period: PERIOD, arm: "treated", exposures: 300, orders: 60, revenue: 3000 });
  await accumulateArmTally(store, { tenantId: T, play: "win_back", period: PERIOD, arm: "control", exposures: 300, orders: 15, revenue: 750 });
}

describe("currentPeriod", () => {
  it("formats YYYY-MM in UTC (matches widget-backend's holdoutPeriod format)", () => {
    expect(currentPeriod(new Date("2026-08-24T23:59:59.000Z"))).toBe("2026-08");
    expect(currentPeriod(new Date("2026-01-05T00:00:00.000Z"))).toBe("2026-01");
  });
});

describe("readHomeSummary", () => {
  it("Day-0 honest empty: no goal, underpowered attribution, unmetered cost, null net, no handoff", async () => {
    const store = new InMemoryRuntimeStore();
    const s = await readHomeSummary(store, new InMemoryPrimaryGoalStore(store), T, { period: PERIOD, prices: PLACEHOLDER_MODEL_PRICES });
    expect(s).toEqual({
      period: PERIOD,
      goal: null,
      attributed: { totalUsd: 0, entryCount: 0, plays: [], underpowered: true },
      cost: { metered: false, totalUsd: 0, fullyPriced: true, unpricedModels: [], events: 0 },
      net: { value: null, reason: "attribution_underpowered" },
      handoff: null,
    });
  });

  it("sums ONLY the requested period's ledger entries (canonical attributed, D2)", async () => {
    const store = new InMemoryRuntimeStore();
    await appendOutcomeLedgerEntry(store, { merchantId: T, period: PERIOD, play: "win_back", attributedIncrementalRevenue: 100.5, controlRef: "holdout-2026-08", method: "m", confidence: 0.9 });
    await appendOutcomeLedgerEntry(store, { merchantId: T, period: PERIOD, play: "agent", attributedIncrementalRevenue: 49.5, controlRef: "holdout-2026-08", method: "m", confidence: 0.9 });
    await appendOutcomeLedgerEntry(store, { merchantId: T, period: "2026-07", play: "win_back", attributedIncrementalRevenue: 999, controlRef: "holdout-2026-07", method: "m", confidence: 0.9 });
    const s = await readHomeSummary(store, new InMemoryPrimaryGoalStore(store), T, { period: PERIOD, prices: PLACEHOLDER_MODEL_PRICES });
    expect(s.attributed.totalUsd).toBe(150);
    expect(s.attributed.entryCount).toBe(2);
    expect(s.attributed.underpowered).toBe(false);
  });

  it("HONESTY EDGE (review-mandated): a powered live play WITHOUT a ledger entry never renders a $0.00 attributed headline as 'measured' — it stays 'still measuring'", async () => {
    const store = new InMemoryRuntimeStore();
    await seedPoweredPlay(store);
    const s = await readHomeSummary(store, new InMemoryPrimaryGoalStore(store), T, { period: PERIOD, prices: PLACEHOLDER_MODEL_PRICES });
    expect(s.attributed.totalUsd).toBe(0); // no ledger entry yet — tallies alone are not billed
    expect(s.attributed.entryCount).toBe(0);
    expect(s.attributed.plays).toHaveLength(1);
    const play = s.attributed.plays[0]!;
    expect(play.play).toBe("win_back");
    // The per-play measurement itself IS powered (informational; never summed into totalUsd).
    expect(play.underpowered).toBe(false);
    // (10 - 2.5) revenue-per-exposure gap × 300 treated exposures = 2250 (computeIncrementalLift's math)
    expect(play.incrementalLiftUsd).toBeCloseTo(2250);
    // But the HEADLINE attributed number is still $0 (no billed ledger entry) — the honest state is
    // "still measuring", NOT "measured $0.00", even though the play-level measurement is powered.
    expect(s.attributed.underpowered).toBe(true);
    expect(s.net).toEqual({ value: null, reason: "attribution_underpowered" });
  });

  it("an underpowered play (below the exposure floor) keeps the honest still-measuring state", async () => {
    const store = new InMemoryRuntimeStore();
    await accumulateArmTally(store, { tenantId: T, play: "win_back", period: PERIOD, arm: "treated", exposures: 10, orders: 5, revenue: 500 });
    const s = await readHomeSummary(store, new InMemoryPrimaryGoalStore(store), T, { period: PERIOD, prices: PLACEHOLDER_MODEL_PRICES });
    expect(s.attributed.plays[0]!.underpowered).toBe(true);
    expect(s.attributed.plays[0]!.incrementalLiftUsd).toBe(0); // clamped, never a number the data can't support
    expect(s.attributed.underpowered).toBe(true);
    expect(s.net).toEqual({ value: null, reason: "attribution_underpowered" });
  });

  it("ignores tallies from other periods", async () => {
    const store = new InMemoryRuntimeStore();
    await accumulateArmTally(store, { tenantId: T, play: "win_back", period: "2026-07", arm: "treated", exposures: 300, orders: 60, revenue: 3000 });
    const s = await readHomeSummary(store, new InMemoryPrimaryGoalStore(store), T, { period: PERIOD, prices: PLACEHOLDER_MODEL_PRICES });
    expect(s.attributed.plays).toEqual([]);
  });

  it("cost: period-filtered rollup over the telemetry stream (D1) — fully priced mock model", async () => {
    const store = new InMemoryRuntimeStore();
    await store.append(ctx, "telemetry", tele("2026-08-10T00:00:00.000Z", "mock", 1000, 500));
    await store.append(ctx, "telemetry", tele("2026-07-10T00:00:00.000Z", "mock", 9999, 9999)); // other period — excluded
    const s = await readHomeSummary(store, new InMemoryPrimaryGoalStore(store), T, { period: PERIOD, prices: PLACEHOLDER_MODEL_PRICES });
    expect(s.cost).toEqual({ metered: true, totalUsd: 0, fullyPriced: true, unpricedModels: [], events: 1 });
  });

  it("cost: an unpriced model is FLAGGED, its cost never fabricated, and net is withheld", async () => {
    const store = new InMemoryRuntimeStore();
    await appendOutcomeLedgerEntry(store, { merchantId: T, period: PERIOD, play: "win_back", attributedIncrementalRevenue: 100, controlRef: "c", method: "m", confidence: 0.9 });
    await store.append(ctx, "telemetry", tele("2026-08-10T00:00:00.000Z", "gemini-2.5-flash", 1000, 500));
    const s = await readHomeSummary(store, new InMemoryPrimaryGoalStore(store), T, { period: PERIOD, prices: PLACEHOLDER_MODEL_PRICES });
    expect(s.cost.metered).toBe(true);
    expect(s.cost.fullyPriced).toBe(false);
    expect(s.cost.unpricedModels).toEqual(["gemini-2.5-flash"]);
    expect(s.net).toEqual({ value: null, reason: "cost_not_fully_priced" });
  });

  it("net: attributed − cost when both sides are honest; a NEGATIVE net is returned, not hidden (D3)", async () => {
    const store = new InMemoryRuntimeStore();
    await appendOutcomeLedgerEntry(store, { merchantId: T, period: PERIOD, play: "win_back", attributedIncrementalRevenue: 1, controlRef: "c", method: "m", confidence: 0.9 });
    await store.append(ctx, "telemetry", tele("2026-08-10T00:00:00.000Z", "mock", 1000, 500));
    // Priced table injected for determinism: $1000/1M in + $1000/1M out → 1000 in = $1, 500 out = $0.50.
    const s = await readHomeSummary(store, new InMemoryPrimaryGoalStore(store), T, {
      period: PERIOD,
      prices: { mock: { inputPer1M: 1000, outputPer1M: 1000 } },
    });
    expect(s.cost.totalUsd).toBeCloseTo(1.5);
    expect(s.net.reason).toBe("ok");
    expect(s.net.value).toBeCloseTo(-0.5); // net-negative shown honestly
  });

  it("net: withheld with reason cost_not_metered when attribution exists but no telemetry does", async () => {
    const store = new InMemoryRuntimeStore();
    await appendOutcomeLedgerEntry(store, { merchantId: T, period: PERIOD, play: "win_back", attributedIncrementalRevenue: 100, controlRef: "c", method: "m", confidence: 0.9 });
    const s = await readHomeSummary(store, new InMemoryPrimaryGoalStore(store), T, { period: PERIOD, prices: PLACEHOLDER_MODEL_PRICES });
    expect(s.net).toEqual({ value: null, reason: "cost_not_metered" });
  });

  it("returns the goal and the onboarding-handoff card when present (D7)", async () => {
    const store = new InMemoryRuntimeStore();
    const goalStore = new InMemoryPrimaryGoalStore(store, () => "2026-08-24T00:00:00.000Z");
    await goalStore.set(ctx, { kind: "recover_carts" }, "u1");
    const handoff: OnboardingHandoff = {
      headline: "Welcome to PalUp — I picked up where we left off",
      items: [{ label: "Your goal — recover more carts — is first in line.", detail: "It's the first play I'm running for you this week." }],
      sourceNote: "This is from your signup conversation with PalUp — kept separate from your customers' data.",
    };
    await store.put(ctx, HANDOFF_COLLECTION, HANDOFF_KEY, handoff);
    const s = await readHomeSummary(store, goalStore, T, { period: PERIOD, prices: PLACEHOLDER_MODEL_PRICES });
    expect(s.goal).toEqual({ kind: "recover_carts", setBy: "u1", setAt: "2026-08-24T00:00:00.000Z" });
    expect(s.handoff).toEqual(handoff);
  });

  it("tenant isolation: another tenant's ledger/tallies/telemetry never leak in", async () => {
    const store = new InMemoryRuntimeStore();
    await appendOutcomeLedgerEntry(store, { merchantId: "other", period: PERIOD, play: "win_back", attributedIncrementalRevenue: 999, controlRef: "c", method: "m", confidence: 0.9 });
    await store.append({ tenantId: "other" }, "telemetry", tele("2026-08-10T00:00:00.000Z", "mock", 1000, 500));
    const s = await readHomeSummary(store, new InMemoryPrimaryGoalStore(store), T, { period: PERIOD, prices: PLACEHOLDER_MODEL_PRICES });
    expect(s.attributed.totalUsd).toBe(0);
    expect(s.cost.metered).toBe(false);
  });
});
