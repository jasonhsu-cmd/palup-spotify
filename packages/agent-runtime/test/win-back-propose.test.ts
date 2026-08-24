import { describe, it, expect, vi } from "vitest";
import { InMemoryRuntimeStore, InMemoryProposalStore } from "@palup/platform-ports";
import { InMemoryMerchantRulesStore, createRulesProvider } from "../src/rules.js";
import { proposeWinBack } from "../src/agents/win-back.js";
import type { EngineDeps } from "../src/loop.js";

const ctx = { tenantId: "t1" };
const seg = Array.from({ length: 3 }, (_, i) => ({
  customerId: `c${i}`,
  contact: `c${i}@x.com`,
  lastOrderAt: "2026-05-01T00:00:00Z",
}));

const mkDeps = (): EngineDeps => {
  const state = new InMemoryRuntimeStore();
  return {
    store: new InMemoryProposalStore(state),
    state,
    rules: createRulesProvider(new InMemoryMerchantRulesStore(state)),
    executor: vi.fn(async () => ({ ok: true, detail: "sent" })),
    validate: vi.fn(async () => ({ valid: true })),
  };
};

describe("proposeWinBack", () => {
  it("always creates a pending campaign proposal, never auto-sends", async () => {
    const deps = mkDeps();
    const r = await proposeWinBack(
      { segment: seg, draft: { channel: "email", subject: "s", body: "Auria: come back" }, ctx, now: "2026-08-23T00:00:00Z" },
      deps,
    );
    expect(r.kind).toBe("proposed");
    expect(r.proposal?.category).toBe("campaign");
    expect(r.proposal?.action.blastRadius).toBe(3);
    expect(r.proposal?.action.irreversible).toBe(true);
    expect(r.proposal?.reversalPlan.reversible).toBe(false);
    expect(r.proposal?.reversalPlan.plan.trim().length).toBeGreaterThan(0);
    expect(deps.executor).not.toHaveBeenCalled(); // nothing sent yet
    expect(r.proposal?.estimatedImpact?.reach).toBe(3);
    // The recipients + content actually reach the pending proposal a human reviews.
    expect(r.proposal?.action.params.recipients).toEqual(["c0@x.com", "c1@x.com", "c2@x.com"]);
    expect(r.proposal?.action.params.body).toBe("Auria: come back");
  });
});
