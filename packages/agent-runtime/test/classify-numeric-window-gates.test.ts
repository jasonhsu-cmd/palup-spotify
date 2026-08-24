import { describe, it, expect } from "vitest";
import { classifyAction, type RulesProvider } from "../src/classify.js";
import type { AgentAction, AutoActLimit, PalupFloor } from "@palup/platform-ports";

const floor: PalupFloor = { maxAutoPct: 100, maxAutoUsd: 500, maxAutoPeriodUsd: 5000, massSendRecipientFloor: 500 };
const commsFloor: PalupFloor = { maxAutoPct: 100, maxAutoUsd: 100, massSendRecipientFloor: 500 };
const rules = (limit: AutoActLimit, f: PalupFloor = floor): RulesProvider => ({ autoActLimit: () => limit, palupFloor: () => f });
const ctx = { tenantId: "t1" };

describe("ad-spend ROI floor gate", () => {
  it("requires_approval: projected ROI below the merchant floor", async () => {
    const a: AgentAction = { type: "run_ad_campaign", params: { usd: 100, roi: 1.5 } };
    const r = await classifyAction(a, ctx, rules({ allowedAuto: true, maxUsd: 500, roiFloor: 3 }));
    expect(r.decision).toBe("requires_approval");
    expect(r.boundaryReasons.some((b) => b.rule === "ad_spend.roi_below_floor")).toBe(true);
  });
  it("auto: ROI at/above the floor and under both per-action and period budgets", async () => {
    const a: AgentAction = { type: "run_ad_campaign", params: { usd: 100, roi: 4, periodSpentUsd: 200 } };
    const r = await classifyAction(a, ctx, rules({ allowedAuto: true, maxUsd: 500, roiFloor: 3, periodBudgetUsd: 1000 }));
    expect(r.decision).toBe("auto");
  });
  it("requires_approval: this buy would push rolling-period spend over the budget", async () => {
    const a: AgentAction = { type: "run_ad_campaign", params: { usd: 400, roi: 5, periodSpentUsd: 800 } };
    const r = await classifyAction(a, ctx, rules({ allowedAuto: true, maxUsd: 500, roiFloor: 3, periodBudgetUsd: 1000 }));
    expect(r.decision).toBe("requires_approval");
    expect(r.boundaryReasons.some((b) => b.rule === "ad_spend.period_budget_exceeded")).toBe(true);
  });
  it("period budget is inviolable: even with no merchant budget set, the spend-sanity floor caps it", async () => {
    // clampToFloor gives periodBudgetUsd=5000 when merchant left it unset; a $6000 running total trips it.
    const a: AgentAction = { type: "run_ad_campaign", params: { usd: 100, roi: 5, periodSpentUsd: 6000 } };
    const r = await classifyAction(a, ctx, rules({ allowedAuto: true, maxUsd: 500, roiFloor: 3, periodBudgetUsd: 5000 }));
    expect(r.decision).toBe("requires_approval");
  });

  // REGRESSION (same bug class as Task 3's empty-stackWith hole): a bare `roi` param with NO
  // merchant roiFloor configured, and no usd/pct, must NOT count as "measured" — otherwise an
  // ad-spend action with nothing actually checkable against any limit would silently auto-pass.
  it("requires_approval: roi present but merchant has no roiFloor configured, and no usd/pct — unmeasured, never auto", async () => {
    const a: AgentAction = { type: "run_ad_campaign", params: { roi: 4 } };
    const r = await classifyAction(a, ctx, rules({ allowedAuto: true }));
    expect(r.decision).toBe("requires_approval");
    expect(r.boundaryReasons.some((b) => b.rule === "ad_spend.unmeasured_action")).toBe(true);
  });
});

describe("comms quiet-hours & frequency gates", () => {
  it("requires_approval: an auto-send inside quiet hours (wraps midnight)", async () => {
    const a: AgentAction = { type: "send_campaign", params: { sendLocalHour: 23 } };
    const r = await classifyAction(a, ctx, rules({ allowedAuto: true, quietHours: { startHour: 21, endHour: 9 } }, commsFloor));
    expect(r.decision).toBe("requires_approval");
    expect(r.boundaryReasons.some((b) => b.rule === "campaign.quiet_hours")).toBe(true);
  });
  it("requires_approval: a recipient already at the weekly frequency cap", async () => {
    const a: AgentAction = { type: "send_campaign", params: { sendLocalHour: 12, priorSendsThisWeek: 2 } };
    const r = await classifyAction(a, ctx, rules({ allowedAuto: true, frequencyCapPerWeek: 2 }, commsFloor));
    expect(r.decision).toBe("requires_approval");
    expect(r.boundaryReasons.some((b) => b.rule === "campaign.frequency_cap")).toBe(true);
  });
  it("auto: a small in-window, under-cadence send (below the mass-send floor)", async () => {
    const a: AgentAction = { type: "send_campaign", params: { sendLocalHour: 12, priorSendsThisWeek: 0 }, blastRadius: 3 };
    const r = await classifyAction(a, ctx, rules({ allowedAuto: true, frequencyCapPerWeek: 2, quietHours: { startHour: 21, endHour: 9 } }, commsFloor));
    expect(r.decision).toBe("auto");
  });

  // REGRESSION (same bug class as Task 3's empty-stackWith hole, and B1's `usd:0` unexpected-
  // dimension trap): `sendLocalHour` present but the merchant configured NEITHER quietHours NOR
  // frequencyCapPerWeek — nothing is actually checkable, so this must stay unmeasured/approval,
  // never silently auto just because the action happened to carry a send-hour.
  it("requires_approval: sendLocalHour present but merchant configured no quietHours/frequencyCap — unmeasured, never auto", async () => {
    const a: AgentAction = { type: "send_campaign", params: { sendLocalHour: 12 } };
    const r = await classifyAction(a, ctx, rules({ allowedAuto: true }, commsFloor));
    expect(r.decision).toBe("requires_approval");
    expect(r.boundaryReasons.some((b) => b.rule === "campaign.unmeasured_action")).toBe(true);
  });
});
