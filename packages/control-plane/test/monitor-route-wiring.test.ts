import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { InMemoryRuntimeStore } from "@palup/platform-ports";
import { accumulateArmTally } from "@palup/state-postgres";
import { HOLDOUT_PLAY, holdoutPeriod } from "@palup/widget-backend/src/holdout.js";
import { buildServer } from "../src/server.js";
import { servingChampion } from "../src/champion-promoter.js";
import { readKnownGood } from "../src/known-good-baseline.js";

// THE BACKSTOP for the rollback fix, and the failure it guards is NOT the one durable-rollback.test.ts
// covers. That file proves `monitorServing` reverts serving correctly. This file proves the ROUTE calls
// it — which is the defect that actually shipped: `rollbackServing` and `recordKnownGood` were both
// correct, both tested, and both had NO CALLER, so /api/monitor rolled back in-memory state only and
// shoppers kept the regressing policy while the dashboard reported success.
//
// A correct function nothing calls is the single most repeated defect shape in this codebase. Route-level
// coverage is what distinguishes "implemented" from "wired".

const TOKEN = "test-op";
const AUTH = { authorization: `Bearer ${TOKEN}` };
const CAND = "cand-warm-concise"; // seeded; MOCK quality 0.9 > champion 0.75 ⇒ passes the gate

/** propose → gate → stage (§3 NN#2) → approve → promote, all through the HTTP surface. */
async function promoteViaApi(app: Awaited<ReturnType<typeof buildServer>>) {
  await app.inject({ method: "POST", url: "/api/seed", headers: AUTH });
  await app.inject({ method: "POST", url: `/api/evaluate/${CAND}`, headers: AUTH });
  await app.inject({ method: "POST", url: `/api/stage/${CAND}`, headers: AUTH });
  await app.inject({ method: "POST", url: `/api/stage/${CAND}/shadow`, headers: AUTH, payload: { n: 200, delta: 0.02 } });
  await app.inject({ method: "POST", url: `/api/stage/${CAND}/canary`, headers: AUTH, payload: { n: 500, delta: 0.06, elapsedMs: 25 * 60 * 60 * 1000 } });
  await app.inject({ method: "POST", url: `/api/approve/${CAND}`, headers: AUTH });
  await app.inject({ method: "POST", url: `/api/promote/${CAND}`, headers: AUTH });
}

describe("/api/monitor is wired to the DURABLE rollback, not just engine memory", () => {
  const prevToken = process.env.OPERATOR_TOKEN;
  beforeAll(() => { process.env.OPERATOR_TOKEN = TOKEN; });
  afterAll(() => { if (prevToken === undefined) delete process.env.OPERATOR_TOKEN; else process.env.OPERATOR_TOKEN = prevToken; });

  it("a reported regression through the ROUTE reverts the serving champion shoppers are on", async () => {
    const store = new InMemoryRuntimeStore();
    const app = await buildServer({ store });
    try {
      await promoteViaApi(app);
      expect((await servingChampion(store, "demo"))?.policy.id).toBe(CAND);

      await app.inject({ method: "POST", url: "/api/monitor", headers: AUTH, payload: { qualityScore: 0.1, safetyPass: true } });

      // The whole point: SERVING moved. Before the wiring this stayed on CAND indefinitely.
      expect((await servingChampion(store, "demo"))?.policy.id).not.toBe(CAND);
      const actions = (await store.readAudit({ tenantId: "demo" })).map((a) => a.action);
      expect(actions).toContain("champion.rollback");
    } finally {
      await app.close();
    }
  });

  it("a healthy observation through the ROUTE records the known-good baseline (the other uncalled function)", async () => {
    const store = new InMemoryRuntimeStore();
    const app = await buildServer({ store });
    try {
      await promoteViaApi(app);
      expect(await readKnownGood(store, "demo")).toBeNull();

      await app.inject({ method: "POST", url: "/api/monitor", headers: AUTH, payload: { qualityScore: 0.99, safetyPass: true } });

      expect((await readKnownGood(store, "demo"))?.policy.id).toBe(CAND);
      expect((await servingChampion(store, "demo"))?.policy.id).toBe(CAND); // healthy ⇒ serving untouched
    } finally {
      await app.close();
    }
  });

  it("the monitor route stays operator-gated — an unauthenticated regression report changes nothing", async () => {
    const store = new InMemoryRuntimeStore();
    const app = await buildServer({ store });
    try {
      await promoteViaApi(app);
      const res = await app.inject({ method: "POST", url: "/api/monitor", payload: { qualityScore: 0.1, safetyPass: true } });

      expect(res.statusCode).toBe(401);
      expect((await servingChampion(store, "demo"))?.policy.id).toBe(CAND); // unchanged
    } finally {
      await app.close();
    }
  });
});

