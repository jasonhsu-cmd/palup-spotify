import { describe, it, expect } from "vitest";
import { InMemoryRuntimeStore } from "@palup/platform-ports";
import { InMemoryMerchantRulesStore, createRulesProvider } from "../src/rules.js";
import { classifyAction } from "../src/classify.js";

const ctx = { tenantId: "t1" };

describe("createRulesProvider", () => {
  it("auto-allows within the merchant envelope but clamps to the PalUp floor", async () => {
    const store = new InMemoryMerchantRulesStore(new InMemoryRuntimeStore());
    await store.set(ctx, { discount: { allowedAuto: true, maxPct: 100 } }, "owner", "merchant_set"); // absurd — floor must clamp
    const rules = createRulesProvider(store);
    expect((await classifyAction({ type: "issue_discount", params: { pct: 20 } }, ctx, rules)).decision).toBe("auto"); // within floor (30)
    expect((await classifyAction({ type: "issue_discount", params: { pct: 40 } }, ctx, rules)).decision).toBe(
      "requires_approval",
    ); // above floor 30
  });
});
