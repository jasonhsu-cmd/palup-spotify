import { describe, it, expect, vi } from "vitest";
import { InMemoryRuntimeStore } from "@palup/platform-ports";
import { InMemoryProposalStore } from "../src/proposal-store.js";
import { proposeOrExecute } from "../src/loop.js";

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

const input = (over = {}) => ({
  ctx,
  agentId: "a",
  agentType: "win_back",
  category: "discount" as const,
  rationale: "r",
  reversalPlan: { reversible: true, plan: "undo" },
  now: "2026-08-23T00:00:00Z",
  action: { type: "issue_discount", params: { pct: 10 } },
  ...over,
});

describe("proposeOrExecute", () => {
  it("auto-executes an in-policy action and writes audit", async () => {
    const deps = mkDeps();
    const r = await proposeOrExecute(input(), deps);
    expect(r.kind).toBe("executed");
    expect(deps.executor).toHaveBeenCalledOnce();
    expect((await deps.state.readAudit(ctx)).length).toBeGreaterThan(0);
  });

  it("creates a pending proposal when approval is required", async () => {
    const deps = mkDeps();
    const r = await proposeOrExecute(input({ action: { type: "issue_discount", params: { pct: 25 } } }), deps);
    expect(r.kind).toBe("proposed");
    expect(r.proposal?.status).toBe("pending");
    expect(r.proposal?.expiresAt).toBe("2026-08-24T00:00:00Z"); // +24h discount TTL
  });

  it("rejects a proposal with no reversal plan", async () => {
    await expect(
      proposeOrExecute(
        input({ action: { type: "issue_discount", params: { pct: 25 } }, reversalPlan: undefined as any }),
        mkDeps(),
      ),
    ).rejects.toThrow(/reversalPlan/);
  });
});
