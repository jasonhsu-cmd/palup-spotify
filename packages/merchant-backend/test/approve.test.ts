import { describe, it, expect } from "vitest";
import {
  InMemoryRuntimeStore,
  InMemoryProposalStore,
  InMemoryMerchantRulesStore,
  SandboxCommsAdapter,
  SandboxCustomerDirectory,
  type MerchantIdentityPort,
  type MerchantPrincipal,
} from "@palup/platform-ports";
import { killMerchant, findLapsedSegment, draftWinBack, proposeWinBack, createRulesProvider, campaignExecutor } from "@palup/agent-runtime";
import { buildServer } from "../src/server.js";

// Task 3 (W1-API): POST /approvals/:id/approve. Seeds a real pending `campaign` proposal via
// `proposeWinBack` (against the SAME injected deps the route itself will resolve through
// `buildEngineDeps`), so this exercises the real `executeApproved` path end to end — not a
// hand-rolled Proposal fixture with an action type nothing else in this suite ever executes.

const owner: MerchantPrincipal = { kind: "merchant_user", merchantId: "t1", userId: "u1", role: "owner", authLevel: "session", sessionId: "s1" };
const viewer: MerchantPrincipal = { ...owner, role: "viewer" };
const operator: MerchantPrincipal = { ...owner, role: "operator" };
const manager: MerchantPrincipal = { ...owner, role: "manager" };
const admin: MerchantPrincipal = { ...owner, role: "admin" };

const identityFor = (p: MerchantPrincipal): MerchantIdentityPort => ({
  authenticate: async (cred) => (cred === "good" ? p : { kind: "anonymous" }),
  authorize: () => true,
});

async function seedPendingCampaign(state: InMemoryRuntimeStore, proposalStore: InMemoryProposalStore, rulesStore: InMemoryMerchantRulesStore, comms: SandboxCommsAdapter) {
  const commerce = new SandboxCustomerDirectory({
    t1: [{ customerId: "c1", contact: "c1@x.com", lastOrderAt: "2020-01-01T00:00:00Z" }],
  });
  const ctx = { tenantId: "t1" };
  const now = "2026-08-23T00:00:00Z";
  const segment = await findLapsedSegment(commerce, ctx, { lapsedDays: 60, now });
  const draft = draftWinBack(segment, "t1");
  const result = await proposeWinBack(
    { segment, draft, ctx, now },
    {
      store: proposalStore,
      state,
      rules: createRulesProvider(rulesStore),
      executor: campaignExecutor(comms),
      validate: async () => ({ valid: true }),
    },
  );
  if (!result.proposal) throw new Error("test setup: expected a pending proposal");
  return result.proposal;
}

