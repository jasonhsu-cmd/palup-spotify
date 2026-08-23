import { describe, it, expect, vi } from "vitest";
import { InMemoryRuntimeStore } from "@palup/platform-ports";
import { InMemoryProposalStore } from "../src/proposal-store.js";
import { proposeOrExecute } from "../src/loop.js";
import { killMerchant, unkillMerchant, KillSwitchError } from "../src/kill.js";

const ctx = { tenantId: "t1" };

const mkDeps = () => {
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
  };
};

const input = {
  ctx,
  agentId: "a",
  agentType: "win_back",
  category: "discount" as const,
  rationale: "r",
  reversalPlan: { reversible: true, plan: "u" },
  now: "2026-08-23T00:00:00Z",
  action: { type: "issue_discount", params: { pct: 10 } },
};

describe("kill switch", () => {
  it("blocks auto-execution while the merchant is killed", async () => {
    const deps = mkDeps();
    await killMerchant(deps.state, ctx, "operator halt");
    await expect(proposeOrExecute(input, deps)).rejects.toBeInstanceOf(KillSwitchError);
    expect(deps.executor).not.toHaveBeenCalled();
  });

  it("resumes after unkill", async () => {
    const deps = mkDeps();
    await killMerchant(deps.state, ctx, "halt");
    await unkillMerchant(deps.state, ctx);
    const r = await proposeOrExecute(input, deps);
    expect(r.kind).toBe("executed");
  });
});
