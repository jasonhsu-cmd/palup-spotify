import type { AgentAction, Proposal, MerchantRuleSet, MerchantRulesStore, RuleSetChangeResult, RuntimeStateCtx } from "@palup/platform-ports";

/** The action type an agent uses to PROPOSE an envelope change. It is deliberately NOT in
 *  `ACTION_TYPE_CATEGORY` (classify.ts), so `categoryForAction` maps it to `autonomy_scope` and
 *  invariant 2 forces `requires_approval` — an agent can never auto-apply a rule change; a human must
 *  approve it in the Approval Center first (CLAUDE.md §3.1). */
export const RULE_CHANGE_ACTION_TYPE = "change_rules";

export function buildRuleChangeAction(patch: MerchantRuleSet): AgentAction {
  return { type: RULE_CHANGE_ACTION_TYPE, params: { patch }, irreversible: false };
}

/** Applies an approved rule-change proposal's patch via the store with `agent_proposed` provenance.
 *  Called ONLY from an approval executor (post human-approval) — never on the propose path. Throws if
 *  the proposal is not a well-formed change_rules action (defence in depth: the executor must not
 *  apply an arbitrary payload as a rule set). */
export async function applyRuleChangeFromProposal(
  proposal: Pick<Proposal, "action">,
  store: MerchantRulesStore,
  ctx: RuntimeStateCtx,
  by: string,
): Promise<RuleSetChangeResult> {
  if (proposal.action?.type !== RULE_CHANGE_ACTION_TYPE) {
    throw new Error(`applyRuleChangeFromProposal: not a ${RULE_CHANGE_ACTION_TYPE} action`);
  }
  const patch = (proposal.action.params as { patch?: unknown }).patch;
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
    throw new Error("applyRuleChangeFromProposal: action.params.patch must be a rule set object");
  }
  return store.set(ctx, patch as MerchantRuleSet, by, "agent_proposed");
}
