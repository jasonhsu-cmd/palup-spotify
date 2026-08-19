import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { InMemoryRuntimeStore } from "@palup/platform-ports";
import { buildServer } from "../src/server.js";
import { servingChampion } from "../src/champion-promoter.js";

// W3-1 (deploy-prep): PROMOTE_TENANT is now env-configurable — a real deploy sets it to the actual
// merchant tenant (e.g. palup-skincare-jason) instead of the hardcoded "demo" demo tenant, so
// promotions durably serve the right merchant. This proves both the override AND the back-compat
// default, following the same seed→evaluate→stage→shadow→canary→approve→promote HTTP flow as
// promote-serving-wiring.test.ts.

const TOKEN = "test-op";
const AUTH = { authorization: `Bearer ${TOKEN}` };
const CAND = "cand-warm-concise"; // seeded; MOCK quality 0.9 > champion 0.75 ⇒ passes the gate

async function promoteViaApi(app: Awaited<ReturnType<typeof buildServer>>) {
  await app.inject({ method: "POST", url: "/api/seed", headers: AUTH });
  await app.inject({ method: "POST", url: `/api/evaluate/${CAND}`, headers: AUTH });
  await app.inject({ method: "POST", url: `/api/stage/${CAND}`, headers: AUTH });
  await app.inject({ method: "POST", url: `/api/stage/${CAND}/shadow`, headers: AUTH, payload: { n: 200, delta: 0.02 } });
  await app.inject({ method: "POST", url: `/api/stage/${CAND}/canary`, headers: AUTH, payload: { n: 500, delta: 0.06, elapsedMs: 25 * 60 * 60 * 1000 } });
  await app.inject({ method: "POST", url: `/api/approve/${CAND}`, headers: AUTH });
  return app.inject({ method: "POST", url: `/api/promote/${CAND}`, headers: AUTH });
}

describe("PROMOTE_TENANT is env-configurable (W3-1 deploy-prep)", () => {
  const prevToken = process.env.OPERATOR_TOKEN;
  const prevTenant = process.env.PROMOTE_TENANT;
  beforeAll(() => { process.env.OPERATOR_TOKEN = TOKEN; });
  afterAll(() => {
    if (prevToken === undefined) delete process.env.OPERATOR_TOKEN; else process.env.OPERATOR_TOKEN = prevToken;
    if (prevTenant === undefined) delete process.env.PROMOTE_TENANT; else process.env.PROMOTE_TENANT = prevTenant;
  });

  it("with PROMOTE_TENANT set, a promotion durably serves that tenant, not 'demo'", async () => {
    process.env.PROMOTE_TENANT = "palup-skincare-jason";
    const store = new InMemoryRuntimeStore();
    const app = await buildServer({ store });
    try {
      const res = await promoteViaApi(app);
      expect(JSON.parse(res.body).error).toBeUndefined();
      expect((await servingChampion(store, "palup-skincare-jason"))?.policy.id).toBe(CAND);
      expect(await servingChampion(store, "demo")).toBeNull(); // never lands on the wrong tenant
    } finally {
      delete process.env.PROMOTE_TENANT;
      await app.close();
    }
  });

  it("with PROMOTE_TENANT unset, the default stays 'demo' (back-compat)", async () => {
    delete process.env.PROMOTE_TENANT;
    const store = new InMemoryRuntimeStore();
    const app = await buildServer({ store });
    try {
      const res = await promoteViaApi(app);
      expect(JSON.parse(res.body).error).toBeUndefined();
      expect((await servingChampion(store, "demo"))?.policy.id).toBe(CAND);
    } finally {
      await app.close();
    }
  });

  it("with PROMOTE_TENANT empty/whitespace (deploy misconfig), falls back to 'demo' — never a blank tenant", async () => {
    process.env.PROMOTE_TENANT = "   ";
    const store = new InMemoryRuntimeStore();
    const app = await buildServer({ store });
    try {
      const res = await promoteViaApi(app);
      expect(JSON.parse(res.body).error).toBeUndefined();
      // The guard worked: the promotion landed on "demo", not a blank tenant. (The store itself
      // rejects a blank tenantId outright — tenant isolation — so there's no blank row to check for.)
      expect((await servingChampion(store, "demo"))?.policy.id).toBe(CAND);
    } finally {
      delete process.env.PROMOTE_TENANT;
      await app.close();
    }
  });
});
