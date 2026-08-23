import { describe, it, expect, vi } from "vitest";
import { InMemoryRuntimeStore } from "@palup/platform-ports";
import { verifyAuditChain } from "@palup/evolution";
import { InMemoryProposalStore } from "../src/proposal-store.js";
import { proposeOrExecute, executeApproved } from "../src/loop.js";

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
    // verifyAuditChain (evolution) is typed for its own build-time AuditEntry shape; the hash
    // algorithm it runs (sha256 over canonicalized "all fields but hash") is IDENTICAL to
    // RuntimeStatePort's (see packages/platform-ports/src/audit-hash.ts) — the cast is a shape
    // adaptation, not a behavior change.
    expect(verifyAuditChain((await deps.state.readAudit(ctx)) as any).ok).toBe(true);
  });
});