// Revenue-flywheel W3-2 — the /api/monitor caller now reads the LIVE measured-outcome signal (over the
// W2-A/B outcome ledger, tenant "demo" / HOLDOUT_PLAY / holdoutPeriod()) and passes it as
// `observed.measuredOutcome`, so a MEASURED regression can trigger rollback even when the caller-attested
// qualityScore looks healthy — and, symmetrically, a measured WIN can confirm known-good even when the
// attested qualityScore looks bad. Seeding BEFORE `/api/evaluate/:id` (inside `promoteViaApi`) means the
// gate-stage wiring (`engine.setChampionMeasuredOutcome`) captures the pre-promotion ledger read as the
// (soon-to-be-previous) champion's baseline — this is what makes `regressionVerdict`'s `bar` comparable.
describe("/api/monitor reads the live measured-outcome signal (W3-2 caller wiring)", () => {
  const prevToken = process.env.OPERATOR_TOKEN;
  beforeAll(() => { process.env.OPERATOR_TOKEN = TOKEN; });
  afterAll(() => { if (prevToken === undefined) delete process.env.OPERATOR_TOKEN; else process.env.OPERATOR_TOKEN = prevToken; });

  async function seedLedger(store: InMemoryRuntimeStore, arm: "treated" | "control", exposures: number, orders: number, revenue: number) {
    await accumulateArmTally(store, { tenantId: "demo", play: HOLDOUT_PLAY, period: holdoutPeriod(), arm, exposures, orders, revenue });
  }

  it("DARK-SAFE: empty ledger throughout ⇒ byte-identical to the qualityScore-only verdict (no ledger activity, no behavior change)", async () => {
    const store = new InMemoryRuntimeStore();
    const app = await buildServer({ store });
    try {
      await promoteViaApi(app);
      const res = await app.inject({ method: "POST", url: "/api/monitor", headers: AUTH, payload: { qualityScore: 0.99, safetyPass: true } });
      expect(res.json().error).toBeUndefined();
      expect((await readKnownGood(store, "demo"))?.policy.id).toBe(CAND);
      expect((await servingChampion(store, "demo"))?.policy.id).toBe(CAND); // healthy — unchanged
    } finally {
      await app.close();
    }
  });

  it("a well-powered NEGATIVE measured lift regression rolls back serving even though qualityScore looks healthy", async () => {
    const store = new InMemoryRuntimeStore();
    const app = await buildServer({ store });
    try {
      // Powered positive baseline, read at gate time (captured onto the pre-promotion champion).
      await seedLedger(store, "treated", 300, 60, 3000);
      await seedLedger(store, "control", 300, 15, 750);
      await promoteViaApi(app);
      expect((await servingChampion(store, "demo"))?.policy.id).toBe(CAND);

      // Cumulative ledger now shows a clear regression vs. that baseline (+2250 → -4500), still powered.
      await seedLedger(store, "treated", 2700, 0, 0);

      const res = await app.inject({ method: "POST", url: "/api/monitor", headers: AUTH, payload: { qualityScore: 0.99, safetyPass: true } });
      expect(res.json().error).toBeUndefined();
      // SERVING moved on the MEASURED signal alone — the old proxy-only path would have called this healthy.
      expect((await servingChampion(store, "demo"))?.policy.id).not.toBe(CAND);
      const actions = (await store.readAudit({ tenantId: "demo" })).map((a) => a.action);
      expect(actions).toContain("champion.rollback");
    } finally {
      await app.close();
    }
  });

  it("a well-powered lift that did NOT regress confirms known-good even though qualityScore looks bad", async () => {
    const store = new InMemoryRuntimeStore();
    const app = await buildServer({ store });
    try {
      await seedLedger(store, "treated", 300, 60, 3000);
      await seedLedger(store, "control", 300, 15, 750);
      await promoteViaApi(app);

      // No further ledger writes — the observed read at monitor time equals the captured baseline exactly
      // (not a regression: `<`, not `<=`), so the measured signal should confirm health.
      const res = await app.inject({ method: "POST", url: "/api/monitor", headers: AUTH, payload: { qualityScore: 0.01, safetyPass: true } });
      expect(res.json().error).toBeUndefined();
      expect((await readKnownGood(store, "demo"))?.policy.id).toBe(CAND);
      expect((await servingChampion(store, "demo"))?.policy.id).toBe(CAND); // healthy — unchanged
    } finally {
      await app.close();
    }
  });

  it("an UNDERPOWERED live read falls back to the caller-attested qualityScore ('else keep attested')", async () => {
    const store = new InMemoryRuntimeStore();
    const app = await buildServer({ store });
    try {
      // Powered positive baseline captured at gate time.
      await seedLedger(store, "treated", 300, 60, 3000);
      await seedLedger(store, "control", 300, 15, 750);
      await promoteViaApi(app);

      // A compensating correction (the documented reversalPath) drops control BELOW the per-arm exposure
      // floor, so the observed read at monitor time is untrustworthy — the gate/monitor must not decide on
      // it in EITHER direction.
      await seedLedger(store, "control", -250, 0, 0);

      const res = await app.inject({ method: "POST", url: "/api/monitor", headers: AUTH, payload: { qualityScore: 0.1, safetyPass: true } });
      expect(res.json().error).toBeUndefined();
      // Falls back to qualityScore (0.1, below the 0.75 champion baseline) ⇒ STILL regresses, but on the
      // PROXY, not the untrusted measured signal.
      expect((await servingChampion(store, "demo"))?.policy.id).not.toBe(CAND);
    } finally {
      await app.close();
    }
  });
});
