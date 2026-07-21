# Design Spec — Governance Subsystems

_The control plane as concrete services. Realizes `docs/HITL-POLICY.md`, `docs/AGENT-GOVERNANCE.md`,
ADR-0003, and the two consoles' governance surfaces. The hierarchy is strict:_
**Policy (deterministic hard limits) ⊃ Automation Rules (conditional auto-approve) ⊃ Approval Center
(everything above the line).** _Editing a policy needs the owning role + step-up + audit; a rule
lives inside policy; anything above a rule goes to a human._

## 1. Policy engine (deterministic floor)

- Stores `policy` rows (admin **Policy & Guardrails**, ~41 active): platform budget caps, per-plan
  per-tenant COGS ceilings, send-rate limits, consent-required (locked), CAN-SPAM/TCPA (locked),
  tool/connector/egress allowlists, agent-bound limits (≤40 steps/≤25 calls, retry ≤3, 7-day
  cooldown), blast-radius ceilings (≤5% / ≤100 accounts / ≤3 concurrent / ≥7d / ≥1000 interactions),
  unbounded-consumption 5× trip.
- **Evaluated pre-action** by the runtime (§4 of the runtime spec) and by the Rules/Approval layers.
  A policy breach **blocks**; there is no "approve above policy" — policy is the hard limit. Changing
  a policy requires owning role + step-up (maker-checker on pricing/model-ops/security) + audit.

## 2. Automation Rules engine (conditional auto-approve, inside policy)

- Stores `automation_rule` rows (both consoles' **Automation Rules**): scope (discount, message,
  upsell, refund, ad-spend daily+monthly, shipping, frequency, subscription, write-off, …), limits,
  owner role, blast radius, active toggle, used-30d.
- At an agent `Act`: if the action matches an active rule **and** is within policy → auto-approve
  (logged); else → Approval Center. **Creating/editing/pausing a rule is itself audited.**
- "Approve → set as a rule" from the Approval Center writes a new rule (with the same guardrails).

## 3. Approval Center (the HITL surface + state machine)

- Aggregates `proposal` rows from every source (inbox threads/batches, customers, recovery,
  campaigns, upsell, outreach, orders; admin: pricing, cost, authority, security, creative,
  evolution, compliance, send, ad-spend). Role-scoped; searchable; grouped by urgency
  (Urgent / This week / Standing-no-deadline).
- **Proposal state machine:** `open → {approved | approved+rule | edited+approved | rejected |
  taken_over | sent_back | expired}`; each transition is audited with approver identity.
- **Expiry semantics** (load-bearing in the UI): timed proposals **fail closed** on expiry; safety
  items **never expire** and never auto-handle; standing items have **no deadline** but carry
  cost-of-delay.
- Each proposal carries: type, risk, impact $, source, why-you, basis, blast-radius, cost-of-delay,
  rollback, confidence, provenance (which agent proposed), editable draft, and **numeric-lever
  adjusters bounded by policy** (e.g. discount slider blocked below margin floor).
- **Two-person + step-up** for authority changes, security allowlist changes, pricing/fee, and model
  promotions. Decisions: Approve / Approve+rule / Edit / Reject-with-reason / Take-over
  (live-chat or email) / Send-back-with-note / Undo.
- **Batch decide-once** for homogeneous sets (e.g. "first-order discounts ≤10% ×7"). Approval-fatigue
  is tracked as a churn signal (`docs/STICKINESS.md`).

## 4. Evolution pipeline orchestration (ADR-0003, AGENT-GOVERNANCE)

- Manages `evolution_candidate` through **propose → shadow(0%) → canary(1–5%) → eval gate(auto,
  blocking) → human approve → promote → monitor**, with **auto-rollback + freeze** on any regression
  at a live stage and one-click manual rollback. Never skips a stage; **self-improve yes,
  self-deploy never**.
- **Traffic splitting** for shadow (replay, 0% live) and canary (segmented 1–5%, reversible) is a
  runtime capability keyed off `agent_version`; blast-radius ceilings (§1) are enforced by the
  orchestrator.
- **proposer ≠ evaluator:** the eval gate uses a **secret held-out set**; a candidate's author agent
  cannot see or influence it. Fleet patterns (k ≥ 50) enter as proposals, not auto-changes.
- **Change classes** (admin Evolution): pure-quality → auto-promote after gates; business / external
  / cost / compliance / billing → HITL; **authority** (grant a money tool, raise a ceiling) →
  two-person, human-initiated. Prohibited: removing/weakening a gate or granting self-promotion
  (HITL §5) — requires an explicit policy change with security signoff, not the normal flow.
- Every stage writes an immutable audit entry (`who/what`, inputs, metrics, decision, approver,
  rollback pointer). Renders the Evolution Console + Audit Log.

## 5. Eval harness (the blocking gate)

- Runs the **7 production suites** with thresholds (admin Eval Dashboard): Safety/refusal ≥99,
  Answer accuracy ≥92, Brand voice ≥90, **Attribution correctness ≥95** (fee basis), Cost/efficiency
  ≥85, Latency ≥88, **Compliance = 100 (hard gate)**. "Nothing ships without passing."
- **Anti-manipulation guardrail (AGENT-GOVERNANCE §5):** a lift in an engagement/stickiness metric is
  **not** a pass unless the eval confirms it tracks delivered value; over-messaging / nagging /
  dark-pattern upsell / attribution over-claiming is a **failed eval**, not a win.
- Produces per-candidate scorecards (per-suite Δ vs baseline + secret-holdout delta) linked to the
  Evolution decision. Candidates that clear evals but regress in canary are reverted and surfaced.
- The eval suite is **safety-critical infrastructure** — itself versioned, reviewed, and maintained
  (ADR-0003 consequence).

## 6. Audit log (immutable, tamper-evident, high-volume)

- Append-only `audit_entry`; **hash-chained** (event_hash + prev_hash) so tampering is detectable;
  **7-year** retention with tiering; **~3.1M events/day** today → ~1.5B/day at target (ingested
  async off the event bus, never on the request path).
- Every autonomous action and every operator action is logged with actor+role, action, target
  tenant, category, result, sensitivity, and **before→after diff**; step-up-verified actions flagged.
- **No silent transitions** anywhere in governance. Searchable + filterable (category/actor/time),
  exportable, and linked to Run Replay and capability-change records.

## 7. Kill switch (control-plane view)

- `killswitch_state` at three scopes (global / agent-type / merchant); platform-wide arm is Super
  Admin + hardware-key step-up + audited, with periodic drills. Enforced in the runtime (runtime
  spec §6). The control plane is the operator surface; the guarantee is in the runtime.

## 8. Invariants tests must protect (for `test-engineer` / `agent-evolution-steward`)

1. No boundary action executes without an approved proposal. 2. No evolution stage is skippable; no
self-promotion path exists. 3. Policy breaches always block; rules never exceed policy. 4. Every
autonomous/operator action produces an audit entry; the hash chain verifies. 5. The kill switch halts
runs at all three scopes and fails safe. 6. proposer ≠ evaluator; the holdout set is not readable by
candidate agents.
