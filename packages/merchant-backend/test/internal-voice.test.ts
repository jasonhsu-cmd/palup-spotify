import { describe, it, expect } from "vitest";
import {
  InMemoryRuntimeStore,
  InMemoryProposalStore,
  InMemoryMerchantRulesStore,
  InMemoryLearnedStore,
  type MerchantIdentityPort,
  type MerchantPrincipal,
} from "@palup/platform-ports";
import { buildServer } from "../src/server.js";

// W3 Task 6: the agent-proposes/merchant-owns-voice staging trigger route. Registered inside
// server.ts's authenticated `merchantPlane` context (F3), so route-protection.test.ts already proves
// the no-token path 401s; this suite covers the RBAC + governance contract this route adds on top of
// that — the whole point of Task 6: PROPOSING never writes, only APPROVING does.

const owner: MerchantPrincipal = {
  kind: "merchant_user", merchantId: "t1", userId: "u1", role: "owner", authLevel: "session", sessionId: "s1",
};
const viewer: MerchantPrincipal = { ...owner, role: "viewer" };

const identityFor = (p: MerchantPrincipal): MerchantIdentityPort => ({
  authenticate: async (cred) => (cred === "good" ? p : { kind: "anonymous" }),
  authorize: () => true,
});

describe("POST /_internal/propose-voice", () => {
  it("an owner proposes a voice change: lands one pending autonomy_scope proposal, writes NO voice insight", async () => {
    const state = new InMemoryRuntimeStore();
    const proposalStore = new InMemoryProposalStore(state);
    const rulesStore = new InMemoryMerchantRulesStore(state);
    const learnedStore = new InMemoryLearnedStore(state);

    const app = await buildServer({
      store: state, identity: identityFor(owner), proposalStore, rulesStore, learnedStore,
    });

    const res = await app.inject({
      method: "POST",
      url: "/_internal/propose-voice",
      headers: { authorization: "Bearer good" },
      payload: { proposedVoiceText: "Warmer, no exclamation marks", rationale: "chat signals" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.proposedId).toBe("string");

    const list = await proposalStore.list({ tenantId: "t1" });
    expect(list.items).toHaveLength(1);
    expect(list.items[0]?.id).toBe(body.proposedId);
    expect(list.items[0]?.status).toBe("pending");
    expect(list.items[0]?.category).toBe("autonomy_scope");
    expect(list.items[0]?.tenantId).toBe("t1");

    // It appears in the real Approval Center read surface, filterable by category.
    const approvalsRes = await app.inject({
      method: "GET",
      url: "/approvals?category=autonomy_scope",
      headers: { authorization: "Bearer good" },
    });
    expect(approvalsRes.statusCode).toBe(200);
    const approvalsBody = approvalsRes.json();
    expect(approvalsBody.items).toHaveLength(1);
    expect(approvalsBody.items[0].id).toBe(body.proposedId);

    // No voice insight written yet — the merchant hasn't approved.
    expect(await learnedStore.list({ tenantId: "t1" }, { category: "voice" })).toEqual([]);

    await app.close();
  });

  it("writes the voice insight exactly once, only after a human approves via the real API", async () => {
    const state = new InMemoryRuntimeStore();
    const proposalStore = new InMemoryProposalStore(state);
    const rulesStore = new InMemoryMerchantRulesStore(state);
    const learnedStore = new InMemoryLearnedStore(state);

    const app = await buildServer({
      store: state, identity: identityFor(owner), proposalStore, rulesStore, learnedStore,
    });

    const proposeRes = await app.inject({
      method: "POST",
      url: "/_internal/propose-voice",
      headers: { authorization: "Bearer good" },
      payload: { proposedVoiceText: "Warmer, no exclamation marks", rationale: "chat signals" },
    });
    const { proposedId } = proposeRes.json();

    // Still nothing before approval.
    expect(await learnedStore.list({ tenantId: "t1" }, { category: "voice" })).toEqual([]);

    const approveRes = await app.inject({
      method: "POST",
      url: `/approvals/${proposedId}/approve`,
      headers: { authorization: "Bearer good" },
      payload: { version: 0 },
    });
    expect(approveRes.statusCode).toBe(200);
    expect(approveRes.json().status).toBe("executed");

    const voice = await learnedStore.list({ tenantId: "t1" }, { category: "voice" });
    expect(voice).toHaveLength(1);
    expect(voice[0].text).toBe("Warmer, no exclamation marks");
    expect(voice[0].origin).toBe("synthesized");

    await app.close();
  });

  it("a viewer is forbidden — the route requires agent.operate", async () => {
    const state = new InMemoryRuntimeStore();
    const app = await buildServer({ store: state, identity: identityFor(viewer) });

    const res = await app.inject({
      method: "POST",
      url: "/_internal/propose-voice",
      headers: { authorization: "Bearer good" },
      payload: { proposedVoiceText: "Warmer" },
    });
    expect(res.statusCode).toBe(403);

    await app.close();
  });

  it("an anonymous caller is 401'd before RBAC is even evaluated", async () => {
    const state = new InMemoryRuntimeStore();
    const app = await buildServer({
      store: state,
      identity: { authenticate: async () => ({ kind: "anonymous" }), authorize: () => false },
    });

    const res = await app.inject({ method: "POST", url: "/_internal/propose-voice" });
    expect(res.statusCode).toBe(401);

    await app.close();
  });

  it("rejects a missing proposedVoiceText with 400 — never silently proposes an empty change", async () => {
    const state = new InMemoryRuntimeStore();
    const app = await buildServer({ store: state, identity: identityFor(owner) });

    const res = await app.inject({
      method: "POST",
      url: "/_internal/propose-voice",
      headers: { authorization: "Bearer good" },
      payload: {},
    });
    expect(res.statusCode).toBe(400);

    await app.close();
  });
});
