import { describe, it, expect } from "vitest";
import {
  CONSERVATIVE_DEFAULTS,
  InMemoryMerchantRulesStore,
  InMemoryRuntimeStore,
  mergeOverDefaults,
  PALUP_FLOORS,
  listPresets,
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

describe("GET /rules/floors", () => {
  it("returns the inviolable PalUp floors (console.view floor)", async () => {
    const state = new InMemoryRuntimeStore();
    const rulesStore = new InMemoryMerchantRulesStore(state);
    const app = await buildServer({ store: state, rulesStore, identity: identityFor(viewer) });
    const res = await app.inject({ method: "GET", url: "/rules/floors", headers: { authorization: "Bearer good" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().floors.ad_spend.maxAutoPeriodUsd).toBe(PALUP_FLOORS.ad_spend.maxAutoPeriodUsd);
    await app.close();
  });
});

describe("GET /rules/presets", () => {
  it("lists Day-1 + vertical presets", async () => {
    const state = new InMemoryRuntimeStore();
    const rulesStore = new InMemoryMerchantRulesStore(state);
    const app = await buildServer({ store: state, rulesStore, identity: identityFor(viewer) });
    const res = await app.inject({ method: "GET", url: "/rules/presets", headers: { authorization: "Bearer good" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().presets.map((p: { id: string }) => p.id)).toEqual(listPresets().map((p) => p.id));
    await app.close();
  });
});

describe("PUT /rules — broadened fields", () => {
  it("accepts the full discount/ad_spend/refund/subscription/campaign policy", async () => {
    const state = new InMemoryRuntimeStore();
    const rulesStore = new InMemoryMerchantRulesStore(state);
    const app = await buildServer({ store: state, rulesStore, identity: identityFor(owner) });
    const res = await app.inject({
      method: "PUT", url: "/rules", headers: { authorization: "Bearer good" },
      payload: {
        discount: { allowedAuto: true, maxPct: 15, stackable: true },
        ad_spend: { allowedAuto: true, maxUsd: 300, roiFloor: 3, periodBudgetUsd: 1000 },
        refund: { allowedAuto: true, maxUsd: 50, priceMatchMaxUsd: 25 },
        subscription: { allowedAuto: true, subscriptionSelfServe: ["pause", "skip"] },
        campaign: { allowedAuto: false, frequencyCapPerWeek: 2, quietHours: { startHour: 21, endHour: 9 } },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().envelope.discount.stackable).toBe(true);
    expect(res.json().envelope.ad_spend.roiFloor).toBe(3);
    await app.close();
  });
  it("400s a field on the wrong category (stackable on refund)", async () => {
    const state = new InMemoryRuntimeStore();
    const rulesStore = new InMemoryMerchantRulesStore(state);
    const app = await buildServer({ store: state, rulesStore, identity: identityFor(owner) });
    const res = await app.inject({
      method: "PUT", url: "/rules", headers: { authorization: "Bearer good" },
      payload: { refund: { allowedAuto: true, stackable: true } },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
  it("400s a malformed quietHours (hour out of 0–23)", async () => {
    const state = new InMemoryRuntimeStore();
    const rulesStore = new InMemoryMerchantRulesStore(state);
    const app = await buildServer({ store: state, rulesStore, identity: identityFor(owner) });
    const res = await app.inject({
      method: "PUT", url: "/rules", headers: { authorization: "Bearer good" },
      payload: { campaign: { allowedAuto: false, quietHours: { startHour: 30, endHour: 9 } } },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
  it("400s an unknown subscriptionSelfServe value", async () => {
    const state = new InMemoryRuntimeStore();
    const rulesStore = new InMemoryMerchantRulesStore(state);
    const app = await buildServer({ store: state, rulesStore, identity: identityFor(owner) });
    const res = await app.inject({
      method: "PUT", url: "/rules", headers: { authorization: "Bearer good" },
      payload: { subscription: { allowedAuto: true, subscriptionSelfServe: ["explode"] } },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

// Task 6 (W4-broaden): POST /rules/preview (dry-run) + POST /rules/apply-preset (audited).

describe("POST /rules/preview", () => {
  it("computes before/after/bigJump WITHOUT writing (a subsequent GET is unchanged)", async () => {
    const state = new InMemoryRuntimeStore();
    const rulesStore = new InMemoryMerchantRulesStore(state);
    const app = await buildServer({ store: state, rulesStore, identity: identityFor(manager) });
    const res = await app.inject({
      method: "POST", url: "/rules/preview", headers: { authorization: "Bearer good" },
      payload: { discount: { allowedAuto: true, maxPct: 15 } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().bigJump).toBe(true); // off→on
    expect(res.json().after.discount.allowedAuto).toBe(true);
    // no write happened:
    const get = await app.inject({ method: "GET", url: "/rules", headers: { authorization: "Bearer good" } });
    expect(get.json().envelope.discount.allowedAuto).toBe(false);
    await app.close();
  });

  it("403s a viewer (needs rules.edit)", async () => {
    const state = new InMemoryRuntimeStore();
    const rulesStore = new InMemoryMerchantRulesStore(state);
    const app = await buildServer({ store: state, rulesStore, identity: identityFor(viewer) });
    const res = await app.inject({
      method: "POST", url: "/rules/preview", headers: { authorization: "Bearer good" },
      payload: { discount: { allowedAuto: true } },
    });
    expect(res.statusCode).toBe(403);
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
    const res = await app.inject({ method: "POST", url: "/rules/preview", payload: { discount: { allowedAuto: true } } });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("400s a malformed body and never touches the store", async () => {
    const state = new InMemoryRuntimeStore();
    const rulesStore = new InMemoryMerchantRulesStore(state);
    const app = await buildServer({ store: state, rulesStore, identity: identityFor(owner) });
    const res = await app.inject({
      method: "POST", url: "/rules/preview", headers: { authorization: "Bearer good" },
      payload: { not_a_real_category: { allowedAuto: true } },
    });
    expect(res.statusCode).toBe(400);
    const get = await app.inject({ method: "GET", url: "/rules", headers: { authorization: "Bearer good" } });
    expect(get.json().envelope).toEqual(CONSERVATIVE_DEFAULTS);
    await app.close();
  });

  it("surfaces the EFFECTIVE floor-clamped limit and flags the capped field when the proposal exceeds a PalUp floor", async () => {
    const state = new InMemoryRuntimeStore();
    const rulesStore = new InMemoryMerchantRulesStore(state);
    const app = await buildServer({ store: state, rulesStore, identity: identityFor(owner) });
    const res = await app.inject({
      method: "POST", url: "/rules/preview", headers: { authorization: "Bearer good" },
      payload: { discount: { allowedAuto: true, maxPct: 50 } }, // > PALUP_FLOORS.discount.maxAutoPct (30)
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.after.discount.maxPct).toBe(50); // the raw proposal, unclamped
    expect(body.effective.discount.maxPct).toBe(PALUP_FLOORS.discount.maxAutoPct); // clamped to the floor
    expect(body.capped.discount).toContain("maxPct");
    // still a dry-run:
    const get = await app.inject({ method: "GET", url: "/rules", headers: { authorization: "Bearer good" } });
    expect(get.json().envelope.discount.allowedAuto).toBe(false);
    await app.close();
  });

  it("does not flag a capped field when the proposal is within the floor", async () => {
    const state = new InMemoryRuntimeStore();
    const rulesStore = new InMemoryMerchantRulesStore(state);
    const app = await buildServer({ store: state, rulesStore, identity: identityFor(owner) });
    const res = await app.inject({
      method: "POST", url: "/rules/preview", headers: { authorization: "Bearer good" },
      payload: { discount: { allowedAuto: true, maxPct: 15 } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().capped.discount).toBeUndefined();
    await app.close();
  });
});

describe("POST /rules/apply-preset", () => {
  it("writes the preset envelope, returns bigJump, audits it, and a GET reflects it", async () => {
    const state = new InMemoryRuntimeStore();
    const rulesStore = new InMemoryMerchantRulesStore(state);
    const app = await buildServer({ store: state, rulesStore, identity: identityFor(owner) });
    const res = await app.inject({
      method: "POST", url: "/rules/apply-preset", headers: { authorization: "Bearer good" },
      payload: { presetId: "skincare" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().envelope.discount.maxPct).toBe(15); // skincare preset value
    const audit = await state.readAudit({ tenantId: "t1" });
    expect(audit.some((r) => r.action === "rules.changed")).toBe(true);

    const get = await app.inject({ method: "GET", url: "/rules", headers: { authorization: "Bearer good" } });
    expect(get.json().envelope.discount.maxPct).toBe(15);
    await app.close();
  });

  it("404s an unknown presetId and never touches the store (fail-safe)", async () => {
    const state = new InMemoryRuntimeStore();
    const rulesStore = new InMemoryMerchantRulesStore(state);
    const app = await buildServer({ store: state, rulesStore, identity: identityFor(owner) });
    const res = await app.inject({
      method: "POST", url: "/rules/apply-preset", headers: { authorization: "Bearer good" },
      payload: { presetId: "nope" },
    });
    expect(res.statusCode).toBe(404);

    const get = await app.inject({ method: "GET", url: "/rules", headers: { authorization: "Bearer good" } });
    expect(get.json().envelope).toEqual(CONSERVATIVE_DEFAULTS);
    await app.close();
  });

  it("400s a missing/non-string presetId and never touches the store", async () => {
    const state = new InMemoryRuntimeStore();
    const rulesStore = new InMemoryMerchantRulesStore(state);
    const app = await buildServer({ store: state, rulesStore, identity: identityFor(owner) });
    const res = await app.inject({
      method: "POST", url: "/rules/apply-preset", headers: { authorization: "Bearer good" },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    const get = await app.inject({ method: "GET", url: "/rules", headers: { authorization: "Bearer good" } });
    expect(get.json().envelope).toEqual(CONSERVATIVE_DEFAULTS);
    await app.close();
  });

  it("403s a viewer and an operator (rules.edit is manager+)", async () => {
    const state = new InMemoryRuntimeStore();
    const rulesStore = new InMemoryMerchantRulesStore(state);
    for (const p of [viewer, operator]) {
      const app = await buildServer({ store: state, rulesStore, identity: identityFor(p) });
      const res = await app.inject({
        method: "POST", url: "/rules/apply-preset", headers: { authorization: "Bearer good" },
        payload: { presetId: "skincare" },
      });
      expect(res.statusCode).toBe(403);
      await app.close();
    }
  });

  it("an anonymous caller is 401'd", async () => {
    const state = new InMemoryRuntimeStore();
    const rulesStore = new InMemoryMerchantRulesStore(state);
    const app = await buildServer({
      store: state,
      rulesStore,
      identity: { authenticate: async () => ({ kind: "anonymous" }), authorize: () => false },
    });
    const res = await app.inject({ method: "POST", url: "/rules/apply-preset", payload: { presetId: "skincare" } });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("applies the CONSERVATIVE Day-1 preset without ever auto-enabling anything (allowedAuto:false everywhere)", async () => {
    const state = new InMemoryRuntimeStore();
    const rulesStore = new InMemoryMerchantRulesStore(state);
    const app = await buildServer({ store: state, rulesStore, identity: identityFor(owner) });
    const res = await app.inject({
      method: "POST", url: "/rules/apply-preset", headers: { authorization: "Bearer good" },
      payload: { presetId: "day1-conservative" },
    });
    expect(res.statusCode).toBe(200);
    const envelope = res.json().envelope as Record<string, { allowedAuto: boolean }>;
    for (const cat of Object.keys(envelope)) {
      expect(envelope[cat].allowedAuto).toBe(false);
    }
    await app.close();
  });

  it("tenant isolation: applying a preset for t1 is invisible to t2", async () => {
    const state = new InMemoryRuntimeStore();
    const rulesStore = new InMemoryMerchantRulesStore(state);
    const app = await buildServer({ store: state, rulesStore, identity: identityFor(owner) });
    await app.inject({
      method: "POST", url: "/rules/apply-preset", headers: { authorization: "Bearer good" },
      payload: { presetId: "skincare" },
    });

    const t2Owner: MerchantPrincipal = { ...owner, merchantId: "t2" };
    const appT2 = await buildServer({ store: state, rulesStore, identity: identityFor(t2Owner) });
    const res = await appT2.inject({ method: "GET", url: "/rules", headers: { authorization: "Bearer good" } });
    expect(res.json().envelope).toEqual(CONSERVATIVE_DEFAULTS);

    await app.close();
    await appT2.close();
  });
});
