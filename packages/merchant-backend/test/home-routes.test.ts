import { describe, it, expect } from "vitest";
import {
  InMemoryPrimaryGoalStore,
  InMemoryRuntimeStore,
  type MerchantIdentityPort,
  type MerchantPrincipal,
} from "@palup/platform-ports";
import { appendOutcomeLedgerEntry } from "@palup/state-postgres";
import { buildServer } from "../src/server.js";

// W2 Task 4: GET /home/summary (console.view) + PUT /home/goal (settings.edit — D4).

const owner: MerchantPrincipal = { kind: "merchant_user", merchantId: "t1", userId: "u1", role: "owner", authLevel: "session", sessionId: "s1" };
const viewer: MerchantPrincipal = { ...owner, role: "viewer" };
const operator: MerchantPrincipal = { ...owner, role: "operator" };
const manager: MerchantPrincipal = { ...owner, role: "manager" };
const admin: MerchantPrincipal = { ...owner, role: "admin" };

const identityFor = (p: MerchantPrincipal): MerchantIdentityPort => ({
  authenticate: async (cred) => (cred === "good" ? p : { kind: "anonymous" }),
  authorize: () => true,
});

describe("GET /home/summary", () => {
  it("a viewer (console.view floor) gets the honest Day-0 summary", async () => {
    const state = new InMemoryRuntimeStore();
    const app = await buildServer({ store: state, goalStore: new InMemoryPrimaryGoalStore(state), identity: identityFor(viewer) });
    const res = await app.inject({ method: "GET", url: "/home/summary", headers: { authorization: "Bearer good" } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.goal).toBeNull();
    expect(body.attributed).toMatchObject({ totalUsd: 0, entryCount: 0, plays: [], underpowered: true });
    expect(body.cost.metered).toBe(false);
    expect(body.net).toEqual({ value: null, reason: "attribution_underpowered" });
    expect(body.handoff).toBeNull();
    expect(typeof body.period).toBe("string");
    await app.close();
  });

  it("tenant comes from the PRINCIPAL, never a query param — another tenant's ledger never leaks", async () => {
    const state = new InMemoryRuntimeStore();
    await appendOutcomeLedgerEntry(state, { merchantId: "t2", period: "2026-08", play: "win_back", attributedIncrementalRevenue: 999, controlRef: "c", method: "m", confidence: 0.9 });
    const app = await buildServer({ store: state, goalStore: new InMemoryPrimaryGoalStore(state), identity: identityFor(viewer) });
    const res = await app.inject({ method: "GET", url: "/home/summary?tenantId=t2", headers: { authorization: "Bearer good" } });
    expect(res.json().attributed.totalUsd).toBe(0);
    await app.close();
  });

  it("an anonymous caller is 401'd", async () => {
    const state = new InMemoryRuntimeStore();
    const app = await buildServer({
      store: state,
      goalStore: new InMemoryPrimaryGoalStore(state),
      identity: { authenticate: async () => ({ kind: "anonymous" }), authorize: () => false },
    });
    const res = await app.inject({ method: "GET", url: "/home/summary" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe("PUT /home/goal", () => {
  it.each([["viewer", viewer], ["operator", operator], ["manager", manager]] as const)(
    "%s is forbidden (403) — the goal is settings.edit (admin+, D4)",
    async (_label, principal) => {
      const state = new InMemoryRuntimeStore();
      const app = await buildServer({ store: state, goalStore: new InMemoryPrimaryGoalStore(state), identity: identityFor(principal) });
      const res = await app.inject({
        method: "PUT",
        url: "/home/goal",
        headers: { authorization: "Bearer good" },
        payload: { kind: "recover_carts" },
      });
      expect(res.statusCode).toBe(403);
      await app.close();
    },
  );

  it.each([["admin", admin], ["owner", owner]] as const)(
    "%s can PUT; the summary reflects the goal; goal.changed is audited (NN#5)",
    async (_label, principal) => {
      const state = new InMemoryRuntimeStore();
      const app = await buildServer({ store: state, goalStore: new InMemoryPrimaryGoalStore(state), identity: identityFor(principal) });

      const put = await app.inject({
        method: "PUT",
        url: "/home/goal",
        headers: { authorization: "Bearer good" },
        payload: { kind: "recover_carts", note: "cart recovery first" },
      });
      expect(put.statusCode).toBe(200);
      expect(put.json().goal).toMatchObject({ kind: "recover_carts", note: "cart recovery first", setBy: "u1" });

      const summary = await app.inject({ method: "GET", url: "/home/summary", headers: { authorization: "Bearer good" } });
      expect(summary.json().goal.kind).toBe("recover_carts");

      const audit = await state.readAudit({ tenantId: "t1" });
      expect(audit.some((r) => r.action === "goal.changed" && r.actor === "u1")).toBe(true);
      await app.close();
    },
  );

  it("rejects an unknown kind with 400 and never touches the store", async () => {
    const state = new InMemoryRuntimeStore();
    const goalStore = new InMemoryPrimaryGoalStore(state);
    const app = await buildServer({ store: state, goalStore, identity: identityFor(owner) });
    const res = await app.inject({
      method: "PUT",
      url: "/home/goal",
      headers: { authorization: "Bearer good" },
      payload: { kind: "engagement_maxxing" },
    });
    expect(res.statusCode).toBe(400);
    expect(await goalStore.get({ tenantId: "t1" })).toBeNull();
    await app.close();
  });

  it("rejects a non-object body and a non-string note with 400", async () => {
    const state = new InMemoryRuntimeStore();
    const app = await buildServer({ store: state, goalStore: new InMemoryPrimaryGoalStore(state), identity: identityFor(owner) });
    const arr = await app.inject({ method: "PUT", url: "/home/goal", headers: { authorization: "Bearer good" }, payload: [1, 2] });
    expect(arr.statusCode).toBe(400);
    const badNote = await app.inject({ method: "PUT", url: "/home/goal", headers: { authorization: "Bearer good" }, payload: { kind: "recover_carts", note: 42 } });
    expect(badNote.statusCode).toBe(400);
    await app.close();
  });

  it("an anonymous caller is 401'd before RBAC is even evaluated", async () => {
    const state = new InMemoryRuntimeStore();
    const app = await buildServer({
      store: state,
      goalStore: new InMemoryPrimaryGoalStore(state),
      identity: { authenticate: async () => ({ kind: "anonymous" }), authorize: () => false },
    });
    const res = await app.inject({ method: "PUT", url: "/home/goal", payload: { kind: "recover_carts" } });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
