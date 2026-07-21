# Design Spec — Shared Agent Runtime

_One runtime hosts every run-time agent (merchant partner, PalUp partner, self-healing monitors) as
a declarative bundle `role + policy + tools + memory + model-tier` (ADR-0002). Execution model per
ADR-0005. Governance, audit, kill-switch, cost metering, and HITL are implemented **here once** and
inherited by every agent. Backs the admin **Run Replay** screen exactly._

## 1. Agent definition (config, not code)

```
Agent = {
  id, scope: { merchantId | org },
  role,                       // e.g. sales-partner, growth, support, retention, monitor
  policy_ref,                 // hard limits (Policy engine) this agent runs inside
  tools: ToolRef[],           // scoped, revocable; least privilege
  memory_ref,                 // tenant-namespaced storage + vector
  model_tier_policy,          // routine/high_stakes/canary mapping + quality floor
  autonomy_level,             // Cautious | Balanced | Confident (merchant Agent Controls)
  version                     // incumbent; candidates come from Evolution
}
```
New agent types (new industry/business model) are new bundles — no new infrastructure.

**The bundle is not self-mutable.** No run-time tool can change an agent's own `autonomy_level`,
`tools`, `policy_ref`, or `version`. Autonomy escalation is a HITL boundary crossing (`docs/HITL-
POLICY.md`) and version changes go only through the evolution pipeline — an agent can never widen
its own scope or self-promote (governance spec §4).

## 2. The run loop (traced state machine)

A **run** is one trigger-to-completion unit, enqueued via `queue.enqueueRun` (inbound event,
scheduled cadence tick, or internal signal). Workers (GKE) pull runs; the pool autoscales on queue
depth. Each run executes the loop the Run-Replay UI shows:

```
Perceive → Recall (memory) → Plan → Guardrail + verify → { Act | Escalate(HITL) | Block }
```

Every step writes a `run_trace` step-row: model tier, tokens, cost, guardrail verdict. Runs are
**idempotent** (dedup on trigger id) and **replay-safe** (webhooks retry, ADR-0006).

## 3. Hard budgets (from Policy, enforced by the runtime)

- **≤ 40 reasoning steps and ≤ 25 tool calls per run** (admin Policy screen).
- **Per-run cost budget** (tokens/compute); exceeding trips the **unbounded-consumption ceiling**
  (5× normal) → halt + alert.
- **Retry ≤ 3**, then escalate/park. Budgets are per-agent-bound limits in the Policy engine, not
  hard-coded.

## 4. HITL classification in the hot path (the core safety invariant)

Before **any** `Act`, the runtime classifies the intended action against `docs/HITL-POLICY.md`:

- **In-policy, reversible, low-stakes** → act, then write audit.
- **Boundary-crossing** (money / model / business-model / autonomy) → **do not execute**; emit an
  **Approval Center proposal** with a reversible plan (see governance spec). This is structural —
  an agent cannot execute a boundary action even if prompted/injected to (defense against
  excessive-agency and confused-deputy, `docs/SECURITY.md` §2).
- **Ambiguous** → treated as boundary-crossing (default-to-human, HITL §7).

The classifier is part of the runtime, versioned, and covered by governance tests
(`test-engineer` writes red HITL tests; a bypass is a blocking defect).

## 5. Tool invocation (least privilege, semantic firewall)

- Tools are **scoped and revocable** (`secrets.issueScopedCredential`), declared per agent.
- Money/PII tools sit behind an **allowlist + semantic firewall** (admin Policy/Security screens);
  external content is **data, never instructions** (content-as-data boundary) — injected text can
  never widen tool scope or trigger a boundary action without HITL.
- Egress/recipient allowlists + DLP/PII redaction on outbound (comms) — no bulk export tool without
  HITL (`docs/SECURITY.md` §2.4).

## 6. Kill switch (must always work — `CLAUDE.md` §3.4)

A worker reads `killswitch_state` at **run start and before every `Act`**, at three scopes
(global / agent-type / merchant). A tripped switch stops the run; merchant agents leave **safe
live-chat fallbacks** (basic mode). Halt state lives in a fast, always-available store and fails
**safe** (unknown → treat as halted for boundary actions). No agent code path may bypass this.

## 7. Memory (tenant-scoped, provenance-tracked)

- **Recall:** `vector.query(tenantNs, …)` + structured `agent_memory` reads.
- **Write:** validated, attributed writes (provenance: stated/inferred/order/consent/support/
  network) — memory is security-sensitive (memory-poisoning defense, `docs/SECURITY.md` §2.5);
  anomalous memory-driven behavior is detectable.
- Isolation: 100% tenant-namespaced; no shared mutable cross-tenant memory. Export/erase by
  namespace supports CCPA.

## 8. Model tiering & quality floor

Per-step tier via the `model` port: routine (~95%) / high_stakes (~4%) / canary (~1%, capped by
Evolution). **Quality floor:** closing / refunds / pricing / complaints never downgrade to a cheaper
tier to save cost — only breaching the floor or changing the default model is a governed change.

## 9. Cost metering & tracing

Every step calls `telemetry.recordCost(ctx, category, tokens→$)`; per-run and per-tenant cost roll
up into FinOps + the cost circuit-breaker. **~182k runs/day today → ~87M/day at target**; traces
are 100% written, 90-day retention, **forensic by-id** (no fleet-wide scrollable feed), sampled into
the eval golden set.

## 10. Self-healing monitors are just agents

Engineering/business monitors run on the same runtime with monitor roles: they may
restart/reroute/scale/retry/contain-security auto (then alert), but any cost/margin/business-model
change is emitted as an Approval Center proposal (`docs/HITL-POLICY.md` §4) — never auto-applied.
