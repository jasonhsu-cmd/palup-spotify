import { describe, it, expect } from "vitest";
import type { RuntimeStateCtx } from "@palup/platform-ports";
import { ProposalNotFoundError, VersionConflictError, type ProposalStore } from "../proposal-store.js";
import type { Proposal } from "../types.js";

// ProposalStore contract (Task 8; parity with ADR-0001's port-contract convention — see
// `runMerchantRegistryPortContract`): EVERY adapter (the in-memory one from Task 2, the Postgres one
// from Task 8) MUST pass this suite, so the engine (loop.ts) stays swappable and never learns which
// adapter it got. Extracted verbatim from Task 2's `proposal-store.test.ts` so behavior didn't drift
// while lifting it into a shared helper.
//
// `makeStore` must return a FRESH, EMPTY store each call. Async so a Postgres adapter can
// migrate/truncate a scratch schema per test.

const ctx: RuntimeStateCtx = { tenantId: "t1" };

const base = (id: string, over: Partial<Proposal> = {}): Proposal => ({
  id,
  tenantId: "t1",
  agentId: "a",
  agentType: "win_back",
  action: { type: "x", params: {} },
  category: "campaign",
  rationale: "r",
  boundaryReasons: [],
  reversalPlan: { reversible: true, plan: "undo" },
  preconditions: {},
  status: "pending",
  version: 0,
  createdAt: "2026-08-23T00:00:00Z",
  expiresAt: "2026-08-26T00:00:00Z",
  ...over,
});

export function proposalStoreContract(makeStore: () => ProposalStore | Promise<ProposalStore>): void {
  describe("ProposalStore contract", () => {
    it("creates, gets, and lists by status", async () => {
      const s = await makeStore();
      await s.create(base("p1"));
      await s.create(base("p2", { status: "rejected" }));
      expect((await s.get(ctx, "p1"))?.id).toBe("p1");
      const pend = await s.list(ctx, { status: "pending" });
      expect(pend.items.map((p) => p.id)).toEqual(["p1"]);
    });

    it("enforces optimistic version on transition", async () => {
      const s = await makeStore();
      await s.create(base("p1"));
      await s.transition(ctx, "p1", 0, { status: "approved", decidedBy: "owner" });
      await expect(s.transition(ctx, "p1", 0, { status: "rejected" })).rejects.toBeInstanceOf(VersionConflictError);
    });

    it("isolates tenants", async () => {
      const s = await makeStore();
      await s.create(base("p1"));
      expect(await s.get({ tenantId: "other" }, "p1")).toBeNull();
    });

    it("throws ProposalNotFoundError transitioning a missing id", async () => {
      const s = await makeStore();
      await expect(s.transition(ctx, "nope", 0, { status: "rejected" })).rejects.toBeInstanceOf(ProposalNotFoundError);
    });
  });
}
