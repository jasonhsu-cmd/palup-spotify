# Human-in-the-Loop (HITL) Boundary Policy

This is the definitive list of what an agent may do on its own versus what must route to a
human via the **Approval Center**. Both the merchant-side and PalUp-side agents follow the
same shape; only the "who approves" differs. When a case is ambiguous, treat it as
**requires approval**.

## 1. The rule in one sentence

> Agents may act freely on **reversible, low-stakes, in-policy** actions and must get human
> approval for anything that changes **money, model, or business model** — i.e. revenue,
> margin, pricing, marketing/ROI spend, the business model, or an agent's own autonomy.

## 2. Merchant plane (agent acts for a Shopify merchant; **merchant** approves)

**Auto-allowed (act, then log):**
- Answering customer questions in live chat / email within policy.
- Drafting content, campaign ideas, and upsell suggestions (proposing ≠ launching).
- Routine customer nurture messages within pre-approved templates and frequency caps.
- Tagging, segmenting, and updating internal CRM notes.
- Read-only Shopify operations (looking up orders, inventory, customer history).

**Requires merchant approval:**
- Anything changing **price, discounts, or promotions**.
- **Launching** a marketing campaign or paid spend / changing ad budget.
- Changes to the merchant's **sales or marketing ROI** posture or business model.
- Issuing refunds, cancellations, or anything moving money.
- Contacting customers outside approved templates/frequency, or new outreach channels.
- Any action that materially affects the merchant's revenue.
- Changing the agent's own behavior scope (autonomy escalation).

## 3. PalUp plane (agent acts for PalUp; **PalUp administrator** approves)

**Auto-allowed (act, then log):**
- Responding to prospect/merchant questions in chat/email within policy.
- Drafting outreach, growth-campaign ideas, and expansion (upsell) suggestions.
- Routine support resolution within playbooks.
- Read-only analytics and pipeline updates.

**Requires administrator approval:**
- Anything affecting **PalUp's profit margin**.
- **Pricing/plan** changes, discounts, or offers to merchants.
- Launching paid acquisition spend or changing **sales/marketing ROI** posture.
- Changes to **PalUp's business model** or moat strategy.
- Collecting or altering **revenue** flows.
- Autonomy escalation for any PalUp-side agent.

## 4. Monitoring plane (self-healing)

**Auto-allowed (self-recover / self-optimize):**
- Restart, retry, reroute, scale, cache, and revert failed components.
- Apply non-cost-changing performance and reliability fixes.
- Contain security incidents (isolate, rotate short-lived creds, block) — then alert.

**Requires administrator approval:**
- Any fix or optimization that **changes cost** or resource spend beyond budget policy.
- Anything that changes the **business model**, margin, or ROI.
- Anything that changes an agent's autonomy or a policy boundary.

## 5. Evolution boundary (ties to `docs/AGENT-GOVERNANCE.md`)

- Proposing / shadow / canary of an agent change: **auto-allowed** (contained, reversible).
- **Promotion** of any agent behavior/prompt/model change to real users: **requires human
  approval** — always.
- Removing or weakening a gate, or granting an agent self-promotion: **prohibited** (not
  even approvable through the normal flow; requires an explicit policy change with security
  signoff).

## 6. How this is enforced in code

- Every agent action is classified against this policy before execution. Boundary-crossing
  actions are converted into **Approval Center proposals** with a reversible plan, not
  executed.
- The `hitl-approval-gate` skill (`.claude/skills/hitl-approval-gate/`) gives Claude Code a
  checklist for wiring this correctly whenever it builds or edits agent-action code.
- The `/governance-check` command runs before merging anything that might touch a boundary.
- The Approval Center, Automation Rules, and Audit Log in both consoles are the human-facing
  surfaces for this policy.

## 7. Default when unsure

If you cannot confidently place an action in "auto-allowed," it is "requires approval."
Reversibility and stakes decide; cost, model, and business-model impact always decide
toward a human.
