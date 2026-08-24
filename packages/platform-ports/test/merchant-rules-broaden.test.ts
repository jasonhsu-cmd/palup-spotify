import { describe, it, expect } from "vitest";
import { clampToFloor, isBigJump, PALUP_FLOORS, type CategoryRuleEnvelope } from "../src/index.js";

describe("PALUP_FLOORS spend-sanity (period)", () => {
  it("ad_spend defines an inviolable rolling-period ceiling; other categories do not", () => {
    expect(PALUP_FLOORS.ad_spend.maxAutoPeriodUsd).toBe(5000);
    expect(PALUP_FLOORS.discount.maxAutoPeriodUsd).toBeUndefined();
  });
});

describe("clampToFloor — new dimensions, fail-closed", () => {
  it("clamps a merchant period budget DOWN to the spend-sanity floor and never above it", () => {
    const env: CategoryRuleEnvelope = { allowedAuto: true, periodBudgetUsd: 999_999, maxUsd: 100 };
    const out = clampToFloor(env, PALUP_FLOORS.ad_spend);
    expect(out.periodBudgetUsd).toBe(5000); // pulled down to floor
  });
  it("applies the spend-sanity ceiling even when the merchant set NO period budget (inviolable, not opt-in)", () => {
    const env: CategoryRuleEnvelope = { allowedAuto: true, maxUsd: 100 };
    expect(clampToFloor(env, PALUP_FLOORS.ad_spend).periodBudgetUsd).toBe(5000);
  });
  it("fails closed to 0 when the floor omits maxAutoPeriodUsd but the merchant set a budget", () => {
    const env: CategoryRuleEnvelope = { allowedAuto: true, periodBudgetUsd: 300 };
    const synthFloor = { maxAutoPct: 30, maxAutoUsd: 50, massSendRecipientFloor: 500 }; // no maxAutoPeriodUsd
    expect(clampToFloor(env, synthFloor).periodBudgetUsd).toBe(0);
  });
  it("clamps a price-match credit to the refund-abuse dollar floor and defaults an absent one to 0", () => {
    expect(clampToFloor({ allowedAuto: true, priceMatchMaxUsd: 10_000 }, PALUP_FLOORS.refund).priceMatchMaxUsd).toBe(200);
    expect(clampToFloor({ allowedAuto: true }, PALUP_FLOORS.refund).priceMatchMaxUsd).toBe(0);
  });
  it("passes merchant-only policy fields through unchanged (no floor for them)", () => {
    const env: CategoryRuleEnvelope = {
      allowedAuto: true, stackable: true, roiFloor: 4,
      subscriptionSelfServe: ["pause", "skip"], frequencyCapPerWeek: 2, quietHours: { startHour: 21, endHour: 9 },
    };
    const out = clampToFloor(env, PALUP_FLOORS.discount);
    expect(out.stackable).toBe(true);
    expect(out.roiFloor).toBe(4);
    expect(out.subscriptionSelfServe).toEqual(["pause", "skip"]);
    expect(out.frequencyCapPerWeek).toBe(2);
    expect(out.quietHours).toEqual({ startHour: 21, endHour: 9 });
  });
  it("never widens allowedAuto (existing invariant preserved)", () => {
    expect(clampToFloor({ allowedAuto: false, stackable: true }, PALUP_FLOORS.discount).allowedAuto).toBe(false);
  });
});

describe("isBigJump — new autonomy-increasing dimensions", () => {
  const off: CategoryRuleEnvelope = { allowedAuto: false };
  it("flags enabling stacking", () => {
    expect(isBigJump({ allowedAuto: true, stackable: false }, { allowedAuto: true, stackable: true })).toBe(true);
  });
  it("flags adding 'cancel' to subscription self-serve", () => {
    expect(isBigJump({ allowedAuto: true, subscriptionSelfServe: ["pause"] }, { allowedAuto: true, subscriptionSelfServe: ["pause", "cancel"] })).toBe(true);
  });
  it("flags LOWERING the ROI floor (agent may auto-buy worse ROI = more autonomy)", () => {
    expect(isBigJump({ allowedAuto: true, roiFloor: 4 }, { allowedAuto: true, roiFloor: 2 })).toBe(true);
  });
  it("flags a big period-budget or price-match increase, and a frequency-cap increase", () => {
    expect(isBigJump({ allowedAuto: true, periodBudgetUsd: 100 }, { allowedAuto: true, periodBudgetUsd: 400 })).toBe(true);
    expect(isBigJump({ allowedAuto: true, priceMatchMaxUsd: 20 }, { allowedAuto: true, priceMatchMaxUsd: 200 })).toBe(true);
    expect(isBigJump({ allowedAuto: true, frequencyCapPerWeek: 1 }, { allowedAuto: true, frequencyCapPerWeek: 5 })).toBe(true);
  });
  it("does NOT flag a tightening (raising the ROI floor, shrinking a budget, removing 'cancel')", () => {
    expect(isBigJump({ allowedAuto: true, roiFloor: 2 }, { allowedAuto: true, roiFloor: 5 })).toBe(false);
    expect(isBigJump({ allowedAuto: true, periodBudgetUsd: 400 }, { allowedAuto: true, periodBudgetUsd: 100 })).toBe(false);
    expect(isBigJump({ allowedAuto: true, subscriptionSelfServe: ["pause", "cancel"] }, { allowedAuto: true, subscriptionSelfServe: ["pause"] })).toBe(false);
  });
  it("still flags the off→on allowedAuto flip (existing behavior)", () => {
    expect(isBigJump(off, { allowedAuto: true })).toBe(true);
  });
});
