import { describe, it, expect } from "vitest";
import { classifyAction, type RulesProvider } from "../src/classify.js";
import type { AgentAction, AutoActLimit, PalupFloor } from "@palup/platform-ports";

const floor: PalupFloor = { maxAutoPct: 30, maxAutoUsd: 200, maxAutoPeriodUsd: 5000, massSendRecipientFloor: 500 };
function rules(limit: AutoActLimit): RulesProvider {
  return { autoActLimit: () => limit, palupFloor: () => floor };
}
const ctx = { tenantId: "t1" };

describe("discount stacking gate", () => {
  it("auto: an in-cap, non-stacked discount when merchant enabled auto", async () => {
    const a: AgentAction = { type: "issue_discount", params: { pct: 10 } };
    const r = await classifyAction(a, ctx, rules({ allowedAuto: true, maxPct: 20, stackable: false }));
    expect(r.decision).toBe("auto");
  });
  it("requires_approval: a stacked discount when stacking is not allowed", async () => {
    const a: AgentAction = { type: "issue_discount", params: { pct: 10, stack: true } };
    const r = await classifyAction(a, ctx, rules({ allowedAuto: true, maxPct: 20, stackable: false }));
    expect(r.decision).toBe("requires_approval");
    expect(r.boundaryReasons.some((b) => b.rule === "discount.stacking_not_allowed")).toBe(true);
  });
  it("auto: a stacked discount when the merchant DID allow stacking (and pct in cap)", async () => {
    const a: AgentAction = { type: "issue_discount", params: { pct: 10, stackWith: ["SUMMER"] } };
    const r = await classifyAction(a, ctx, rules({ allowedAuto: true, maxPct: 20, stackable: true }));
    expect(r.decision).toBe("auto");
  });

  // REGRESSION (review blocker): an empty stackWith array must NOT count as "the categorical
  // dimension is present" — categoricalDimensionPresent must mirror the actual stacking gate
  // (non-empty array only), or an unmeasured discount with no pct/usd silently auto-passes.
  it("requires_approval: an empty stackWith array with no pct/usd is unmeasured, never auto", async () => {
    const a: AgentAction = { type: "issue_discount", params: { stackWith: [] } };
    const r = await classifyAction(a, ctx, rules({ allowedAuto: true, maxPct: 20, stackable: false }));
    expect(r.decision).toBe("requires_approval");
  });
  it("requires_approval: stack:false with no other params is unmeasured, never auto", async () => {
    const a: AgentAction = { type: "issue_discount", params: { stack: false } };
    const r = await classifyAction(a, ctx, rules({ allowedAuto: true, maxPct: 20, stackable: false }));
    expect(r.decision).toBe("requires_approval");
  });

  // REGRESSION (FINAL-REVIEW blocker, third instance of the bypass class): `stack`/`stackWith`
  // presence must NEVER count as "measured" for a discount — a discount's money magnitude is ALWAYS
  // pct/usd (stacking is a modifier on top, not a measurement of the discount itself). Before this
  // fix, `categoricalDimensionPresent` treated `stack:true` (or a non-empty `stackWith`) alone as
  // "measured", so a discount with NO pct/usd bypassed invariant 4's unmeasured-action default, hit
  // zero pct/usd caps (absent) and the stacking gate stayed a no-op (`stackable:true`), and
  // auto-approved an arbitrarily-sized discount that was never actually measured against any cap.
  it("requires_approval: stack:true with NO pct/usd is unmeasured, never auto, even when stacking is allowed", async () => {
    const a: AgentAction = { type: "issue_discount", params: { stack: true } };
    const r = await classifyAction(a, ctx, rules({ allowedAuto: true, maxPct: 20, stackable: true }));
    expect(r.decision).toBe("requires_approval");
    expect(r.boundaryReasons.some((b) => b.rule === "discount.unmeasured_action")).toBe(true);
  });
  it("requires_approval: a non-empty stackWith with NO pct/usd is unmeasured, never auto, even when stacking is allowed", async () => {
    const a: AgentAction = { type: "issue_discount", params: { stackWith: ["SUMMER"] } };
    const r = await classifyAction(a, ctx, rules({ allowedAuto: true, maxPct: 20, stackable: true }));
    expect(r.decision).toBe("requires_approval");
    expect(r.boundaryReasons.some((b) => b.rule === "discount.unmeasured_action")).toBe(true);
  });
  it("auto: a measured (pct) discount with stacking allowed stays auto (positive control)", async () => {
    const a: AgentAction = { type: "issue_discount", params: { pct: 10 } };
    const r = await classifyAction(a, ctx, rules({ allowedAuto: true, maxPct: 20, stackable: true }));
    expect(r.decision).toBe("auto");
  });
  it("requires_approval: a measured (pct) discount that stacks without permission still gates via discount.stacking_not_allowed (positive control)", async () => {
    const a: AgentAction = { type: "issue_discount", params: { pct: 10, stack: true } };
    const r = await classifyAction(a, ctx, rules({ allowedAuto: true, maxPct: 20, stackable: false }));
    expect(r.decision).toBe("requires_approval");
    expect(r.boundaryReasons.some((b) => b.rule === "discount.stacking_not_allowed")).toBe(true);
  });
});

