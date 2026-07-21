# ADR-0005: Agent-runtime execution model — event-driven, not process-per-merchant

- **Status:** Accepted
- **Context:** `docs/ARCHITECTURE.md` §3 defines one shared Agent Runtime hosting every run-time
  agent (merchant partner, PalUp partner, self-healing monitors) as a declarative bundle
  `role + policy + tools + memory + model-tier`, and describes agents as running "24/7." Taken
  literally, "24/7 per merchant" suggests a long-lived process per merchant — **infeasible at
  millions of tenants** (idle cost, connection exhaustion, scheduling). Yet the product genuinely
  needs continuous, event-triggered agency (a cart is abandoned → recover it; a chat arrives →
  answer it) and the admin console shows ~182k runs/day, avg 4.3 steps/run, avg $0.011/run.

## Decision

Model an agent as **"always on" behaviorally, event-driven mechanically.** There is no persistent
process per merchant. Instead:

1. **Triggers → work queue → workers.** Every unit of agent work is a **run** enqueued on the
   `queue` port from a trigger: an inbound event (Shopify webhook, chat message, email), a
   scheduled tick (nurture cadence, replenishment window), or an internal signal (a proposal needs
   drafting). A pool of stateless workers (GKE) pulls runs; the pool autoscales on queue depth.
   "24/7" = the trigger pipeline is always live, not a resident per-tenant process.
2. **A run is a bounded, traced state machine.** Each run executes the loop the Run-Replay UI
   depicts — **Perceive → Recall (memory) → Plan → Guardrail+verify → Act | Escalate | Block** —
   under hard budgets from Policy: **≤40 reasoning steps, ≤25 tool calls** per run, plus a per-run
   **cost budget** (token/compute), enforced by the runtime and tripped by the unbounded-consumption
   ceiling. Every step is written to the run trace (model tier, tokens, cost, guardrail verdict).
3. **HITL classification is in the hot path.** Before any `Act`, the runtime classifies the action
   against `docs/HITL-POLICY.md`. Boundary-crossing actions (money/model/business-model/autonomy)
   are **not executed** — they are emitted as Approval Center proposals with a reversible plan.
   This is enforced in the runtime, inherited by every agent, never re-implemented per agent.
4. **Kill switch checked every run, at three scopes.** A worker checks halt state (global /
   agent-type / merchant) at run start and before each `Act`. A tripped switch stops the run and
   (for merchant agents) leaves safe live-chat fallbacks. Halt state is read from a fast,
   always-available store; the switch must work even under partial outage (`CLAUDE.md` §3.4).
5. **Model tier chosen per step via the `model` port.** routine → fast tier, high-stakes →
   strong tier, canary → experimental variant (capped by the evolution pipeline). The
   quality-floor policy forbids downgrading high-stakes steps (closing/refunds/pricing/complaints)
   to save cost.
6. **Memory is tenant-scoped and read/written through ports.** Structured state in `storage`,
   long-term memory in `vector`, both namespaced by `merchant_id`; no shared mutable cross-tenant
   state (`docs/SECURITY.md` §2).

## Alternatives considered

- **Persistent process/actor per merchant.** Conceptually simplest "always on." Rejected — cost and
  scheduling do not survive millions of mostly-idle tenants; blast radius and upgrades get harder.
- **Cron-only batch agency.** Cheap and simple. Rejected — it cannot meet the real-time
  expectations (live chat 4s replies, immediate cart outreach) the UI promises.
- **One shared long-running orchestrator holding all tenant loops in memory.** Rejected — a single
  stateful choke point, poor isolation, and a large blast radius for a 24/7 system.

## Consequences

- (+) Cost tracks actual work, not tenant count — essential to the margin story and per-tenant COGS
  metering (`docs/PRICING.md`).
- (+) Governance (HITL gate, budgets, kill switch, tracing, cost metering) lives once in the
  runtime and every agent inherits it (ADR-0002).
- (+) Blast radius is one run; workers are stateless and independently deployable/rollback-able.
- (−) Requires durable, idempotent queue semantics and careful dedup (webhooks retry; runs must be
  replay-safe) — specified in ADR-0006 and the runtime spec.
- (−) Scheduled/cadence agency needs a scalable timer/scheduler design (per-tenant next-action
  times) — specified in the runtime + capacity specs.
