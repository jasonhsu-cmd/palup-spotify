import { describe, it, expect } from "vitest";
import type { RuntimeStateCtx } from "../runtime-state-port.js";
import { LearnedInsightNotFoundError, type LearnedInsight, type LearnedStore } from "../learned-store.js";

// LearnedStore contract (W3 Task 1; the `merchantRulesContract`/`primaryGoalContract` convention):
// EVERY adapter (the in-memory one that ships with the port, `PostgresLearnedStore` in
// `@palup/state-postgres`, Task 3) MUST pass this so callers stay swappable and never learn which
// adapter they got. `makeStore` must return a FRESH, EMPTY store each call (Postgres: truncate its
// table first).

const ctx: RuntimeStateCtx = { tenantId: "t1" };

function insight(over: Partial<LearnedInsight> = {}): LearnedInsight {
  return {
    id: "l1", tenantId: "t1", category: "customers", tier: "private", origin: "synthesized",
    text: "insight", grounding: { source: "orders", sampleSize: 250, confidence: "high" },
    pinned: false, createdAt: "2026-08-24T00:00:00Z", updatedAt: "2026-08-24T00:00:00Z", ...over,
  };
}

export function learnedStoreContract(makeStore: () => LearnedStore | Promise<LearnedStore>): void {
  describe("LearnedStore contract", () => {
    it("records and reads back", async () => {
      const s = await makeStore();
      await s.record(ctx, insight({ id: "a" }), "owner");
      expect((await s.get(ctx, "a"))?.text).toBe("insight");
    });

    it("filters by category and never serves the aggregate tier", async () => {
      const s = await makeStore();
      await s.record(ctx, insight({ id: "a", category: "voice" }), "owner");
      await s.record(ctx, insight({ id: "b", category: "products" }), "owner");
      expect((await s.list(ctx, { category: "voice" })).map((i) => i.id)).toEqual(["a"]);
      expect(await s.list(ctx, { tier: "aggregate" })).toEqual([]);
    });

    it("pins, removes, isolates tenants, and throws on a missing id", async () => {
      const s = await makeStore();
      await s.record(ctx, insight({ id: "a", pinned: false }), "owner");
      expect((await s.setPinned(ctx, "a", true, "owner", "2026-08-24T02:00:00Z")).pinned).toBe(true);
      expect(await s.list({ tenantId: "other" })).toEqual([]);
      await s.remove(ctx, "a", "owner", "2026-08-24T03:00:00Z");
      expect(await s.get(ctx, "a")).toBeNull();
      await expect(s.remove(ctx, "gone", "owner", "t")).rejects.toBeInstanceOf(LearnedInsightNotFoundError);
    });
  });
}
