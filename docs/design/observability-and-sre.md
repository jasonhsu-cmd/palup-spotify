# Design Spec — Observability, SRE & Eval/Training Infra

_The measurement, reliability, and ML-infra layer behind the `telemetry` port and the monitoring
plane. Backs the admin **Engineering Monitor / Event Center / Security-SOC** and the SLOs/DR in
`capacity-model.md`. Realizes the "cost/observability as first-class" stance (`ARCHITECTURE.md` §6)._

## 1. Telemetry pipeline (metrics / traces / logs / cost)

- **OpenTelemetry** instrumentation → collectors → **Grafana** (dashboards/SLOs) + **Sentry**
  (errors), all behind the `telemetry` port (portable). Logs centralized with **PII controls**
  (redaction in the logging path — no secrets/PII in logs, `security-data-path.md`).
- **Per-tenant + per-category cost** flows the same path into FinOps (`cost-margin-telemetry.md`).
- **Scale:** telemetry and the **audit/run-trace ingestion** (~3.1M audit events/day, ~87M run-traces/
  day at target) are **async off the event bus** (ADR-0006), partitioned by time, never on the request
  path. Audit writes remain durable (transactional outbox) even though downstream indexing is async.

## 2. SLOs, error budgets, alerting

- **SLOs** (from the mockups): API p95 ≤ 280 ms, availability 99.98% (error budget tracked and
  burned-down), live-chat reply ~4 s; per-service SLOs for Agent API, Model Gateway, Webhooks, Billing.
- **Alerting** on SLO burn, error-rate, latency, **cost/budget** (cost is a first-class alert and a
  kill-switch trigger — `ARCHITECTURE.md` §6), and **security** signals (§4). On-call routing (Slack,
  admin Settings); incidents always page.
- **Event Center** renders active alerts + auto-remediation history; MTTR tracked.

## 3. Self-healing (within guardrails)

- Monitors are agents on the shared runtime (runtime spec §10): restart/retry/reroute/scale/failover/
  scale-to-zero + security containment (isolate/rotate-creds/block) are **auto-allowed then alert**;
  anything that **changes cost or business model** becomes an Approval Center proposal
  (`HITL-POLICY.md` §4). Never an ungoverned action.

## 4. Security observability (SOC)

- Feeds the **Security/SOC** screen: prompt-injection/jailbreak/exfil counters, guardrail coverage,
  ATO/step-up metrics. **SIEM integration** and tamper-evident audit (`governance-subsystems.md` §6).
  Detection→containment ties to the kill switch as the top control.

## 5. Reliability & DR

- Backups/tested-restores, RTO/RPO, and BC/DR live in `data-platform.md` §2; this spec owns the
  **observability of** DR readiness (restore-test results, replication lag, error-budget) and the
  chaos/gameday practice that validates it.

## 6. Eval & training infrastructure

- **GPU pool (H100/A100 on GKE)** serves two workloads: the **blocking eval suites**
  (`governance-subsystems.md` §5) and **self-training** of Gemma/Llama candidate variants. Cost is a
  metered category (`cost-margin-telemetry.md`); the pool autoscales on demand and scales down when
  idle.
- **Training pipeline:** data curation (de-identified, k≥50 where cross-tenant — `data-model` §5) →
  train → **evaluate on the secret held-out set** (proposer ≠ evaluator) → register as an
  `evolution_candidate`. Training **never** auto-promotes; it only *proposes* into the gated pipeline.
- **Serving self-trained variants** is the canary tier via the model gateway (`model-gateway.md` §2),
  capped ≤1–5% by Evolution.
- **Training scope binds serving scope (anti-exfiltration).** A variant served **beyond its training
  tenant** must be trained **only on de-identified, k≥50 data**. A variant trained on a single
  tenant's data is **namespace-scoped to that tenant** and never served to another — closing the
  model-memorization / GPU-training-data-leakage path (`security-data-path.md` §5).

## 7. Invariants (tests)

1. No secret/PII in logs or traces. 2. Audit/run-trace ingestion is async but audit writes stay
durable. 3. Cost breach alerts and can trip the kill switch. 4. Self-heal never performs a cost/
business-model change without a proposal. 5. Training data is de-identified where cross-tenant; a
trained variant enters only as a gated proposal, never auto-promoted; **a variant is served beyond
its training tenant only if trained on de-identified k≥50 data (single-tenant variants stay
namespace-scoped).** 6. SLO/DR readiness is measured,
not assumed (restore tests + error budgets tracked).
