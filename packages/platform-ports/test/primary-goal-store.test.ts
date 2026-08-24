import { describe, it, expect } from "vitest";
import { InMemoryRuntimeStore } from "../src/in-memory-runtime-store.js";
import { InMemoryPrimaryGoalStore } from "../src/primary-goal-store.js";
import { primaryGoalContract } from "../src/contract/primary-goal.contract.js";

// W2 Task 1: the per-tenant primary-goal object (spec §9 W2 / §10: "one primary goal object every
// agent reads and orients to"). The in-memory adapter is the behavioral ORACLE for
// `PostgresPrimaryGoalStore` (Task 2) — both run `primaryGoalContract`.

const ctx = { tenantId: "t1" };

describe("InMemoryPrimaryGoalStore", () => {
  primaryGoalContract(() => new InMemoryPrimaryGoalStore(new InMemoryRuntimeStore()));

  it("audits goal.changed with before/after inside the same tx (NN#5)", async () => {
    const state = new InMemoryRuntimeStore();
    const s = new InMemoryPrimaryGoalStore(state, () => "2026-08-24T00:00:00.000Z");
    await s.set(ctx, { kind: "recover_carts" }, "u1");
    await s.set(ctx, { kind: "increase_aov", note: "Q3 push" }, "u2");
    const audit = await state.readAudit(ctx);
    const changed = audit.filter((r) => r.action === "goal.changed");
    expect(changed).toHaveLength(2);
    expect(changed[0]!.actor).toBe("u1");
    expect((changed[1]!.decision as { before: { kind: string } }).before.kind).toBe("recover_carts");
    expect((changed[1]!.decision as { after: { kind: string } }).after.kind).toBe("increase_aov");
    expect(changed[1]!.reversalPath).toContain("recover_carts");
  });

  it("stamps setBy/setAt from the injected clock", async () => {
    const s = new InMemoryPrimaryGoalStore(new InMemoryRuntimeStore(), () => "2026-08-24T00:00:00.000Z");
    const goal = await s.set(ctx, { kind: "win_back_lapsed" }, "owner-1");
    expect(goal).toEqual({ kind: "win_back_lapsed", setBy: "owner-1", setAt: "2026-08-24T00:00:00.000Z" });
  });
});
