import { describe, it, expect } from "vitest";
import { InMemoryRuntimeStore } from "@palup/platform-ports";
import { InMemoryMerchantRulesStore, CONSERVATIVE_DEFAULTS } from "../src/rules.js";

const ctx = { tenantId: "t1" };

describe("MerchantRulesStore", () => {
  it("returns conservative defaults when unset", async () => {
    const s = new InMemoryMerchantRulesStore(new InMemoryRuntimeStore());
    expect((await s.get(ctx)).discount?.allowedAuto ?? false).toBe(CONSERVATIVE_DEFAULTS.discount?.allowedAuto ?? false);
  });
  it("persists a set envelope and flags a big jump", async () => {
    const s = new InMemoryMerchantRulesStore(new InMemoryRuntimeStore());
    const r = await s.set(ctx, { discount: { allowedAuto: true, maxPct: 25 } }, "owner", "merchant_set");
    expect(r.bigJump).toBe(true); // 0 -> 25% auto is a big jump
    expect((await s.get(ctx)).discount?.maxPct).toBe(25);
  });
});
