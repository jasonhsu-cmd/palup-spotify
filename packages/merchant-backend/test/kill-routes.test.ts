import { describe, it, expect } from "vitest";
import { InMemoryRuntimeStore, type MerchantIdentityPort, type MerchantPrincipal } from "@palup/platform-ports";
import { buildServer } from "../src/server.js";

// W1-API Task 5: GET /kill, POST /kill, POST /unkill.

const owner: MerchantPrincipal = { kind: "merchant_user", merchantId: "t1", userId: "u1", role: "owner", authLevel: "session", sessionId: "s1" };
const viewer: MerchantPrincipal = { ...owner, role: "viewer" };
const operator: MerchantPrincipal = { ...owner, role: "operator" };
const manager: MerchantPrincipal = { ...owner, role: "manager" };
const admin: MerchantPrincipal = { ...owner, role: "admin" };

const identityFor = (p: MerchantPrincipal): MerchantIdentityPort => ({
  authenticate: async (cred) => (cred === "good" ? p : { kind: "anonymous" }),
  authorize: () => true,
});

describe("GET /kill", () => {
  it("a viewer (console.view floor) can read status: killed:false when clear", async () => {
    const state = new InMemoryRuntimeStore();
    const app = await buildServer({ store: state, identity: identityFor(viewer) });
    const res = await app.inject({ method: "GET", url: "/kill", headers: { authorization: "Bearer good" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ killed: false });
    await app.close();
  });

  it("an anonymous caller is 401'd", async () => {
    const state = new InMemoryRuntimeStore();
    const app = await buildServer({ store: state, identity: { authenticate: async () => ({ kind: "anonymous" }), authorize: () => false } });
    const res = await app.inject({ method: "GET", url: "/kill" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe("POST /kill", () => {
  it("a viewer is forbidden (403) — kill needs agent.operate", async () => {
    const state = new InMemoryRuntimeStore();
    const app = await buildServer({ store: state, identity: identityFor(viewer) });
    const res = await app.inject({
      method: "POST",
      url: "/kill",
      headers: { authorization: "Bearer good" },
      payload: { reason: "halt" },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("an operator can halt: 200, and GET /kill reflects killed:true", async () => {
    const state = new InMemoryRuntimeStore();
    const app = await buildServer({ store: state, identity: identityFor(operator) });

    const killRes = await app.inject({
      method: "POST",
      url: "/kill",
      headers: { authorization: "Bearer good" },
      payload: { reason: "suspicious activity" },
    });
    expect(killRes.statusCode).toBe(200);
    expect(killRes.json()).toEqual({ killed: true });

    const statusRes = await app.inject({ method: "GET", url: "/kill", headers: { authorization: "Bearer good" } });
    expect(statusRes.json()).toEqual({ killed: true });

    // an audit row exists under the shared kill registry's system tenant
    const audit = await state.readAudit({ tenantId: "__system__" });
    expect(audit.some((r) => r.action === "runtime_kill.arm")).toBe(true);

    await app.close();
  });

  it("an owner can halt too (agent.operate is operator+)", async () => {
    const state = new InMemoryRuntimeStore();
    const app = await buildServer({ store: state, identity: identityFor(owner) });
    const res = await app.inject({
      method: "POST",
      url: "/kill",
      headers: { authorization: "Bearer good" },
      payload: { reason: "halt" },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("requires a non-empty reason: blank body -> 400", async () => {
    const state = new InMemoryRuntimeStore();
    const app = await buildServer({ store: state, identity: identityFor(operator) });
    const res = await app.inject({
      method: "POST",
      url: "/kill",
      headers: { authorization: "Bearer good" },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("halting one tenant does not halt another (tenant isolation)", async () => {
    const state = new InMemoryRuntimeStore();
    const app = await buildServer({ store: state, identity: identityFor(operator) });
    await app.inject({
      method: "POST",
      url: "/kill",
      headers: { authorization: "Bearer good" },
      payload: { reason: "halt t1" },
    });

    const t2Owner: MerchantPrincipal = { ...owner, merchantId: "t2" };
    const appT2 = await buildServer({ store: state, identity: identityFor(t2Owner) });
    const res = await appT2.inject({ method: "GET", url: "/kill", headers: { authorization: "Bearer good" } });
    expect(res.json()).toEqual({ killed: false });

    await app.close();
    await appT2.close();
  });

  it("an anonymous caller is 401'd before RBAC is even evaluated", async () => {
    const state = new InMemoryRuntimeStore();
    const app = await buildServer({ store: state, identity: { authenticate: async () => ({ kind: "anonymous" }), authorize: () => false } });
    const res = await app.inject({ method: "POST", url: "/kill", payload: { reason: "halt" } });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe("POST /unkill", () => {
  async function killedState(identity: MerchantIdentityPort): Promise<InMemoryRuntimeStore> {
    const state = new InMemoryRuntimeStore();
    const app = await buildServer({ store: state, identity });
    await app.inject({
      method: "POST",
      url: "/kill",
      headers: { authorization: "Bearer good" },
      payload: { reason: "halt" },
    });
    await app.close();
    return state;
  }

  it.each([["viewer", viewer], ["operator", operator]] as const)(
    "%s is forbidden (403) — unkill needs manager+",
    async (_label, principal) => {
      const state = await killedState(identityFor(operator));
      const app = await buildServer({ store: state, identity: identityFor(principal) });
      const res = await app.inject({ method: "POST", url: "/unkill", headers: { authorization: "Bearer good" } });
      expect(res.statusCode).toBe(403);

      const statusRes = await app.inject({ method: "GET", url: "/kill", headers: { authorization: "Bearer good" } });
      expect(statusRes.json()).toEqual({ killed: true }); // still killed — the forbidden call had no effect

      await app.close();
    },
  );

  it.each([["manager", manager], ["admin", admin], ["owner", owner]] as const)(
    "%s can resume: 200, and GET /kill reflects killed:false",
    async (_label, principal) => {
      const state = await killedState(identityFor(operator));
      const app = await buildServer({ store: state, identity: identityFor(principal) });
      const res = await app.inject({ method: "POST", url: "/unkill", headers: { authorization: "Bearer good" } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ killed: false });

      const statusRes = await app.inject({ method: "GET", url: "/kill", headers: { authorization: "Bearer good" } });
      expect(statusRes.json()).toEqual({ killed: false });

      await app.close();
    },
  );

  it("an anonymous caller is 401'd", async () => {
    const state = await killedState(identityFor(operator));
    const app = await buildServer({ store: state, identity: { authenticate: async () => ({ kind: "anonymous" }), authorize: () => false } });
    const res = await app.inject({ method: "POST", url: "/unkill" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
