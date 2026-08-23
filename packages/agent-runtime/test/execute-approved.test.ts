import { describe, it, expect, vi } from "vitest";
import { InMemoryProposalStore, InMemoryRuntimeStore } from "@palup/platform-ports";
import { proposeOrExecute, executeApproved } from "../src/loop.js";
import { killMerchant, KillSwitchError } from "../src/kill.js";

const ctx = { tenantId: "t1" };

const seedPending = async (deps: any) =>
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
      },
      deps,
    )
  ).proposal!;

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

// NOTE ON SIGNATURE: the E1 task brief's illustrative pseudocode calls `executeApproved(id,
// decidedBy, now, deps)` with no `ctx`. That's not implementable against the real
// `ProposalStore`/`RuntimeStatePort` contracts (Tasks 2/3, verified in this package) — every
// `get`/`transition`/`audit` call is tenant-scoped and there is no cross-tenant lookup-by-id
// surface (correctly so: tenant isolation is the port's core guarantee, not an oversight to route
// around). `executeApproved` therefore takes `ctx` explicitly, matching `proposal-store.ts`'s own
// `get(ctx, id)` / `transition(ctx, id, ...)` convention.
describe("executeApproved", () => {
  it("blocks execution when a precondition no longer holds", async () => {
    const deps = mkDeps({ validate: vi.fn(async () => ({ valid: false, reason: "out of stock" })) });
    const p = await seedPending(deps);
    await expect(executeApproved(ctx, p.id, "owner", "2026-08-23T01:00:00Z", deps)).rejects.toThrow(/out of stock/);
    expect(deps.executor).not.toHaveBeenCalled();
    expect((await deps.store.get(ctx, p.id))?.status).toBe("pending");
  });

  it("executes idempotently and keeps the audit chain intact", async () => {
    const deps = mkDeps();
    const p = await seedPending(deps);
    const done = await executeApproved(ctx, p.id, "owner", "2026-08-23T01:00:00Z", deps);
    expect(done.status).toBe("executed");
    await executeApproved(ctx, p.id, "owner", "2026-08-23T01:00:00Z", deps); // idempotent re-call
    expect(deps.executor).toHaveBeenCalledOnce();
    // F5: RuntimeStatePort's own `verifyAudit` has identical hash-chain semantics to
    // `@palup/evolution`'s `verifyAuditChain` — use the native port method instead of pulling in
    // the evolution engine as a prod dependency for a type-incompatible cast.
    expect((await deps.state.verifyAudit(ctx)).ok).toBe(true);
  });

  // F2 (governance gap coverage): the Kill-Switch guard at the top of `executeApproved` was
  // previously unprotected by any test — a regression there would silently let a killed merchant's
  // approved proposal execute. Assert it blocks even an approval-eligible, precondition-valid
  // proposal, and that the executor is never reached.
  it("blocks execution when the merchant is killed, even for an approval-eligible proposal", async () => {
    const deps = mkDeps();
    const p = await seedPending(deps);
    await killMerchant(deps.state, ctx, "operator halt");
    await expect(executeApproved(ctx, p.id, "owner", "2026-08-23T01:00:00Z", deps)).rejects.toBeInstanceOf(
      KillSwitchError,
    );
    expect(deps.executor).not.toHaveBeenCalled();
    expect((await deps.store.get(ctx, p.id))?.status).toBe("pending");
  });

  // F3 (double-spend ruling): executionId must be stable across retries by DIFFERENT approvers —
  // it is minted from the proposal id alone, not `(id, decidedBy)`. Otherwise a failed execution
  // retried by a different human mints a new idempotency key and a downstream commerce port's
  // dedup can't catch the double charge/refund.
  it("mints the SAME executionId on retry after execution_failed, even when a different decidedBy re-approves", async () => {
    const deps = mkDeps({
      executor: vi.fn(async () => {
        throw new Error("network blip");
      }),
    });
    const p = await seedPending(deps);
    const failed = await executeApproved(ctx, p.id, "ownerA", "2026-08-23T01:00:00Z", deps);
    expect(failed.status).toBe("execution_failed");
    const firstExecutionId = failed.executionId;
    expect(firstExecutionId).toBeTruthy();

    deps.executor = vi.fn(async () => ({ ok: true, detail: "done" })); // retry succeeds
    const retried = await executeApproved(ctx, p.id, "ownerB", "2026-08-23T02:00:00Z", deps);
    expect(retried.status).toBe("executed");
    expect(retried.executionId).toBe(firstExecutionId);
  });
});
