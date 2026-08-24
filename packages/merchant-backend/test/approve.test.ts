import { describe, it, expect } from "vitest";
import {
  InMemoryRuntimeStore,
  InMemoryProposalStore,
  InMemoryMerchantRulesStore,
  InMemoryLearnedStore,
  SandboxCommsAdapter,
  SandboxCustomerDirectory,
  SandboxRefundAdapter,
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
  REFUND_ACTION_TYPE,
  REFUND_AGENT_TYPE,
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

// W5 Task 8: an agent-proposed refund — mirrors `seedPendingRuleChange` above (no domain-specific
// `proposeXChange` wrapper for refunds either). `rulesStore` here is a fresh `InMemoryMerchantRulesStore`
// with no envelope set, so `CONSERVATIVE_DEFAULTS.refund = { allowedAuto: false }` governs: any
// `issue_refund` — regardless of `usd` — lands `requires_approval`, never auto-executed at propose
// time. The `executor` passed here is a poison stub, same convention as the rule-change helper: proving
// the propose path itself never calls it.
async function seedPendingRefund(state: InMemoryRuntimeStore, proposalStore: InMemoryProposalStore, rulesStore: InMemoryMerchantRulesStore) {
  const ctx = { tenantId: "t1" };
  const now = "2026-08-23T00:00:00Z";
  const action = { type: REFUND_ACTION_TYPE, params: { orderRef: "1001", usd: 25, reason: "damaged item" } };
  const result = await proposeOrExecute(
    {
      ctx,
      agentId: "refund_desk_agent",
      agentType: REFUND_AGENT_TYPE,
      category: "refund",
      rationale: "customer reported a damaged item on order 1001",
      reversalPlan: {
        reversible: false,
        plan: "A refund is not automatically reversible — a disputed refund must be corrected by re-charging the customer through Shopify admin.",
      },
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
  if (!result.proposal) throw new Error("test setup: expected a pending refund proposal");
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

  // W5 Task 8 (money action — CLAUDE.md §3): wiring `issue_refund` -> `refundExecutor(refundPort)`
  // into the SAME registry/route the other agent-proposed action types above use. Proves, via the
  // REAL `POST /approvals/:id/approve` path (never `resolveExecutor` called directly): an approved
  // refund executes the sandbox adapter exactly once, the audit chain carries a reversal path, the
  // kill switch blocks it (423) with no execution, a stale re-approve is a clean 409 (no
  // double-refund), and registering it does not disturb send_campaign/change_voice/change_rules.
  describe("agent-proposed refund (issue_refund / refund)", () => {
    it("owner approves: executes the refund exactly once via the sandbox adapter", async () => {
      const state = new InMemoryRuntimeStore();
      const proposalStore = new InMemoryProposalStore(state);
      const rulesStore = new InMemoryMerchantRulesStore(state);
      const comms = new SandboxCommsAdapter();
      const refundPort = new SandboxRefundAdapter();
      const proposal = await seedPendingRefund(state, proposalStore, rulesStore);

      expect(proposal.status).toBe("pending");
      expect(proposal.category).toBe("refund");
      expect(proposal.action.type).toBe(REFUND_ACTION_TYPE);

      const app = await buildServer({ store: state, identity: identityFor(owner), proposalStore, rulesStore, comms, refundPort });
      const res = await app.inject({
        method: "POST",
        url: `/approvals/${proposal.id}/approve`,
        headers: { authorization: "Bearer good" },
        payload: { version: proposal.version },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe("executed");
      expect(refundPort.issued).toHaveLength(1); // exactly once
      expect(refundPort.issued[0]).toMatchObject({ tenantId: "t1", orderRef: "1001", amountUsd: 25, reason: "damaged item" });

      await app.close();
    });

    it("the audit chain for the executed refund carries a real reversal path (§3 rule 5)", async () => {
      const state = new InMemoryRuntimeStore();
      const proposalStore = new InMemoryProposalStore(state);
      const rulesStore = new InMemoryMerchantRulesStore(state);
      const comms = new SandboxCommsAdapter();
      const refundPort = new SandboxRefundAdapter();
      const proposal = await seedPendingRefund(state, proposalStore, rulesStore);

      const app = await buildServer({ store: state, identity: identityFor(owner), proposalStore, rulesStore, comms, refundPort });
      const res = await app.inject({
        method: "POST",
        url: `/approvals/${proposal.id}/approve`,
        headers: { authorization: "Bearer good" },
        payload: { version: proposal.version },
      });
      expect(res.statusCode).toBe(200);

      const ctx = { tenantId: "t1" };
      const audit = await state.readAudit(ctx);
      const executed = audit.filter((r) => r.action === "proposal.executed");
      expect(executed).toHaveLength(1);
      expect(typeof executed[0]!.reversalPath).toBe("string");
      expect(executed[0]!.reversalPath!.trim().length).toBeGreaterThan(0);
      expect(executed[0]!.reversalPath).toMatch(/re-charg/i);

      // Every step of the approve pipeline (proposal.approved / executing / executed) carries the
      // SAME non-blank reversal path — it comes from the proposal's own `reversalPlan`, not the
      // executor's `ExecutionResult` (which only carries {ok, detail}, no reversalPath field).
      const pipelineSteps = audit.filter((r) => r.action.startsWith("proposal."));
      expect(pipelineSteps.length).toBeGreaterThan(0);
      for (const step of pipelineSteps) {
        expect(typeof step.reversalPath).toBe("string");
        expect(step.reversalPath!.trim().length).toBeGreaterThan(0);
      }

      await app.close();
    });

    it("a killed merchant gets 423 on approve — the refund is never issued", async () => {
      const state = new InMemoryRuntimeStore();
      const proposalStore = new InMemoryProposalStore(state);
      const rulesStore = new InMemoryMerchantRulesStore(state);
      const comms = new SandboxCommsAdapter();
      const refundPort = new SandboxRefundAdapter();
      const proposal = await seedPendingRefund(state, proposalStore, rulesStore);

      await killMerchant(state, { tenantId: "t1" }, "test halt");

      const app = await buildServer({ store: state, identity: identityFor(owner), proposalStore, rulesStore, comms, refundPort });
      const res = await app.inject({
        method: "POST",
        url: `/approvals/${proposal.id}/approve`,
        headers: { authorization: "Bearer good" },
        payload: { version: proposal.version },
      });
      expect(res.statusCode).toBe(423);
      expect(res.json().error).toMatch(/kill/i);
      expect(refundPort.issued).toHaveLength(0);

      await app.close();
    });

    it("approving a second time (already executed, stale version) is a clean 409, not a double-refund", async () => {
      const state = new InMemoryRuntimeStore();
      const proposalStore = new InMemoryProposalStore(state);
      const rulesStore = new InMemoryMerchantRulesStore(state);
      const comms = new SandboxCommsAdapter();
      const refundPort = new SandboxRefundAdapter();
      const proposal = await seedPendingRefund(state, proposalStore, rulesStore);

      const app = await buildServer({ store: state, identity: identityFor(owner), proposalStore, rulesStore, comms, refundPort });
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
      expect(refundPort.issued).toHaveLength(1); // no double-refund

      await app.close();
    });

    it("registering issue_refund alongside it does not disturb send_campaign / change_voice / change_rules: all still execute in the same session", async () => {
      const state = new InMemoryRuntimeStore();
      const proposalStore = new InMemoryProposalStore(state);
      const rulesStore = new InMemoryMerchantRulesStore(state);
      const comms = new SandboxCommsAdapter();
      const learnedStore = new InMemoryLearnedStore(state);
      const refundPort = new SandboxRefundAdapter();

      const refundProposal = await seedPendingRefund(state, proposalStore, rulesStore);
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

      const app = await buildServer({ store: state, identity: identityFor(owner), proposalStore, rulesStore, comms, learnedStore, refundPort });

      const refundRes = await app.inject({
        method: "POST",
        url: `/approvals/${refundProposal.id}/approve`,
        headers: { authorization: "Bearer good" },
        payload: { version: refundProposal.version },
      });
      expect(refundRes.statusCode).toBe(200);
      expect(refundRes.json().status).toBe("executed");
      expect(refundPort.issued).toHaveLength(1);

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

      // Refund still exactly once after the other three executed alongside it.
      expect(refundPort.issued).toHaveLength(1);

      await app.close();
    });
  });
});