describe("refund price-match gate", () => {
  it("requires_approval: a price-match credit over the price-match cap (even if under the general refund cap)", async () => {
    const a: AgentAction = { type: "issue_refund", params: { usd: 50, priceMatch: true } };
    const r = await classifyAction(a, ctx, rules({ allowedAuto: true, maxUsd: 200, priceMatchMaxUsd: 25 }));
    expect(r.decision).toBe("requires_approval");
    expect(r.boundaryReasons.some((b) => b.rule === "refund.price_match_over_cap")).toBe(true);
  });
  it("auto: a price-match credit within both the price-match cap and the general refund cap", async () => {
    const a: AgentAction = { type: "issue_refund", params: { usd: 20, priceMatch: true } };
    const r = await classifyAction(a, ctx, rules({ allowedAuto: true, maxUsd: 200, priceMatchMaxUsd: 25 }));
    expect(r.decision).toBe("auto");
  });
  it("fails closed: a price-match with NO configured price-match cap requires approval", async () => {
    const a: AgentAction = { type: "issue_refund", params: { usd: 5, priceMatch: true } };
    const r = await classifyAction(a, ctx, rules({ allowedAuto: true, maxUsd: 200 })); // priceMatchMaxUsd undefined
    expect(r.decision).toBe("requires_approval");
    expect(r.boundaryReasons.some((b) => b.rule === "refund.price_match_over_cap")).toBe(true);
  });
});

describe("subscription sub-action gate", () => {
  it("auto: a self-serve pause when 'pause' is in the allow-list", async () => {
    const a: AgentAction = { type: "change_subscription", params: { subAction: "pause" } };
    const r = await classifyAction(a, ctx, rules({ allowedAuto: true, subscriptionSelfServe: ["pause", "skip"] }));
    expect(r.decision).toBe("auto");
  });
  it("requires_approval: a cancel that is not in the allow-list", async () => {
    const a: AgentAction = { type: "change_subscription", params: { subAction: "cancel" } };
    const r = await classifyAction(a, ctx, rules({ allowedAuto: true, subscriptionSelfServe: ["pause", "skip"] }));
    expect(r.decision).toBe("requires_approval");
    expect(r.boundaryReasons.some((b) => b.rule === "subscription.action_requires_approval")).toBe(true);
  });
  it("requires_approval: a subscription action with NO subAction param (unmeasured, invariant 4)", async () => {
    const a: AgentAction = { type: "change_subscription", params: {} };
    const r = await classifyAction(a, ctx, rules({ allowedAuto: true, subscriptionSelfServe: ["pause"] }));
    expect(r.decision).toBe("requires_approval");
  });
  it("requires_approval: self-serve action but merchant has auto OFF for subscription", async () => {
    const a: AgentAction = { type: "change_subscription", params: { subAction: "pause" } };
    const r = await classifyAction(a, ctx, rules({ allowedAuto: false, subscriptionSelfServe: ["pause"] }));
    expect(r.decision).toBe("requires_approval");
  });
});