describe("POST /approvals/:id/approve", () => {
  it("owner approves a pending campaign proposal: executes, sends, returns the executed proposal", async () => {
    const state = new InMemoryRuntimeStore();
    const proposalStore = new InMemoryProposalStore(state);
    const rulesStore = new InMemoryMerchantRulesStore(state);
    const comms = new SandboxCommsAdapter();
    const proposal = await seedPendingCampaign(state, proposalStore, rulesStore, comms);

    const app = await buildServer({ store: state, identity: identityFor(owner), proposalStore, rulesStore, comms });
    const res = await app.inject({
      method: "POST",
      url: `/approvals/${proposal.id}/approve`,
      headers: { authorization: "Bearer good" },
      payload: { version: proposal.version },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("executed");
    expect(comms.recorded).toHaveLength(1);
    await app.close();
  });

  it("admin (not just owner) can approve — approve_money is owner+admin", async () => {
    const state = new InMemoryRuntimeStore();
    const proposalStore = new InMemoryProposalStore(state);
    const rulesStore = new InMemoryMerchantRulesStore(state);
    const comms = new SandboxCommsAdapter();
    const proposal = await seedPendingCampaign(state, proposalStore, rulesStore, comms);

    const app = await buildServer({ store: state, identity: identityFor(admin), proposalStore, rulesStore, comms });
    const res = await app.inject({
      method: "POST",
      url: `/approvals/${proposal.id}/approve`,
      headers: { authorization: "Bearer good" },
      payload: { version: proposal.version },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it.each([["viewer", viewer], ["operator", operator], ["manager", manager]] as const)(
    "%s is forbidden (403) — approve_money is owner+admin only",
    async (_label, principal) => {
      const state = new InMemoryRuntimeStore();
      const proposalStore = new InMemoryProposalStore(state);
      const rulesStore = new InMemoryMerchantRulesStore(state);
      const comms = new SandboxCommsAdapter();
      const proposal = await seedPendingCampaign(state, proposalStore, rulesStore, comms);

      const app = await buildServer({ store: state, identity: identityFor(principal), proposalStore, rulesStore, comms });
      const res = await app.inject({
        method: "POST",
        url: `/approvals/${proposal.id}/approve`,
        headers: { authorization: "Bearer good" },
        payload: { version: proposal.version },
      });
      expect(res.statusCode).toBe(403);
      expect(comms.recorded).toHaveLength(0);
      await app.close();
    },
  );

  it("a stale version returns 409 and does not execute", async () => {
    const state = new InMemoryRuntimeStore();
    const proposalStore = new InMemoryProposalStore(state);
    const rulesStore = new InMemoryMerchantRulesStore(state);
    const comms = new SandboxCommsAdapter();
    const proposal = await seedPendingCampaign(state, proposalStore, rulesStore, comms);

    const app = await buildServer({ store: state, identity: identityFor(owner), proposalStore, rulesStore, comms });
    const res = await app.inject({
      method: "POST",
      url: `/approvals/${proposal.id}/approve`,
      headers: { authorization: "Bearer good" },
      payload: { version: proposal.version + 1 },
    });
    expect(res.statusCode).toBe(409);
    expect(comms.recorded).toHaveLength(0);

    // and the real version is still executable afterward
    const res2 = await app.inject({
      method: "POST",
      url: `/approvals/${proposal.id}/approve`,
      headers: { authorization: "Bearer good" },
      payload: { version: proposal.version },
    });
    expect(res2.statusCode).toBe(200);
    await app.close();
  });

  it("approving a second time (already executed, stale version) is a clean 409, not a double-send", async () => {
    const state = new InMemoryRuntimeStore();
    const proposalStore = new InMemoryProposalStore(state);
    const rulesStore = new InMemoryMerchantRulesStore(state);
    const comms = new SandboxCommsAdapter();
    const proposal = await seedPendingCampaign(state, proposalStore, rulesStore, comms);

    const app = await buildServer({ store: state, identity: identityFor(owner), proposalStore, rulesStore, comms });
    const first = await app.inject({
      method: "POST",
      url: `/approvals/${proposal.id}/approve`,
      headers: { authorization: "Bearer good" },
      payload: { version: proposal.version },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: "POST",
      url: `/approvals/${proposal.id}/approve`,
      headers: { authorization: "Bearer good" },
      payload: { version: proposal.version }, // stale — the stored row moved on
    });
    expect(second.statusCode).toBe(409);
    expect(comms.recorded).toHaveLength(1); // no double-send
    await app.close();
  });

  it("a killed merchant gets 423 on approve, with no execution", async () => {
    const state = new InMemoryRuntimeStore();
    const proposalStore = new InMemoryProposalStore(state);
    const rulesStore = new InMemoryMerchantRulesStore(state);
    const comms = new SandboxCommsAdapter();
    const proposal = await seedPendingCampaign(state, proposalStore, rulesStore, comms);

    await killMerchant(state, { tenantId: "t1" }, "test halt");

    const app = await buildServer({ store: state, identity: identityFor(owner), proposalStore, rulesStore, comms });
    const res = await app.inject({
      method: "POST",
      url: `/approvals/${proposal.id}/approve`,
      headers: { authorization: "Bearer good" },
      payload: { version: proposal.version },
    });
    expect(res.statusCode).toBe(423);
    expect(res.json().error).toMatch(/kill/i);
    expect(comms.recorded).toHaveLength(0);
    await app.close();
  });

  it("404s for a missing proposal id", async () => {
    const state = new InMemoryRuntimeStore();
    const proposalStore = new InMemoryProposalStore(state);
    const app = await buildServer({ store: state, identity: identityFor(owner), proposalStore });
    const res = await app.inject({
      method: "POST",
      url: "/approvals/does-not-exist/approve",
      headers: { authorization: "Bearer good" },
      payload: { version: 0 },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("404s for a cross-tenant proposal id — never leaks it exists", async () => {
    const state = new InMemoryRuntimeStore();
    const proposalStore = new InMemoryProposalStore(state);
    const rulesStore = new InMemoryMerchantRulesStore(state);
    const comms = new SandboxCommsAdapter();
    const proposal = await seedPendingCampaign(state, proposalStore, rulesStore, comms); // tenant t1

    const ownerT2: MerchantPrincipal = { ...owner, merchantId: "t2" };
    const app = await buildServer({ store: state, identity: identityFor(ownerT2), proposalStore, rulesStore, comms });
    const res = await app.inject({
      method: "POST",
      url: `/approvals/${proposal.id}/approve`,
      headers: { authorization: "Bearer good" },
      payload: { version: proposal.version },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("an anonymous caller is 401'd before RBAC is even evaluated", async () => {
    const state = new InMemoryRuntimeStore();
    const app = await buildServer({ store: state, identity: { authenticate: async () => ({ kind: "anonymous" }), authorize: () => false } });
    const res = await app.inject({ method: "POST", url: "/approvals/x/approve", payload: { version: 0 } });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
