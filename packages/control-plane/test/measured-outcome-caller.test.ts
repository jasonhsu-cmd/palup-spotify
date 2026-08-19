import { describe, it, expect } from "vitest";
import { InMemoryRuntimeStore } from "@palup/platform-ports";
import { accumulateArmTally } from "@palup/state-postgres";
import { HOLDOUT_PLAY, holdoutPeriod } from "@palup/widget-backend/src/holdout.js";
import { readServingMeasuredOutcome } from "../src/measured-outcome-caller.js";
import { toGateMeasuredOutcome } from "../src/measured-outcome-signal.js";
import { buildServer } from "../src/server.js";

// Revenue-flywheel W3-2 — the KEYSTONE wiring: this is what fixes the (tenant, play, period) contract
// `measured-outcome-signal.ts` deliberately deferred ("a business decision" its own header says it does
// not guess). The answer: play=HOLDOUT_PLAY ("agent" — the only play the v1 business holdout covers,
// widget-backend/holdout.ts), period=holdoutPeriod(now) — the SAME UTC YYYY-MM bucket the holdout
// assignment + the W2-C orders webhook already write ArmTally rows against. This module does not invent
// a new bucketing scheme; it reads the one the ledger WRITERS already use.

const T = "demo";
const CAND = "cand-warm-concise"; // seeded; MOCK quality 0.9 > champion 0.75 ⇒ passes the gate regardless

describe("readServingMeasuredOutcome (the ONE control-plane wiring/adapter module)", () => {
  it("reads the SAME (play, period) the holdout/ledger writers use — HOLDOUT_PLAY + holdoutPeriod(now)", async () => {
    const store = new InMemoryRuntimeStore();
    const now = new Date("2026-08-19T00:00:00Z");
    await accumulateArmTally(store, { tenantId: T, play: HOLDOUT_PLAY, period: holdoutPeriod(now), arm: "treated", exposures: 300, orders: 60, revenue: 3000 });
    await accumulateArmTally(store, { tenantId: T, play: HOLDOUT_PLAY, period: holdoutPeriod(now), arm: "control", exposures: 300, orders: 15, revenue: 750 });
    const signal = await readServingMeasuredOutcome(store, T, now);
    expect(signal.underpowered).toBe(false);
    expect(signal.incrementalLift).toBeCloseTo(2250);
    expect(signal.power).toBeGreaterThanOrEqual(0.95);
  });

  it("DARK-SAFE: no ledger activity at all ⇒ the honest zero (underpowered, lift 0, power 0)", async () => {
    const store = new InMemoryRuntimeStore();
    const signal = await readServingMeasuredOutcome(store, T, new Date("2026-08-19T00:00:00Z"));
    expect(signal.underpowered).toBe(true);
    expect(signal.incrementalLift).toBe(0);
    expect(signal.power).toBe(0);
  });

  it("a tally under a DIFFERENT play (not HOLDOUT_PLAY) is correctly ignored — this seam reads 'agent' only", async () => {
    const store = new InMemoryRuntimeStore();
    const now = new Date("2026-08-19T00:00:00Z");
    await accumulateArmTally(store, { tenantId: T, play: "cart-recovery", period: holdoutPeriod(now), arm: "treated", exposures: 300, orders: 60, revenue: 3000 });
    await accumulateArmTally(store, { tenantId: T, play: "cart-recovery", period: holdoutPeriod(now), arm: "control", exposures: 300, orders: 15, revenue: 750 });
    const signal = await readServingMeasuredOutcome(store, T, now);
    expect(signal.underpowered).toBe(true); // nothing recorded under "agent" for this tenant/period
  });
});

// Gate stage (secondary, per the W3-2 design contract): the champion's LIVE measured lift is attached as
// the baseline PolicyMetrics.measuredOutcome before evaluate()/gate() reads `this.champion.metrics` — a
// brand-new candidate's own measuredOutcome stays absent (nothing has served IT yet), so the gate
// correctly falls back to the quality proxy for the candidate side regardless.
describe("Gate stage wiring — /api/evaluate/:id attaches the champion's live measured-outcome baseline", () => {
  const TOKEN = "test-op-gate-caller";
  const AUTH = { authorization: `Bearer ${TOKEN}` };

  it("DARK-SAFE: empty ledger ⇒ champion baseline is the honest zero and the gate decision is unaffected", async () => {
    const prev = process.env.OPERATOR_TOKEN;
    process.env.OPERATOR_TOKEN = TOKEN;
    const store = new InMemoryRuntimeStore();
    const app = await buildServer({ store });
    try {
      await app.inject({ method: "POST", url: "/api/seed", headers: AUTH });
      await app.inject({ method: "POST", url: `/api/evaluate/${CAND}`, headers: AUTH });
      const body = (await app.inject({ method: "GET", url: "/api/state", headers: AUTH })).json();
      expect(body.champion.metrics.measuredOutcome).toEqual({ incrementalLift: 0, power: 0 });
      const rec = body.candidates.find((c: { policy: { id: string } }) => c.policy.id === CAND);
      expect(rec.gate.pass).toBe(true); // MOCK qualityScore 0.9 > champion 0.75 — unaffected either way
    } finally {
      await app.close();
      if (prev === undefined) delete process.env.OPERATOR_TOKEN; else process.env.OPERATOR_TOKEN = prev;
    }
  });

  it("a well-powered, positive ledger read flows into the champion's baseline measuredOutcome metric", async () => {
    const prev = process.env.OPERATOR_TOKEN;
    process.env.OPERATOR_TOKEN = TOKEN;
    const store = new InMemoryRuntimeStore();
    const app = await buildServer({ store });
    try {
      await accumulateArmTally(store, { tenantId: T, play: HOLDOUT_PLAY, period: holdoutPeriod(), arm: "treated", exposures: 300, orders: 60, revenue: 3000 });
      await accumulateArmTally(store, { tenantId: T, play: HOLDOUT_PLAY, period: holdoutPeriod(), arm: "control", exposures: 300, orders: 15, revenue: 750 });
      await app.inject({ method: "POST", url: "/api/seed", headers: AUTH });
      await app.inject({ method: "POST", url: `/api/evaluate/${CAND}`, headers: AUTH });
      const body = (await app.inject({ method: "GET", url: "/api/state", headers: AUTH })).json();
      expect(body.champion.metrics.measuredOutcome.incrementalLift).toBeCloseTo(2250);
      expect(body.champion.metrics.measuredOutcome.power).toBeGreaterThanOrEqual(0.95);
    } finally {
      await app.close();
      if (prev === undefined) delete process.env.OPERATOR_TOKEN; else process.env.OPERATOR_TOKEN = prev;
    }
  });
});

describe("toGateMeasuredOutcome composes with the adapter exactly as the canary caller does", () => {
  it("projects the adapter's read down to {incrementalLift, power} for a PolicyMetrics.measuredOutcome seam", async () => {
    const store = new InMemoryRuntimeStore();
    const now = new Date("2026-08-19T00:00:00Z");
    await accumulateArmTally(store, { tenantId: T, play: HOLDOUT_PLAY, period: holdoutPeriod(now), arm: "treated", exposures: 300, orders: 60, revenue: 3000 });
    await accumulateArmTally(store, { tenantId: T, play: HOLDOUT_PLAY, period: holdoutPeriod(now), arm: "control", exposures: 300, orders: 15, revenue: 750 });
    const shaped = toGateMeasuredOutcome(await readServingMeasuredOutcome(store, T, now));
    expect(Object.keys(shaped).sort()).toEqual(["incrementalLift", "power"]);
    expect(shaped.incrementalLift).toBeCloseTo(2250);
  });
});
