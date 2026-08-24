import { describe, it, expect } from "vitest";
import { classifyAction, type RulesProvider } from "../src/classify.js";
import { RULE_CHANGE_ACTION_TYPE, buildRuleChangeAction, applyRuleChangeFromProposal } from "../src/rule-change-proposal.js";
import { InMemoryMerchantRulesStore, InMemoryRuntimeStore, type PalupFloor } from "@palup/platform-ports";

const floor: PalupFloor = { maxAutoPct: 30, maxAutoUsd: 200, massSendRecipientFloor: 500 };
const permissiveRules: RulesProvider = { autoActLimit: () => ({ allowedAuto: true, maxPct: 100, maxUsd: 100000 }), palupFloor: () => floor };
const ctx = { tenantId: "t1" };

describe("agent-proposed rule change routes through W1", () => {
  it("a change_rules action ALWAYS classifies to requires_approval (autonomy_scope), even under permissive rules", async () => {
    const action = buildRuleChangeAction({ discount: { allowedAuto: true, maxPct: 25 } });
    expect(action.type).toBe(RULE_CHANGE_ACTION_TYPE);
    const r = await classifyAction(action, ctx, permissiveRules);
    expect(r.decision).toBe("requires_approval");
    expect(r.category).toBe("autonomy_scope");
  });

  it("applyRuleChangeFromProposal writes the patch with agent_proposed provenance + audit", async () => {
    const state = new InMemoryRuntimeStore();
    const store = new InMemoryMerchantRulesStore(state);
    const proposal = { action: buildRuleChangeAction({ discount: { allowedAuto: true, maxPct: 25 } }) } as any;
    const out = await applyRuleChangeFromProposal(proposal, store, ctx, "win_back_agent");
    expect(out.envelope.discount).toEqual({ allowedAuto: true, maxPct: 25 });
    const audit = await state.readAudit(ctx);
    const rec = audit.find((r) => r.action === "rules.changed");
    expect(rec).toBeDefined();
    expect((rec!.input as { provenance: string }).provenance).toBe("agent_proposed");
  });

  it("rejects a proposal whose action is not a change_rules action", async () => {
    const state = new InMemoryRuntimeStore();
    const store = new InMemoryMerchantRulesStore(state);
    const bad = { action: { type: "issue_discount", params: {} } } as any;
    await expect(applyRuleChangeFromProposal(bad, store, ctx, "agent")).rejects.toThrow();
  });
});
