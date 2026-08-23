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
import { findLapsedSegment, draftWinBack, proposeWinBack, createRulesProvider, campaignExecutor } from "@palup/agent-runtime";
import { buildServer } from "../src/server.js";

// Task 4 (W1-API): POST /approvals/:id/reject. Seeds a real pending `campaign` proposal via
// `proposeWinBack`, same pattern as approve.test.ts, so the route is exercised against the real
// `rejectProposal` engine function, not a hand-rolled fixture.

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

describe("POST /approvals/:id/reject", () => {
  it("requires a non-empty reason: blank body -> 400", async () => {
    const state = new InMemoryRuntimeStore();
    const proposalStore = new InMemoryProposalStore(state);
    const rulesStore = new InMemoryMerchantRulesStore(state);
    const comms = new SandboxCommsAdapter();
    const proposal = await seedPendingCampaign(state, proposalStore, rulesStore, comms);

    const app = await buildServer({ store: state, identity: identityFor(owner), proposalStore, rulesStore, comms });
    const res = await app.inject({
      method: "POST",
      url: `/approvals/${proposal.id}/reject`,
      headers: { authorization: "Bearer good" },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("requires a non-empty reason: whitespace-only -> 400", async () => {
    const state = new InMemoryRuntimeStore();
    const proposalStore = new InMemoryProposalStore(state);
    const rulesStore = new InMemoryMerchantRulesStore(state);
    const comms = new SandboxCommsAdapter();
    const proposal = await seedPendingCampaign(state, proposalStore, rulesStore, comms);

    const app = await buildServer({ store: state, identity: identityFor(owner), proposalStore, rulesStore, comms });
    const res = await app.inject({
      method: "POST",
      url: `/approvals/${proposal.id}/reject`,
      headers: { authorization: "Bearer good" },
      payload: { reason: "   " },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("owner rejects a pending proposal: 200, status rejected, note set, audited, blocks a later approve", async () => {
    const state = new InMemoryRuntimeStore();
    const proposalStore = new InMemoryProposalStore(state);
    const rulesStore = new InMemoryMerchantRulesStore(state);
    const comms = new SandboxCommsAdapter();
    const proposal = await seedPendingCampaign(state, proposalStore, rulesStore, comms);

    const app = await buildServer({ store: state, identity: identityFor(owner), proposalStore, rulesStore, comms });
    const res = await app.inject({
      method: "POST",
      url: `/approvals/${proposal.id}/reject`,
      headers: { authorization: "Bearer good" },
      payload: { reason: "off-brand" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("rejected");
    expect(body.decisionNote).toBe("off-brand");

    // an audit row exists for the rejection
    const audit = await state.readAudit({ tenantId: "t1" });
    expect(audit.some((r) => r.action === "proposal.rejected")).toBe(true);

    // a later approve fails cleanly (not pending anymore) rather than 500ing
    const approveRes = await app.inject({
      method: "POST",
      url: `/approvals/${proposal.id}/approve`,
      headers: { authorization: "Bearer good" },
      payload: { version: body.version },
    });
    expect(approveRes.statusCode).toBeGreaterThanOrEqual(400);
    expect(approveRes.statusCode).toBeLessThan(500);
    expect(comms.recorded).toHaveLength(0);

    await app.close();
  });

  it("admin (not just owner) can reject — approve_money is owner+admin", async () => {
    const state = new InMemoryRuntimeStore();
    const proposalStore = new InMemoryProposalStore(state);
    const rulesStore = new InMemoryMerchantRulesStore(state);
    const comms = new SandboxCommsAdapter();
    const proposal = await seedPendingCampaign(state, proposalStore, rulesStore, comms);

    const app = await buildServer({ store: state, identity: identityFor(admin), proposalStore, rulesStore, comms });
    const res = await app.inject({
      method: "POST",
      url: `/approvals/${proposal.id}/reject`,
      headers: { authorization: "Bearer good" },
      payload: { reason: "budget" },
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
        url: `/approvals/${proposal.id}/reject`,
        headers: { authorization: "Bearer good" },
        payload: { reason: "no" },
      });
      expect(res.statusCode).toBe(403);
      await app.close();
    },
  );

  it("404s for a missing proposal id", async () => {
    const state = new InMemoryRuntimeStore();
    const proposalStore = new InMemoryProposalStore(state);
    const app = await buildServer({ store: state, identity: identityFor(owner), proposalStore });
    const res = await app.inject({
      method: "POST",
      url: "/approvals/does-not-exist/reject",
      headers: { authorization: "Bearer good" },
      payload: { reason: "no" },
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
      url: `/approvals/${proposal.id}/reject`,
      headers: { authorization: "Bearer good" },
      payload: { reason: "no" },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("rejecting an already-rejected proposal fails cleanly (not a 500)", async () => {
    const state = new InMemoryRuntimeStore();
    const proposalStore = new InMemoryProposalStore(state);
    const rulesStore = new InMemoryMerchantRulesStore(state);
    const comms = new SandboxCommsAdapter();
    const proposal = await seedPendingCampaign(state, proposalStore, rulesStore, comms);

    const app = await buildServer({ store: state, identity: identityFor(owner), proposalStore, rulesStore, comms });
    const first = await app.inject({
      method: "POST",
      url: `/approvals/${proposal.id}/reject`,
      headers: { authorization: "Bearer good" },
      payload: { reason: "off-brand" },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: "POST",
      url: `/approvals/${proposal.id}/reject`,
      headers: { authorization: "Bearer good" },
      payload: { reason: "again" },
    });
    expect(second.statusCode).toBeGreaterThanOrEqual(400);
    expect(second.statusCode).toBeLessThan(500);
    await app.close();
  });

  it("an anonymous caller is 401'd before RBAC is even evaluated", async () => {
    const state = new InMemoryRuntimeStore();
    const app = await buildServer({ store: state, identity: { authenticate: async () => ({ kind: "anonymous" }), authorize: () => false } });
    const res = await app.inject({ method: "POST", url: "/approvals/x/reject", payload: { reason: "no" } });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
