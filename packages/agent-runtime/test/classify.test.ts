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
});
