import { describe, it, expect } from "vitest";
import {
  InMemoryRuntimeStore,
  InMemoryProposalStore,
  InMemoryMerchantRulesStore,
  InMemoryLearnedStore,
  SandboxCommsAdapter,
  SandboxCustomerDirectory,
  type MerchantIdentityPort,
  type MerchantPrincipal,
  type ProposalStore,
} from "@palup/platform-ports";
import {
  killMerchant,
  findLapsedSegment,
  draftWinBack,
  proposeWinBack,
  createRulesProvider,
  campaignExecutor,
  proposeOrExecute,
  buildRuleChangeAction,
  proposeVoiceChange,
} from "@palup/agent-runtime";
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

// W4-broaden Task 7: an agent-proposed rule change — mirrors `seedPendingCampaign` above, but there
// is no domain-specific `proposeXChange` wrapper for rule changes (unlike win-back/voice), so this
// calls `proposeOrExecute` directly with `buildRuleChangeAction`'s action, exactly as a future
// rule-broadening agent would. `category: "autonomy_scope"` is what the caller believes; the real
// governance guarantee is that `classifyAction` (invariant 2 — `change_rules` is unmapped in
// `ACTION_TYPE_CATEGORY`) independently re-derives `autonomy_scope` regardless, so this always lands
// PENDING, never executed at propose time. The `executor` passed here is a poison stub — proving the
// propose path itself never calls it (a `requires_approval` classification never reaches `executor`).
async function seedPendingRuleChange(state: InMemoryRuntimeStore, proposalStore: InMemoryProposalStore, rulesStore: InMemoryMerchantRulesStore) {
  const ctx = { tenantId: "t1" };
  const now = "2026-08-23T00:00:00Z";
  const action = buildRuleChangeAction({ discount: { allowedAuto: true, maxPct: 25 } });
  const result = await proposeOrExecute(
    {
      ctx,
      agentId: "win_back_agent",
      agentType: "win_back",
      category: "autonomy_scope",
      rationale: "agent proposes widening the discount auto-act envelope",
      reversalPlan: { reversible: true, plan: "MerchantRulesStore.set restores the prior envelope for tenant t1" },
      now,
      action,
    },
    {
      store: proposalStore,
      state,
      rules: createRulesProvider(rulesStore),
      executor: async () => {
        throw new Error("test setup: propose path must never call the executor");
      },
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

  // C2 (§3 concurrency hardening): two REAL concurrent approves for the SAME pending proposal, both
  // submitted with the (correct, at-the-time) version — `Promise.all`, no `await` in between, so
  // both requests are in flight at once, not sequential. Exactly one must land 200 (and the executor
  // must run EXACTLY once); the other must fail cleanly (409), never a second send.
  it("two concurrent approves for the same pending proposal: exactly one 200, executor runs exactly once", async () => {
    const state = new InMemoryRuntimeStore();
    const proposalStore = new InMemoryProposalStore(state);
    const rulesStore = new InMemoryMerchantRulesStore(state);
    const comms = new SandboxCommsAdapter();
    const proposal = await seedPendingCampaign(state, proposalStore, rulesStore, comms);

    const app = await buildServer({ store: state, identity: identityFor(owner), proposalStore, rulesStore, comms });

    const approve = () =>
      app.inject({
        method: "POST",
        url: `/approvals/${proposal.id}/approve`,
        headers: { authorization: "Bearer good" },
        payload: { version: proposal.version },
      });

    const [a, b] = await Promise.all([approve(), approve()]);
    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes).toEqual([200, 409]);
    expect(comms.recorded).toHaveLength(1); // the executor (campaignExecutor -> comms.send) ran ONCE

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

  // Regression test (coordinator's 2nd-pass review): the FIRST version of `server.ts`'s
  // `setErrorHandler` redacted UNCONDITIONALLY to 500 — which also clobbered a legitimate
  // Fastify-native 4xx (malformed JSON body -> `FST_ERR_CTP_INVALID_JSON_BODY`, a real 400) into a
  // misleading 500. A malformed body must still 400, not 500 — and must never leak `err.message`.
  it("a malformed JSON body -> 400 (not 500), no message leaked", async () => {
    const state = new InMemoryRuntimeStore();
    const app = await buildServer({ store: state, identity: identityFor(owner) });

    const res = await app.inject({
      method: "POST",
      url: "/approvals/any-id/approve",
      headers: { authorization: "Bearer good", "content-type": "application/json" },
      payload: "{not valid json",
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.message).toBeUndefined();
    expect(typeof body.error).toBe("string");
    await app.close();
  });

  // Companion case: a GENUINE unclassified failure (not one of the typed §3 errors) must still
  // redact to a message-free 500 — the setErrorHandler fix for the 4xx case above must not have
  // reopened the original C1 info leak for the 5xx case.
  it("a genuine unclassified store failure -> 500, no message leaked", async () => {
    const state = new InMemoryRuntimeStore();
    const throwingStore: ProposalStore = {
      async create() {
        throw new Error("should not be called");
      },
      async get() {
        throw new Error("db connection lost: internal detail that must never reach the client");
      },
      async list() {
        return { items: [] };
      },
      async transition() {
        throw new Error("should not be called");
      },
    };
    const app = await buildServer({ store: state, identity: identityFor(owner), proposalStore: throwingStore });

    const res = await app.inject({
      method: "POST",
      url: "/approvals/any-id/approve",
      headers: { authorization: "Bearer good" },
      payload: { version: 0 },
    });
    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body.message).toBeUndefined();
    expect(JSON.stringify(body)).not.toMatch(/db connection lost/);
    await app.close();
  });

  // W4-broaden Task 7 (governance keystone): an agent-proposed rule change never applies until a
  // human approves it via THIS SAME route, and applying it does not disturb the existing
  // send_campaign/change_voice executors registered alongside it in engine-wiring.ts.
  describe("agent-proposed rule change (change_rules / autonomy_scope)", () => {
    it("stays PENDING and leaves the rule envelope untouched until approved", async () => {
      const state = new InMemoryRuntimeStore();
      const proposalStore = new InMemoryProposalStore(state);
      const rulesStore = new InMemoryMerchantRulesStore(state);
      const proposal = await seedPendingRuleChange(state, proposalStore, rulesStore);

      expect(proposal.status).toBe("pending");
      expect(proposal.category).toBe("autonomy_scope");
      expect(proposal.action.type).toBe("change_rules");
      const ctx = { tenantId: "t1" };
      const before = await rulesStore.get(ctx);
      expect(before.discount?.allowedAuto).toBe(false); // CONSERVATIVE_DEFAULTS — unchanged
    });

    it("owner approves: applies the patch exactly once, with agent_proposed provenance + audit", async () => {
      const state = new InMemoryRuntimeStore();
      const proposalStore = new InMemoryProposalStore(state);
      const rulesStore = new InMemoryMerchantRulesStore(state);
      const comms = new SandboxCommsAdapter();
      const proposal = await seedPendingRuleChange(state, proposalStore, rulesStore);

      const app = await buildServer({ store: state, identity: identityFor(owner), proposalStore, rulesStore, comms });
      const res = await app.inject({
        method: "POST",
        url: `/approvals/${proposal.id}/approve`,
        headers: { authorization: "Bearer good" },
        payload: { version: proposal.version },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe("executed");

      const ctx = { tenantId: "t1" };
      const envelope = await rulesStore.get(ctx);
      expect(envelope.discount).toEqual({ allowedAuto: true, maxPct: 25 });

      const audit = await state.readAudit(ctx);
      const changed = audit.filter((r) => r.action === "rules.changed");
      expect(changed).toHaveLength(1); // applied exactly once
      expect((changed[0]!.input as { provenance: string }).provenance).toBe("agent_proposed");

      await app.close();
    });

    it("approving a second time (already executed, stale version) does not double-apply", async () => {
      const state = new InMemoryRuntimeStore();
      const proposalStore = new InMemoryProposalStore(state);
      const rulesStore = new InMemoryMerchantRulesStore(state);
      const comms = new SandboxCommsAdapter();
      const proposal = await seedPendingRuleChange(state, proposalStore, rulesStore);

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

      const ctx = { tenantId: "t1" };
      const audit = await state.readAudit(ctx);
      expect(audit.filter((r) => r.action === "rules.changed")).toHaveLength(1); // still exactly once

      await app.close();
    });

    it("a killed merchant gets 423 on approve — the rule change is never applied", async () => {
      const state = new InMemoryRuntimeStore();
      const proposalStore = new InMemoryProposalStore(state);
      const rulesStore = new InMemoryMerchantRulesStore(state);
      const comms = new SandboxCommsAdapter();
      const proposal = await seedPendingRuleChange(state, proposalStore, rulesStore);

      await killMerchant(state, { tenantId: "t1" }, "test halt");

      const app = await buildServer({ store: state, identity: identityFor(owner), proposalStore, rulesStore, comms });
      const res = await app.inject({
        method: "POST",
        url: `/approvals/${proposal.id}/approve`,
        headers: { authorization: "Bearer good" },
        payload: { version: proposal.version },
      });
      expect(res.statusCode).toBe(423);

      const ctx = { tenantId: "t1" };
      const envelope = await rulesStore.get(ctx);
      expect(envelope.discount?.allowedAuto).toBe(false); // never applied

      await app.close();
    });

    it("a rejected rule-change proposal cannot later be approved — never applied", async () => {
      const state = new InMemoryRuntimeStore();
      const proposalStore = new InMemoryProposalStore(state);
      const rulesStore = new InMemoryMerchantRulesStore(state);
      const comms = new SandboxCommsAdapter();
      const proposal = await seedPendingRuleChange(state, proposalStore, rulesStore);

      const app = await buildServer({ store: state, identity: identityFor(owner), proposalStore, rulesStore, comms });
      const rejectRes = await app.inject({
        method: "POST",
        url: `/approvals/${proposal.id}/reject`,
        headers: { authorization: "Bearer good" },
        payload: { reason: "not now" },
      });
      expect(rejectRes.statusCode).toBe(200);

      const approveRes = await app.inject({
        method: "POST",
        url: `/approvals/${proposal.id}/approve`,
        headers: { authorization: "Bearer good" },
        payload: { version: proposal.version + 1 }, // reject bumped the version
      });
      expect(approveRes.statusCode).toBe(409);

      const ctx = { tenantId: "t1" };
      const envelope = await rulesStore.get(ctx);
      expect(envelope.discount?.allowedAuto).toBe(false); // never applied

      await app.close();
    });

    it("registering change_rules alongside it does not disturb send_campaign or change_voice: both still execute in the same session", async () => {
      const state = new InMemoryRuntimeStore();
      const proposalStore = new InMemoryProposalStore(state);
      const rulesStore = new InMemoryMerchantRulesStore(state);
      const comms = new SandboxCommsAdapter();
      const learnedStore = new InMemoryLearnedStore(state);

      const ruleProposal = await seedPendingRuleChange(state, proposalStore, rulesStore);
      const campaignProposal = await seedPendingCampaign(state, proposalStore, rulesStore, comms);
      const voiceResult = await proposeVoiceChange(
        { ctx: { tenantId: "t1" }, now: "2026-08-23T00:00:00Z", proposedVoiceText: "be extra warm", rationale: "learned from transcripts" },
        {
          store: proposalStore,
          state,
          rules: createRulesProvider(rulesStore),
          executor: async () => {
            throw new Error("test setup: propose path must never call the executor");
          },
          validate: async () => ({ valid: true }),
        },
      );
      if (!voiceResult.proposal) throw new Error("test setup: expected a pending voice proposal");

      const app = await buildServer({ store: state, identity: identityFor(owner), proposalStore, rulesStore, comms, learnedStore });

      const ruleRes = await app.inject({
        method: "POST",
        url: `/approvals/${ruleProposal.id}/approve`,
        headers: { authorization: "Bearer good" },
        payload: { version: ruleProposal.version },
      });
      expect(ruleRes.statusCode).toBe(200);
      expect(ruleRes.json().status).toBe("executed");

      const campaignRes = await app.inject({
        method: "POST",
        url: `/approvals/${campaignProposal.id}/approve`,
        headers: { authorization: "Bearer good" },
        payload: { version: campaignProposal.version },
      });
      expect(campaignRes.statusCode).toBe(200);
      expect(campaignRes.json().status).toBe("executed");
      expect(comms.recorded).toHaveLength(1);

      const voiceRes = await app.inject({
        method: "POST",
        url: `/approvals/${voiceResult.proposal.id}/approve`,
        headers: { authorization: "Bearer good" },
        payload: { version: voiceResult.proposal.version },
      });
      expect(voiceRes.statusCode).toBe(200);
      expect(voiceRes.json().status).toBe("executed");

      const ctx = { tenantId: "t1" };
      const envelope = await rulesStore.get(ctx);
      expect(envelope.discount).toEqual({ allowedAuto: true, maxPct: 25 });

      await app.close();
    });
  });
});
