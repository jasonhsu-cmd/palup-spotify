# Agent Governance — Safe Self-Improvement

This document defines how run-time agents are allowed to change, who signs off, and how a
bad change is contained. It is the concrete answer to the requirement: _"OpenClaw's agent
evolution has no governance framework and it lacks HITL."_

Scope: **run-time agents** (merchant sales partner, PalUp's own partner, self-healing
monitors). Build-time Claude Code agents are governed by ordinary PR review, not this
pipeline.

## 1. Principles

1. **Self-improvement is allowed; self-deployment is not.** An agent may propose a better
   prompt, tool, policy, or model. It may never put that change in front of real users on
   its own.
2. **Gates are mandatory and ordered.** Every change walks the same path. Stages are never
   skipped, even for "obvious" improvements.
3. **Humans own the boundary.** Any promotion that changes agent behavior, or that crosses
   a money/model/business-model line, is a human decision (`docs/HITL-POLICY.md`).
4. **Everything is reversible and logged.** No change ships without a defined rollback and
   an audit-log entry.

## 2. The evolution pipeline

```
   ┌─────────┐   ┌──────────┐   ┌────────────┐   ┌───────────┐   ┌──────────────┐   ┌─────────┐   ┌─────────┐
   │ PROPOSE │──▶│  SHADOW  │──▶│ CANARY 1–5%│──▶│ EVAL GATE │──▶│ HUMAN APPROVE│──▶│ PROMOTE │──▶│ MONITOR │
   └─────────┘   └──────────┘   └────────────┘   └───────────┘   └──────────────┘   └─────────┘   └─────────┘
                                        │                │                                            │
                                        └────────────────┴─────────── regression ──▶ AUTO-ROLLBACK ◀──┘
```

| Stage | What happens | Who/what gates it | Exit criteria |
|---|---|---|---|
| **Propose** | Agent or engineer registers a candidate: new prompt/tool/policy/model + hypothesis + expected metric + rollback plan. | Automatic intake; malformed proposals rejected. | Complete proposal recorded in Evolution Console. |
| **Shadow** | Candidate runs on **0% of live traffic**, replaying real inputs; outputs compared to incumbent, never sent to users. | Automatic. | No safety violations; behavioral diff within bounds. |
| **Canary** | Candidate serves **1–5%** of traffic, segmented and reversible. | Automatic ramp with live guardrail metrics. | Live metrics ≥ incumbent, no guardrail breach for the observation window. |
| **Eval gate** | Blocking automatic evaluation suite (quality, safety, tone, task success, cost). **"Nothing ships without passing."** | Automatic, blocking. | All required evals pass thresholds. |
| **Human approve** | A named human reviews the eval results, canary metrics, and boundary impact in the Approval Center and approves/denies. | **Human** (required for behavior change and any boundary crossing). | Explicit approval recorded with the approver's identity. |
| **Promote** | Change rolls out progressively to 100% behind a flag. | Release policy. | Full rollout stable. |
| **Monitor** | Post-promotion watch for regression. | Automatic. | Steady-state; candidate becomes incumbent. |

**Auto-rollback:** a regression or guardrail breach at *any* live stage (canary, promote,
monitor) triggers immediate revert to the last-known-good version and **freezes** the
candidate for human inspection. This exact behavior already appears in the admin Event
Center mockup and must be preserved.

## 3. What each stage records (audit)

Every stage writes an immutable audit entry: `who/what proposed`, `inputs`, `metrics`,
`decision`, `approver (if human)`, `rollback pointer`. The Audit Log in the admin console
renders this. There are no silent transitions.

## 4. Roles

- **Agent (candidate author):** may propose and may run in shadow/canary; may **not** self-
  promote.
- **`agent-evolution-steward` (build-time subagent):** enforces that new/changed run-time
  agent code wires the pipeline correctly and never creates a bypass. Blocks PRs that let an
  agent self-promote or that remove a gate.
- **PalUp administrator (human):** approves promotions and boundary crossings.
- **Security reviewer (human + `security-reviewer` subagent):** required signoff when a
  change touches autonomy scope, credentials, payments, or customer data.

## 5. Guardrails that are always on

- **Kill Switch** at three scopes — single merchant, one agent-type across all merchants,
  or global — halts agents instantly regardless of pipeline stage. It is the ultimate
  override and must always work (rule #4 in `CLAUDE.md`).
- **Autonomy ceiling:** an agent can never grant itself more scope than its role policy
  allows. Scope escalation is itself a boundary crossing → human approval.
- **Cost circuit-breaker:** spend beyond budget freezes the agent and raises an alert.
- **No boundary auto-cross:** the pipeline may automate everything *except* the human
  approval and boundary crossings — those are hard-wired to require a person.
- **Value-alignment (anti-manipulation):** the eval gate must reject any candidate whose
  improvement comes from engagement-maxxing rather than delivered value — e.g. over-messaging,
  nagging, pressure tactics, or dark-pattern upsells. A lift in a stickiness/engagement
  metric is **not** a passing signal unless the eval confirms it tracks merchant (and
  customer) outcome value. Agents self-improve toward signals, so any retention metric fed
  to the loop can be gamed; the gate is what prevents that. See `docs/STICKINESS.md` §4.

## 6. How this differs from OpenClaw (the point)

| OpenClaw (per the brief) | PalUp |
|---|---|
| Evolution with no governance framework | Evolution is a fixed, gated pipeline; stages cannot be skipped |
| No human-in-the-loop | Human approval is mandatory for behavior changes and all boundary crossings |
| (implied) unsupervised deployment | Self-improvement yes, self-deployment never |
| (implied) hard to contain a bad change | Auto-rollback + freeze + three-scope kill switch, all audited |
