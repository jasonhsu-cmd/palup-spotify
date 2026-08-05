import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { InMemoryRuntimeStore } from "@palup/platform-ports";
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
