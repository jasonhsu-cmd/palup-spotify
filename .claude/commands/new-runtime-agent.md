---
description: Scaffold a new run-time product agent as a governed config bundle on the shared runtime.
argument-hint: <agent name and one-line purpose>
---
Scaffold a new RUN-TIME agent: **$ARGUMENTS**

A run-time agent is a declarative bundle on the shared Agent Runtime (ADR-0002):
`role + policy + tools + memory + model-tier`. Do NOT create a new runtime or service.

Produce:
1. **Role & plane** — merchant-plane or PalUp-plane (decides who approves its proposals).
2. **Policy** — its HITL classification rules mapped to `docs/HITL-POLICY.md`; enumerate
   which actions are auto-allowed vs require approval. Default ambiguous actions to approval.
3. **Tools** — least-privilege, scoped, revocable; all via platform ports (no vendor SDKs).
4. **Memory** — what it remembers, where (vector port + Postgres), tenant-isolated.
5. **Model tier** — routine / high-stakes mapping via the model port.
6. **Governance wiring** — it enters the evolution pipeline for any behavior change; it
   cannot self-promote; it honors the three-scope kill switch; every action is audited.
7. **Tests** (via `test-engineer`) proving HITL enforcement, kill-switch, and no
   self-promotion.

Then have `agent-evolution-steward` and `security-reviewer` review before it is enabled.
