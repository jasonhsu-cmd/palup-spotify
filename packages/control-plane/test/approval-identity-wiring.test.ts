import { describe, it, expect, afterEach } from "vitest";
import { InMemoryRuntimeStore } from "@palup/platform-ports";
import { buildServer } from "../src/server.js";
import { servingChampion } from "../src/champion-promoter.js";

// ROUTE-LEVEL backstop. two-person-promote.test.ts proves the RULE; this proves the control-plane
// actually supplies the identities it needs — the distinction that keeps mattering in this codebase,
// where correct-but-unwired controls are the recurring defect.

const ENV = ["OPERATOR_TOKEN", "OPERATOR_TOKENS"];
const saved: Record<string, string | undefined> = {};
for (const k of ENV) saved[k] = process.env[k];
afterEach(() => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

const CAND = "cand-warm-concise";
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

async function stageAndApprove(app: Awaited<ReturnType<typeof buildServer>>, approverToken: string) {
  const H = bearer(approverToken);
  await app.inject({ method: "POST", url: "/api/seed", headers: H });
  await app.inject({ method: "POST", url: `/api/evaluate/${CAND}`, headers: H });
  await app.inject({ method: "POST", url: `/api/stage/${CAND}`, headers: H });
  await app.inject({ method: "POST", url: `/api/stage/${CAND}/shadow`, headers: H, payload: { n: 200, delta: 0.02 } });
  await app.inject({ method: "POST", url: `/api/stage/${CAND}/canary`, headers: H, payload: { n: 500, delta: 0.06, elapsedMs: 25 * 60 * 60 * 1000 } });
  await app.inject({ method: "POST", url: `/api/approve/${CAND}`, headers: H });
}

describe("control-plane wires REAL operator identities into approval", () => {
  it("with named operators, the approver of record is the operator who actually approved", async () => {
    process.env.OPERATOR_TOKENS = JSON.stringify({ alice: "tok-a", bob: "tok-b" });
    delete process.env.OPERATOR_TOKEN;
    const store = new InMemoryRuntimeStore();
    const app = await buildServer({ store });
    try {
      await stageAndApprove(app, "tok-a");
      const s = JSON.parse((await app.inject({ method: "GET", url: "/api/state" })).body);
      const rec = s.candidates.find((c: { policy: { id: string } }) => c.policy.id === CAND);
      expect(rec.approvedBy).toBe("alice"); // not the literal "operator"
    } finally { await app.close(); }
  });

  it("THE CONTROL, end to end: alice approves, alice's promote is REFUSED, bob's succeeds", async () => {
    process.env.OPERATOR_TOKENS = JSON.stringify({ alice: "tok-a", bob: "tok-b" });
    delete process.env.OPERATOR_TOKEN;
    const store = new InMemoryRuntimeStore();
    const app = await buildServer({ store });
    try {
      await stageAndApprove(app, "tok-a");

      const self = await app.inject({ method: "POST", url: `/api/promote/${CAND}`, headers: bearer("tok-a") });
      expect(JSON.parse(self.body).error).toMatch(/two-person/i);
      expect(await servingChampion(store, "demo")).toBeNull();

      const other = await app.inject({ method: "POST", url: `/api/promote/${CAND}`, headers: bearer("tok-b") });
      expect(JSON.parse(other.body).error).toBeUndefined();
      expect((await servingChampion(store, "demo"))?.policy.id).toBe(CAND);
    } finally { await app.close(); }
  });

  it("/api/state reports whether the two-person rule is ACTIVE — not left to look enforced", async () => {
    process.env.OPERATOR_TOKENS = JSON.stringify({ alice: "tok-a", bob: "tok-b" });
    delete process.env.OPERATOR_TOKEN;
    const app = await buildServer({ store: new InMemoryRuntimeStore() });
    try {
      const s = JSON.parse((await app.inject({ method: "GET", url: "/api/state" })).body);
      expect(s.twoPersonPromote).toBe(true);
      expect(s.operatorCount).toBe(2);
    } finally { await app.close(); }
  });

  it("LEGACY single token: still operable, and honestly reports the rule as INACTIVE", async () => {
    process.env.OPERATOR_TOKEN = "solo";
    delete process.env.OPERATOR_TOKENS;
    const store = new InMemoryRuntimeStore();
    const app = await buildServer({ store });
    try {
      const s = JSON.parse((await app.inject({ method: "GET", url: "/api/state" })).body);
      expect(s.twoPersonPromote).toBe(false);
      expect(s.operatorCount).toBe(1);

      // ...and promotion still works, so this change does not break the current deployment.
      await stageAndApprove(app, "solo");
      const res = await app.inject({ method: "POST", url: `/api/promote/${CAND}`, headers: bearer("solo") });
      expect(JSON.parse(res.body).error).toBeUndefined();
      expect((await servingChampion(store, "demo"))?.policy.id).toBe(CAND);
    } finally { await app.close(); }
  });

  it("malformed OPERATOR_TOKENS does not take the plane down — legacy token still authenticates", async () => {
    process.env.OPERATOR_TOKENS = "{not json";
    process.env.OPERATOR_TOKEN = "solo";
    const app = await buildServer({ store: new InMemoryRuntimeStore() });
    try {
      const res = await app.inject({ method: "POST", url: "/api/seed", headers: bearer("solo") });
      expect(res.statusCode).toBe(200);
    } finally { await app.close(); }
  });

  it("an unknown token is still refused everywhere", async () => {
    process.env.OPERATOR_TOKENS = JSON.stringify({ alice: "tok-a" });
    delete process.env.OPERATOR_TOKEN;
    const app = await buildServer({ store: new InMemoryRuntimeStore() });
    try {
      const res = await app.inject({ method: "POST", url: "/api/seed", headers: bearer("tok-nope") });
      expect(res.statusCode).toBe(401);
    } finally { await app.close(); }
  });
});
