import { describe, it, expect, vi } from "vitest";
import { InMemoryProposalStore, InMemoryRuntimeStore } from "@palup/platform-ports";
import { proposeOrExecute, executeApproved, rejectProposal, expireStale, withdrawProposal } from "../src/loop.js";

const ctx = { tenantId: "t1" };

const mkDeps = (over = {}) => {
  const state = new InMemoryRuntimeStore();
  return {
    store: new InMemoryProposalStore(state),
    state,
    rules: {
      async autoActLimit() {
        return { maxPct: 15, allowedAuto: true };
      },
      palupFloor() {
        return { maxAutoPct: 30, massSendRecipientFloor: 500 };
      },
    },
    executor: vi.fn(async () => ({ ok: true, detail: "done" })),
    validate: vi.fn(async () => ({ valid: true })),
    ...over,
  };
};

const seedPending = async (deps: any, over = {}) =>
  (
    await proposeOrExecute(
      {
        ctx,
        agentId: "a",
        agentType: "win_back",
        category: "discount",
        rationale: "r",
        reversalPlan: { reversible: true, plan: "u" },
        now: "2026-08-23T00:00:00Z",
        action: { type: "issue_discount", params: { pct: 25 } },
        ...over,
      },
      deps,
    )
  ).proposal!;

describe("rejectProposal", () => {
  it("audits the rejection and blocks a later approve/execute", async () => {
    const deps = mkDeps();
    const p = await seedPending(deps);
    const rejected = await rejectProposal(ctx, p.id, "owner", "not on brand", "2026-08-23T01:00:00Z", deps);
    expect(rejected.status).toBe("rejected");
    expect(rejected.decisionNote).toBe("not on brand");

    await expect(executeApproved(ctx, p.id, "owner", "2026-08-23T02:00:00Z", deps)).rejects.toThrow(/rejected/);
    expect(deps.executor).not.toHaveBeenCalled();

    const audit = await deps.state.readAudit(ctx);
    expect(audit.some((r: any) => r.action === "proposal.rejected")).toBe(true);
    expect((await deps.state.verifyAudit(ctx)).ok).toBe(true);
  });

  // Nit: "reason required" (brief) — an empty string previously passed silently.
  it("rejects an empty reason", async () => {
    const deps = mkDeps();
    const p = await seedPending(deps);
    await expect(rejectProposal(ctx, p.id, "owner", "", "2026-08-23T01:00:00Z", deps)).rejects.toThrow(/reason/);
  });

  // FIX 1 (illogical state transition): the optimistic version lock only catches concurrent races,
  // not an illogical transition from a settled TERMINAL status — a proposal already `executed`
  // (money moved) must never be flipped to `rejected`, overwriting that terminal state. Only a
  // `pending` proposal may be rejected.
  it("throws (status unchanged) rejecting an already-EXECUTED proposal", async () => {
    const deps = mkDeps();
    const p = await seedPending(deps);
    const executed = await executeApproved(ctx, p.id, "owner", "2026-08-23T01:00:00Z", deps);
    expect(executed.status).toBe("executed");
    await expect(
      rejectProposal(ctx, p.id, "owner", "too late", "2026-08-23T02:00:00Z", deps),
    ).rejects.toThrow(/executed/);
    expect((await deps.store.get(ctx, p.id))?.status).toBe("executed");
  });

  it("throws (status unchanged) rejecting an already-REJECTED proposal", async () => {
    const deps = mkDeps();
    const p = await seedPending(deps);
    await rejectProposal(ctx, p.id, "owner", "not on brand", "2026-08-23T01:00:00Z", deps);
    await expect(
      rejectProposal(ctx, p.id, "owner", "again", "2026-08-23T02:00:00Z", deps),
    ).rejects.toThrow(/rejected/);
    expect((await deps.store.get(ctx, p.id))?.status).toBe("rejected");
  });
});

describe("expireStale", () => {
  it("flips a pending proposal past its TTL to expired and it's no longer listed pending", async () => {
    const deps = mkDeps();
    const p = await seedPending(deps); // expiresAt = 2026-08-24T00:00:00Z (24h discount TTL)

    const untouched = await expireStale(ctx, "2026-08-23T12:00:00Z", deps); // before TTL — no-op
    expect(untouched).toHaveLength(0);

    const expired = await expireStale(ctx, "2026-08-24T00:00:01Z", deps); // past TTL
    expect(expired).toHaveLength(1);
    expect(expired[0].id).toBe(p.id);
    expect(expired[0].status).toBe("expired");

    const pending = await deps.store.list(ctx, { status: "pending" });
    expect(pending.items).toHaveLength(0);

    const audit = await deps.state.readAudit(ctx);
    expect(audit.some((r: any) => r.action === "proposal.expired")).toBe(true);
    expect((await deps.state.verifyAudit(ctx)).ok).toBe(true);
  });
});

describe("withdrawProposal", () => {
  it("lets the proposing agent withdraw a pending proposal, audited", async () => {
    const deps = mkDeps();
    const p = await seedPending(deps);
    const withdrawn = await withdrawProposal(ctx, p.id, "no longer relevant", "2026-08-23T01:00:00Z", deps);
    expect(withdrawn.status).toBe("withdrawn");
    expect(withdrawn.decisionNote).toBe("no longer relevant");

    const audit = await deps.state.readAudit(ctx);
    expect(audit.some((r: any) => r.action === "proposal.withdrawn")).toBe(true);
    expect((await deps.state.verifyAudit(ctx)).ok).toBe(true);
  });

  // Nit: "reason required" (brief) — an empty string previously passed silently.
  it("rejects an empty reason", async () => {
    const deps = mkDeps();
    const p = await seedPending(deps);
    await expect(withdrawProposal(ctx, p.id, "", "2026-08-23T01:00:00Z", deps)).rejects.toThrow(/reason/);
  });

  // FIX 1 (illogical state transition) — same rule as rejectProposal: only a `pending` proposal can
  // be withdrawn; an already-EXECUTED or already-REJECTED proposal's terminal status must not be
  // silently overwritten.
  it("throws (status unchanged) withdrawing an already-EXECUTED proposal", async () => {
    const deps = mkDeps();
    const p = await seedPending(deps);
    const executed = await executeApproved(ctx, p.id, "owner", "2026-08-23T01:00:00Z", deps);
    expect(executed.status).toBe("executed");
    await expect(
      withdrawProposal(ctx, p.id, "no longer relevant", "2026-08-23T02:00:00Z", deps),
    ).rejects.toThrow(/executed/);
    expect((await deps.store.get(ctx, p.id))?.status).toBe("executed");
  });

  it("throws (status unchanged) withdrawing an already-REJECTED proposal", async () => {
    const deps = mkDeps();
    const p = await seedPending(deps);
    await rejectProposal(ctx, p.id, "owner", "not on brand", "2026-08-23T01:00:00Z", deps);
    await expect(
      withdrawProposal(ctx, p.id, "no longer relevant", "2026-08-23T02:00:00Z", deps),
    ).rejects.toThrow(/rejected/);
    expect((await deps.store.get(ctx, p.id))?.status).toBe("rejected");
  });
});
