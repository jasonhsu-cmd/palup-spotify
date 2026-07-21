---
name: hitl-approval-gate
description: >-
  Load whenever writing or editing code where a run-time agent takes an action that might
  affect money, model, business model, customer/merchant data, or an agent's own autonomy.
  Provides the classification checklist and the code pattern for routing boundary-crossing
  actions to the Approval Center instead of auto-executing them. Use for any agent-action,
  monitoring self-heal, or evolution-promotion code.
---

# HITL Approval Gate

Authoritative boundary list: `docs/HITL-POLICY.md`. This skill is the how-to for enforcing
it in code. The rule: **agents act freely on reversible, low-stakes, in-policy actions;
anything touching money / model / business model / autonomy must become a human approval.**

## Classification checklist (run for every agent action)
Ask, in order — a "yes" to any means REQUIRES APPROVAL:
1. Does it change price, discount, promotion, plan, or move money (refund, payout, spend)?
2. Does it launch marketing / change ad budget / change sales-or-marketing ROI posture?
3. Does it change the business model, margin, or (PalUp side) profit margin / moat?
4. Does it change an agent's own behavior, prompt, tools, model, or **autonomy scope**?
5. (Monitoring) Does the fix/optimization change cost or resource spend beyond budget?
6. Is it irreversible or high-stakes, or outside approved templates/frequency/channels?

If all are "no," the action is auto-allowed — execute it and write it to the audit log.
If any is "yes," DO NOT execute. Create an Approval Center proposal instead.

## Code pattern
```ts
const decision = classifyAction(action);          // returns 'auto' | 'requires_approval'
if (decision === 'auto') {
  const result = await execute(action);
  await audit.record({ action, result, actor: agent.id, reversal: action.reversalPlan });
  return result;
}
// boundary-crossing: propose, do not execute
const proposal = await approvals.create({
  agentId: agent.id,
  approverRole: agent.plane === 'palup' ? 'palup_admin' : 'merchant',
  action,
  rationale: action.rationale,
  reversalPlan: action.reversalPlan,   // REQUIRED — no proposal without a way back
  boundary: decision.reasons,
});
await audit.record({ proposal, actor: agent.id });
return { status: 'pending_approval', proposalId: proposal.id };
```

## Rules
- A proposal without a `reversalPlan` is invalid — reject it.
- `classifyAction` defaults to `requires_approval` when uncertain. Ambiguity is never
  auto-allowed.
- Never add a flag or fast-path that lets an agent skip classification.
- Autonomy escalation (an agent asking for more scope) is itself a boundary crossing.
- Merchant-plane proposals go to the merchant; PalUp-plane and monitoring proposals go to a
  PalUp administrator.
