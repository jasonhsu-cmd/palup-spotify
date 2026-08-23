import { describe, it, expect } from "vitest";
import { InMemoryRuntimeStore } from "@palup/platform-ports";
import { InMemoryMerchantRulesStore, createRulesProvider, clampToFloor, PALUP_FLOORS } from "../src/rules.js";
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

  // F1 regression — coordinator repro: a mis-set merchant envelope carrying a huge `maxUsd` on
  // `discount` (a category with NO explicit dollar floor before this fix) must NOT pass through
  // unclamped. `issue_discount` with a $500,000 `usd` param must never auto-approve.
  it("clamps an absurd merchant maxUsd on `discount` to the PalUp floor (F1) — a $500,000 discount never auto-approves", async () => {
    const store = new InMemoryMerchantRulesStore(new InMemoryRuntimeStore());
    await store.set(ctx, { discount: { allowedAuto: true, maxUsd: 999_999 } }, "owner", "merchant_set");
    const rules = createRulesProvider(store);
    const c = await classifyAction({ type: "issue_discount", params: { usd: 500_000 } }, ctx, rules);
    expect(c.decision).toBe("requires_approval");
  });

  // F1 — a category that DOES already carry a dollar floor (`ad_spend`, $500): an absurd merchant
  // maxUsd (999,999) must still clamp DOWN to the floor, not the merchant's own (looser) number —
  // proves the floor is a real ceiling, not merely a fallback for an unset merchant value.
  it("clamps an absurd merchant maxUsd on `ad_spend` to its own PalUp floor (500), not the merchant's looser number", async () => {
    const store = new InMemoryMerchantRulesStore(new InMemoryRuntimeStore());
    await store.set(ctx, { ad_spend: { allowedAuto: true, maxUsd: 999_999 } }, "owner", "merchant_set");
    const rules = createRulesProvider(store);
    const c = await classifyAction({ type: "run_ad_campaign", params: { usd: 600 } }, ctx, rules); // > floor(500), < merchant's 999,999
    expect(c.decision).toBe("requires_approval");
  });

  // F1(b) belt-and-suspenders, tested directly against the pure `clampToFloor` helper (independent
  // of what `PALUP_FLOORS` currently defines): a floor that happens to omit `maxAutoUsd` entirely
  // must NEVER let the merchant's `maxUsd` pass through as "unlimited" — the effective auto USD cap
  // must be 0, not the merchant's number and not Infinity.
  it("clampToFloor fails closed to maxUsd:0 when the floor itself defines no maxAutoUsd", () => {
    const floorWithNoUsdCeiling = { maxAutoPct: 100, massSendRecipientFloor: 500 }; // no maxAutoUsd
    const limit = clampToFloor({ allowedAuto: true, maxUsd: 999_999 }, floorWithNoUsdCeiling);
    expect(limit.maxUsd).toBe(0);
  });

  it("sanity: every PALUP_FLOORS category actually defines a maxAutoUsd (F1a)", () => {
    for (const category of Object.keys(PALUP_FLOORS) as Array<keyof typeof PALUP_FLOORS>) {
      expect(PALUP_FLOORS[category].maxAutoUsd).toBeDefined();
    }
  });

  // F3 — mass-send floor through the real provider + classifier (not just the E1 fake).
  it("routes a mass send through createRulesProvider to requires_approval via the mass_send_floor rule", async () => {
    const store = new InMemoryMerchantRulesStore(new InMemoryRuntimeStore());
    const rules = createRulesProvider(store);
    const c = await classifyAction(
      { type: "send_campaign", params: {}, blastRadius: PALUP_FLOORS.campaign.massSendRecipientFloor },
      ctx,
      rules,
    );
    expect(c.decision).toBe("requires_approval");
    expect(c.boundaryReasons.some((b) => b.rule === "mass_send_floor")).toBe(true);
  });
});
