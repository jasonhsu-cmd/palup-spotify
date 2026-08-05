import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { InMemoryRuntimeStore } from "@palup/platform-ports";
import { buildServer } from "../src/server.js";
import { servingChampion } from "../src/champion-promoter.js";

// ADR-0014 T4g — /api/promote now writes the DURABLE serving slot (promoteToServing), not just the
// in-memory engine champion. This makes the human path end-to-end (a promoted policy actually reaches
// shoppers) AND makes the orchestrator's route-to-human actionable (a routed candidate an operator
// approves + promotes is durably served).

const TOKEN = "test-op";
const AUTH = { authorization: `Bearer ${TOKEN}` };
const CAND = "cand-warm-concise"; // seeded; MOCK quality 0.9 > champion 0.75 ⇒ passes the gate

describe("/api/promote writes durable serving (ADR-0014 T4g)", () => {
  const prevToken = process.env.OPERATOR_TOKEN;
  beforeAll(() => { process.env.OPERATOR_TOKEN = TOKEN; });
  afterAll(() => { if (prevToken === undefined) delete process.env.OPERATOR_TOKEN; else process.env.OPERATOR_TOKEN = prevToken; });

  it("a human approve → promote persists the champion to the serving slot (was in-memory only)", async () => {
    const store = new InMemoryRuntimeStore();
    const app = await buildServer({ store });
    try {
      expect(await servingChampion(store, "demo")).toBeNull(); // nothing served yet
      await app.inject({ method: "POST", url: "/api/seed", headers: AUTH });
      await app.inject({ method: "POST", url: `/api/evaluate/${CAND}`, headers: AUTH });
      // §3 NN#2 — walk shadow → canary through the operator staging routes before promoting.
      await app.inject({ method: "POST", url: `/api/stage/${CAND}`, headers: AUTH });
      await app.inject({ method: "POST", url: `/api/stage/${CAND}/shadow`, headers: AUTH, payload: { n: 200, delta: 0.02 } });
      await app.inject({ method: "POST", url: `/api/stage/${CAND}/canary`, headers: AUTH, payload: { n: 500, delta: 0.06, elapsedMs: 25 * 60 * 60 * 1000 } });
      await app.inject({ method: "POST", url: `/api/approve/${CAND}`, headers: AUTH });
      const res = await app.inject({ method: "POST", url: `/api/promote/${CAND}`, headers: AUTH });
      expect(JSON.parse(res.body).error).toBeUndefined();
      const served = await servingChampion(store, "demo");
      expect(served?.policy.id).toBe(CAND); // DURABLE serving write happened
      expect(served?.approvedBy).toBe("operator"); // bound to the human approver, never an agent
    } finally {
      await app.close();
    }
  });

  it("promoting an UN-approved candidate writes nothing to serving (human approval required)", async () => {
    const store = new InMemoryRuntimeStore();
    const app = await buildServer({ store });
    try {
      await app.inject({ method: "POST", url: "/api/seed", headers: AUTH });
      await app.inject({ method: "POST", url: `/api/evaluate/${CAND}`, headers: AUTH });
      // NO approve — promote must refuse and serve nothing
      const res = await app.inject({ method: "POST", url: `/api/promote/${CAND}`, headers: AUTH });
      expect(JSON.parse(res.body).error).toMatch(/approv/i);
      expect(await servingChampion(store, "demo")).toBeNull();
    } finally {
      await app.close();
    }
  });
});
