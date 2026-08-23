import { describe, it, expect } from "vitest";
import {
  CONSERVATIVE_DEFAULTS,
  InMemoryMerchantRulesStore,
  InMemoryRuntimeStore,
  mergeOverDefaults,
  type MerchantIdentityPort,
  type MerchantPrincipal,
} from "@palup/platform-ports";
import { buildServer } from "../src/server.js";

// Deferred W4-min Task 4: GET/PUT /rules.

const owner: MerchantPrincipal = { kind: "merchant_user", merchantId: "t1", userId: "u1", role: "owner", authLevel: "session", sessionId: "s1" };
const viewer: MerchantPrincipal = { ...owner, role: "viewer" };
const operator: MerchantPrincipal = { ...owner, role: "operator" };
const manager: MerchantPrincipal = { ...owner, role: "manager" };
const admin: MerchantPrincipal = { ...owner, role: "admin" };

const identityFor = (p: MerchantPrincipal): MerchantIdentityPort => ({
  authenticate: async (cred) => (cred === "good" ? p : { kind: "anonymous" }),
  authorize: () => true,
});

describe("GET /rules", () => {
  it("a viewer (console.view floor) can read the defaults-merged envelope", async () => {
    const state = new InMemoryRuntimeStore();
    const rulesStore = new InMemoryMerchantRulesStore(state);
    const app = await buildServer({ store: state, rulesStore, identity: identityFor(viewer) });
    const res = await app.inject({ method: "GET", url: "/rules", headers: { authorization: "Bearer good" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ envelope: mergeOverDefaults({}) });
    expect(res.json().envelope).toEqual(CONSERVATIVE_DEFAULTS);
    await app.close();
  });

  it("an anonymous caller is 401'd", async () => {
    const state = new InMemoryRuntimeStore();
    const rulesStore = new InMemoryMerchantRulesStore(state);
    const app = await buildServer({
      store: state,
      rulesStore,
      identity: { authenticate: async () => ({ kind: "anonymous" }), authorize: () => false },
    });
    const res = await app.inject({ method: "GET", url: "/rules" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe("PUT /rules", () => {
  it("a viewer is forbidden (403) — PUT needs rules.edit", async () => {
    const state = new InMemoryRuntimeStore();
    const rulesStore = new InMemoryMerchantRulesStore(state);
    const app = await buildServer({ store: state, rulesStore, identity: identityFor(viewer) });
    const res = await app.inject({
      method: "PUT",
      url: "/rules",
      headers: { authorization: "Bearer good" },
      payload: { discount: { allowedAuto: true, maxPct: 10 } },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("an operator is forbidden (403) — rules.edit is manager+", async () => {
    const state = new InMemoryRuntimeStore();
    const rulesStore = new InMemoryMerchantRulesStore(state);
    const app = await buildServer({ store: state, rulesStore, identity: identityFor(operator) });
    const res = await app.inject({
      method: "PUT",
      url: "/rules",
      headers: { authorization: "Bearer good" },
      payload: { discount: { allowedAuto: true, maxPct: 10 } },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it.each([["manager", manager], ["admin", admin], ["owner", owner]] as const)(
    "%s can PUT: 200, bigJump:true on the off->on flip, and a subsequent GET reflects the change",
    async (_label, principal) => {
      const state = new InMemoryRuntimeStore();
      const rulesStore = new InMemoryMerchantRulesStore(state);
      const app = await buildServer({ store: state, rulesStore, identity: identityFor(principal) });

      const putRes = await app.inject({
        method: "PUT",
        url: "/rules",
        headers: { authorization: "Bearer good" },
        payload: { discount: { allowedAuto: true, maxPct: 10 } },
      });
      expect(putRes.statusCode).toBe(200);
      const putBody = putRes.json();
      expect(putBody.bigJump).toBe(true); // off -> on is always a big jump
      expect(putBody.envelope.discount).toEqual({ allowedAuto: true, maxPct: 10 });

      const getRes = await app.inject({ method: "GET", url: "/rules", headers: { authorization: "Bearer good" } });
      expect(getRes.json().envelope.discount).toEqual({ allowedAuto: true, maxPct: 10 });

      // an audit row was written by the store's own `set` (NN#5)
      const audit = await state.readAudit({ tenantId: "t1" });
      expect(audit.some((r) => r.action === "rules.changed")).toBe(true);

      await app.close();
    },
  );

  it("a small, in-range change is not flagged bigJump", async () => {
    const state = new InMemoryRuntimeStore();
    const rulesStore = new InMemoryMerchantRulesStore(state);
    const app = await buildServer({ store: state, rulesStore, identity: identityFor(owner) });

    await app.inject({
      method: "PUT",
      url: "/rules",
      headers: { authorization: "Bearer good" },
      payload: { discount: { allowedAuto: true, maxPct: 10 } },
    });
    const secondRes = await app.inject({
      method: "PUT",
      url: "/rules",
      headers: { authorization: "Bearer good" },
      payload: { discount: { allowedAuto: true, maxPct: 12 } },
    });
    expect(secondRes.statusCode).toBe(200);
    expect(secondRes.json().bigJump).toBe(false);

    await app.close();
  });

  it("rejects an unknown category with 400 and never touches the store", async () => {
    const state = new InMemoryRuntimeStore();
    const rulesStore = new InMemoryMerchantRulesStore(state);
    const app = await buildServer({ store: state, rulesStore, identity: identityFor(owner) });
    const res = await app.inject({
      method: "PUT",
      url: "/rules",
      headers: { authorization: "Bearer good" },
      payload: { not_a_real_category: { allowedAuto: true } },
    });
    expect(res.statusCode).toBe(400);

    const getRes = await app.inject({ method: "GET", url: "/rules", headers: { authorization: "Bearer good" } });
    expect(getRes.json().envelope).toEqual(CONSERVATIVE_DEFAULTS);
    await app.close();
  });

  it("rejects a malformed envelope (missing allowedAuto) with 400", async () => {
    const state = new InMemoryRuntimeStore();
    const rulesStore = new InMemoryMerchantRulesStore(state);
    const app = await buildServer({ store: state, rulesStore, identity: identityFor(owner) });
    const res = await app.inject({
      method: "PUT",
      url: "/rules",
      headers: { authorization: "Bearer good" },
      payload: { discount: { maxPct: 10 } },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("rejects a non-object body with 400", async () => {
    const state = new InMemoryRuntimeStore();
    const rulesStore = new InMemoryMerchantRulesStore(state);
    const app = await buildServer({ store: state, rulesStore, identity: identityFor(owner) });
    const res = await app.inject({
      method: "PUT",
      url: "/rules",
      headers: { authorization: "Bearer good" },
      payload: [1, 2, 3],
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("tenant isolation: a change for t1 is invisible to t2", async () => {
    const state = new InMemoryRuntimeStore();
    const rulesStore = new InMemoryMerchantRulesStore(state);
    const app = await buildServer({ store: state, rulesStore, identity: identityFor(owner) });
    await app.inject({
      method: "PUT",
      url: "/rules",
      headers: { authorization: "Bearer good" },
      payload: { discount: { allowedAuto: true, maxPct: 10 } },
    });

    const t2Owner: MerchantPrincipal = { ...owner, merchantId: "t2" };
    const appT2 = await buildServer({ store: state, rulesStore, identity: identityFor(t2Owner) });
    const res = await appT2.inject({ method: "GET", url: "/rules", headers: { authorization: "Bearer good" } });
    expect(res.json().envelope).toEqual(CONSERVATIVE_DEFAULTS);

    await app.close();
    await appT2.close();
  });

  it("an anonymous caller is 401'd before RBAC is even evaluated", async () => {
    const state = new InMemoryRuntimeStore();
    const rulesStore = new InMemoryMerchantRulesStore(state);
    const app = await buildServer({
      store: state,
      rulesStore,
      identity: { authenticate: async () => ({ kind: "anonymous" }), authorize: () => false },
    });
    const res = await app.inject({ method: "PUT", url: "/rules", payload: { discount: { allowedAuto: true } } });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
