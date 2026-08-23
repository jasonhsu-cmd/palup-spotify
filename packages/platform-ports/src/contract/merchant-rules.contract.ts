import { describe, it, expect } from "vitest";
import type { RuntimeStateCtx } from "../runtime-state-port.js";
import { CONSERVATIVE_DEFAULTS, type MerchantRulesStore } from "../merchant-rules-store.js";

// MerchantRulesStore contract (W4-min Task 2/5; parity with the `proposalStoreContract` convention):
// EVERY adapter (the in-memory one that ships with the port, `PostgresMerchantRulesStore` in
// `@palup/state-postgres`) MUST pass this, so `createRulesProvider`/a future `merchant-backend` route
// stay swappable and never learn which adapter they got. Import into an adapter's test and call
// `merchantRulesContract(() => makeMyAdapter())`.
//
// `makeStore` must return a FRESH, EMPTY store each call (or, for a Postgres adapter, one whose backing
// table has been truncated) — async so a Postgres adapter can migrate/truncate a scratch schema per
// test.

const ctx: RuntimeStateCtx = { tenantId: "t1" };

export function merchantRulesContract(makeStore: () => MerchantRulesStore | Promise<MerchantRulesStore>): void {
  describe("MerchantRulesStore contract", () => {
    it("returns conservative defaults when unset", async () => {
      const s = await makeStore();
      expect((await s.get(ctx)).discount?.allowedAuto ?? false).toBe(CONSERVATIVE_DEFAULTS.discount?.allowedAuto ?? false);
    });

    it("persists a set envelope, merges over defaults, and flags a big jump", async () => {
      const s = await makeStore();
      const r = await s.set(ctx, { discount: { allowedAuto: true, maxPct: 25 } }, "owner", "merchant_set");
      expect(r.bigJump).toBe(true); // 0 -> 25% auto is a big jump
      const got = await s.get(ctx);
      expect(got.discount?.maxPct).toBe(25);
      expect(got.discount?.allowedAuto).toBe(true);
      // an untouched category still returns CONSERVATIVE_DEFAULTS, not undefined/absent.
      expect(got.refund?.allowedAuto ?? false).toBe(CONSERVATIVE_DEFAULTS.refund?.allowedAuto ?? false);
    });

    it("does NOT flag a big jump when tightening a rule (decrease only)", async () => {
      const s = await makeStore();
      await s.set(ctx, { discount: { allowedAuto: true, maxPct: 25 } }, "owner", "merchant_set");
      const r = await s.set(ctx, { discount: { allowedAuto: true, maxPct: 10 } }, "owner", "merchant_set");
      expect(r.bigJump).toBe(false);
    });

    it("a partial set only touches the given categories, leaving the others at defaults", async () => {
      const s = await makeStore();
      await s.set(ctx, { refund: { allowedAuto: true, maxUsd: 20 } }, "owner", "merchant_set");
      const got = await s.get(ctx);
      expect(got.refund?.maxUsd).toBe(20);
      expect(got.discount?.allowedAuto ?? false).toBe(CONSERVATIVE_DEFAULTS.discount?.allowedAuto ?? false);
    });

    it("isolates tenants", async () => {
      const s = await makeStore();
      await s.set(ctx, { discount: { allowedAuto: true, maxPct: 25 } }, "owner", "merchant_set");
      const other = await s.get({ tenantId: "other" });
      expect(other.discount?.allowedAuto ?? false).toBe(CONSERVATIVE_DEFAULTS.discount?.allowedAuto ?? false);
    });
  });
}
