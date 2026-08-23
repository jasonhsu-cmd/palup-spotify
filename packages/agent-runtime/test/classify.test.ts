import { describe, it, expect } from "vitest";
import { classifyAction, type RulesProvider } from "../src/classify.js";
const ctx = { tenantId:"t1" };
const rules = (over: Partial<ReturnType<any>> = {}): RulesProvider => ({
  async autoActLimit(){ return { maxPct: 15, allowedAuto: true, ...over }; },
  palupFloor(){ return { maxAutoPct: 30, massSendRecipientFloor: 500 }; },
});
describe("classifyAction", () => {
  it("auto-allows a discount within the merchant's auto limit", async () => {
    const c = await classifyAction({type:"issue_discount",params:{pct:10}}, ctx, rules());
    expect(c.decision).toBe("auto"); expect(c.category).toBe("discount");
  });
  it("requires approval above the merchant auto limit", async () => {
    const c = await classifyAction({type:"issue_discount",params:{pct:25}}, ctx, rules());
    expect(c.decision).toBe("requires_approval");
    expect(c.boundaryReasons[0].rule).toContain("discount");
  });
  it("defaults to requires_approval on an unknown/unclassifiable action", async () => {
    const c = await classifyAction({type:"mystery",params:{}}, ctx, rules());
    expect(c.decision).toBe("requires_approval");
  });
  it("forces approval on a mass send regardless of rules (permanent floor)", async () => {
    const c = await classifyAction({type:"send_campaign",params:{},blastRadius:2000}, ctx, rules({allowedAuto:true}));
    expect(c.decision).toBe("requires_approval");
    expect(c.boundaryReasons.some(b=>b.rule==="mass_send_floor")).toBe(true);
  });

  // USD-denominated path (e.g. issue_refund) — previously untested. Covers the fail-closed fix for
  // an absent USD ceiling on both sides.
  const usdRules = (limitOver: Record<string, unknown> = {}, floorOver: Record<string, unknown> = {}): RulesProvider => ({
    async autoActLimit(){ return { allowedAuto: true, ...limitOver }; },
    palupFloor(){ return { maxAutoPct: 30, massSendRecipientFloor: 500, ...floorOver }; },
  });

  it("auto-allows a refund within an explicit USD cap", async () => {
    const c = await classifyAction(
      { type:"issue_refund", params:{ usd: 40 } },
      ctx,
      usdRules({ maxUsd: 100 }, { maxAutoUsd: 200 }),
    );
    expect(c.decision).toBe("auto");
    expect(c.category).toBe("refund");
  });

  it("requires approval above the USD cap", async () => {
    const c = await classifyAction(
      { type:"issue_refund", params:{ usd: 150 } },
      ctx,
      usdRules({ maxUsd: 100 }, { maxAutoUsd: 200 }),
    );
    expect(c.decision).toBe("requires_approval");
    expect(c.boundaryReasons[0].rule).toContain("refund");
  });

  // FAIL-CLOSED REGRESSION GUARD: allowedAuto:true but NEITHER side configures a USD ceiling. An
  // absent cap must never widen autonomy — a $50,000 refund with no ceiling must still require
  // approval, never auto-approve on an unbounded dollar amount.
  it("requires approval on a dollar action when no USD ceiling is configured on either side", async () => {
    const c = await classifyAction(
      { type:"issue_refund", params:{ usd: 50000 } },
      ctx,
      usdRules({}, {}),
    );
    expect(c.decision).toBe("requires_approval");
    expect(c.boundaryReasons.some(b=>b.rule.includes("usd") || b.rule.includes("refund"))).toBe(true);
  });

  // F2 REGRESSION GUARD: a dollar-category action carrying BOTH a `pct` and a `usd` param must not
  // bypass its USD cap just because its `pct` happens to pass — the pct branch must never
  // short-circuit before the usd branch is evaluated. Coordinator repro: an ad-spend action within
  // its pct allowance (10% of some notional 30% cap) but wildly over its $500 USD floor must still
  // require approval.
  it("evaluates BOTH pct and usd — a within-pct dollar action is still caught by its USD cap (no short-circuit)", async () => {
    const c = await classifyAction(
      { type:"run_ad_campaign", params:{ pct: 10, usd: 50000 } },
      ctx,
      usdRules({}, { maxAutoUsd: 500 }),
    );
    expect(c.decision).toBe("requires_approval");
    expect(c.boundaryReasons.some(b=>b.rule.includes("usd_over_cap"))).toBe(true);
  });
});
