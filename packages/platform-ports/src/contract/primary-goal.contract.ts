import { describe, it, expect } from "vitest";
import type { RuntimeStateCtx } from "../runtime-state-port.js";
import type { PrimaryGoalStore } from "../primary-goal-store.js";

// PrimaryGoalStore contract (W2 Task 1; the `merchantRulesContract` convention): EVERY adapter (the
// in-memory one that ships with the port, `PostgresPrimaryGoalStore` in `@palup/state-postgres`) MUST
// pass this so the `/home` routes stay swappable and never learn which adapter they got. `makeStore`
// must return a FRESH, EMPTY store each call (Postgres: truncate its table first).

const ctx: RuntimeStateCtx = { tenantId: "t1" };

export function primaryGoalContract(makeStore: () => PrimaryGoalStore | Promise<PrimaryGoalStore>): void {
  describe("PrimaryGoalStore contract", () => {
    it("returns null when unset — honest empty, never a fabricated default goal", async () => {
      const s = await makeStore();
      expect(await s.get(ctx)).toBeNull();
    });

    it("persists and returns the set goal with setBy/setAt", async () => {
      const s = await makeStore();
      const set = await s.set(ctx, { kind: "recover_carts", note: "from onboarding" }, "u1");
      expect(set.kind).toBe("recover_carts");
      expect(set.note).toBe("from onboarding");
      expect(set.setBy).toBe("u1");
      expect(typeof set.setAt).toBe("string");
      expect(await s.get(ctx)).toEqual(set);
    });

    it("overwrites on a second set — ONE primary goal, not a list", async () => {
      const s = await makeStore();
      await s.set(ctx, { kind: "recover_carts" }, "u1");
      await s.set(ctx, { kind: "increase_aov" }, "u2");
      const got = await s.get(ctx);
      expect(got?.kind).toBe("increase_aov");
      expect(got?.setBy).toBe("u2");
      expect(got?.note).toBeUndefined(); // a set WITHOUT a note clears any prior note (full overwrite)
    });

    it("isolates tenants", async () => {
      const s = await makeStore();
      await s.set(ctx, { kind: "recover_carts" }, "u1");
      expect(await s.get({ tenantId: "other" })).toBeNull();
    });
  });
}
