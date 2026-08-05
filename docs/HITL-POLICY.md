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
- Issuing refunds, cancellations (incl. **subscription cancel** — it ends recurring revenue),
  or anything moving money.
- Contacting customers outside approved templates/frequency, or new outreach channels.
- Any action that materially affects the merchant's revenue.
- Changing the agent's own behavior scope (autonomy escalation).

> **Subscription skip/pause — classification approved (owner jason.hsu@framy.co, 2026-07-31),
> NOT yet enacted.** A reversible skip/pause *defers* a shipment/charge and never ends the plan or
> moves money now, so per §1 it belongs in "auto-allowed" — the owner has approved that classification.
> It is **not enacted**: the enforcement controls it relies on do not exist yet — a per-request
> **verified shopper identity** (today the widget authenticates only the merchant; the shopper is
> anonymous and `shopperId` is a constant), an **audited** autonomous action with a real reversal path,
> an **executable reversal** capability on the port, and a **skip cap / idempotency**. Both governance
> reviewers returned **BLOCK** on an un-preconditioned build. Until those prerequisites land and
> `security-reviewer` + `agent-evolution-steward` sign off, subscription **skip/pause is human-routed,
> exactly like cancel**. Design + prerequisites: `docs/adr/0016-subscription-skip-pause-selfserve.md`.

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
- A governed auto-promote carve-out for opted-in tenants (`VALUE_VOICE_PROACTIVITY` only) is
  **proposed** in `docs/adr/0014-merchant-opt-in-governed-auto-optimize.md` — **not enacted**
  (both gate agents returned BLOCK). Until that ADR is Accepted with the recorded steward +
  security sign-offs and its preconditions met, **human approval is never skipped** for any
  agent behavior/prompt/model change to real users.

> **Shopper-disposition persona layer (`DISPOSITION_STYLE` flag) — NOT yet flipped, no owner assigned
> (governance BLOCK closure, Finding 12, 2026-08-04).** `packages/widget-brain`'s persona-STYLE
> (PR-3/5/7/8) and persona-ROLE (PR-3 deferred follow-up) directives both ship behind the SAME
> `DISPOSITION_STYLE` posture flag, default OFF (inert — no production call site enables it; no
> `DISPOSITION_STYLE` env read exists anywhere in the repo). The flag now gates TWO accumulated
> behavior axes (service/guidance STYLE voice, and buyer ROLE voice + the reused b2b escalation rung),
> added across separate PRs without a single combined-surface review at flip time. Flipping it for any
> tenant is a run-time agent behavior/prompt change and is governed exactly like every other promotion
> under §5 above: it requires a named human owner and explicit Approval Center sign-off *before*
> enablement. **Neither has happened.** No env wiring, ADR, or runbook exists for the flip today — this
> note exists only to make that gap visible, not to authorize it.

> **Catalog retrieval (`CATALOG_RETRIEVAL` flag) — NOT yet flipped, no owner assigned (E1).**
> `packages/widget-brain` can narrow the CATALOG block of its system prompt to the top-k candidates a
> `CatalogRetrieverPort` returns for the shopper's turn, instead of rendering the merchant's whole
> catalog. That changes **what the agent sees and therefore what it says**, so it is a run-time
> behaviour/prompt change governed by §5 exactly like any other promotion: eval gate → shadow → canary →
> **named human approval** → promote. **None of that has happened.**
> Its inertness is structural, not just a default: the flag defaults OFF, **no `CATALOG_RETRIEVAL` env
> read exists anywhere in the repo**, and `widget-backend/src/server.ts` **does not construct the
> retriever at all**, so flipping a flag alone cannot turn it on — enabling it requires a deliberate
> composition change reviewed as part of the promotion. With it off, the prompt, every `Decision` and
> every reply are byte-identical to before the change (pinned by
> `packages/widget-brain/test/retrieval-flag-off.test.ts` against a golden captured on the prior commit).
> Two things a reviewer must weigh **at flip time**, neither settled here: retrieval **quality** (no
> recall/latency number in this repo is real — the fakes say nothing about semantic retrieval), and the
> fact that a narrowed catalog is a **partial** one, mitigated in-prompt by a rule forbidding "we don't
> carry that" from mere absence but not eliminated.

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
