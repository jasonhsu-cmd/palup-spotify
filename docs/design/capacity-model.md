# Design Spec — Capacity & Scale Model

_Answers the user's second question — "can it scale to millions of merchants, each with tens of
thousands of customers?" — with explicit numbers, named bottlenecks, and the residual risks that a
paper model cannot close (a validating load-test/PoC was **not** chosen for this phase, so those
land in the go/no-go as conditions)._

## 1. Target assumptions (illustrative — validate against real cohort data)

| Parameter | Value used | Basis |
|---|---|---|
| Active merchants (target) | **3,000,000** | "millions"; today 6,310 (admin console) |
| Customers per merchant | avg **8,000**, ceiling **~20,000** | "tens of thousands" ceiling |
| Agent runs / merchant / day | **~29** | today 182,400 runs/day ÷ 6,310 merchants |
| Conversations / merchant / day | avg **~50** (busy stores 300+) | demo store shows 312 resolved/day |
| Avg cost / run | **$0.011** | admin Run-lookup KPI |
| Model-tier mix | 95% routine / 4% high-stakes / 1% canary | architecture + Engineering Monitor |

These are deliberately conservative-but-real; §6 lists which must be empirically confirmed.

## 2. Derived data volumes (steady state at target)

| Dataset | Derivation | Order of magnitude |
|---|---|---|
| `customer` rows | 3M × 8,000 | **~2.4 × 10^10** (ceiling ~6 × 10^10) |
| `customer` storage | 2.4e10 × ~1 KB + indexes (~2.5×) | **~60 TB** |
| `message` rows/yr | 3M × 50 convos × ~4 msgs × 365 | **~2.2 × 10^11 / yr** |
| `message` storage/yr | 2.2e11 × ~0.5 KB | **~110 TB / yr** (hot window online, rest tiered) |
| `order` rows/yr | commerce-dependent | **~10^10 / yr** |
| `audit_entry` | ~3.1M/day × 365, 7-yr retention | **~1.1 × 10^9 / yr; ~8 × 10^9 retained** |
| `run_trace` | 3M × 29 runs/day = ~87M/day, ×~4.3 steps, 90-day | **~87M runs/day; ~3.4 × 10^8 step-rows online** |
| `usage_ledger_entry` | per billable action | billions/yr, rolled up per cycle |
| agent-memory vectors | per-tenant, grows with tenure | 10^9–10^10 vectors; per-tenant namespaces |

**Conclusion:** no single Postgres instance holds this. The distributed, tenant-sharded Postgres of
ADR-0004 is **required**, not optional. Tenant-keyed partitioning keeps per-query working sets small
(a merchant touches only its own shard) even as the fleet total reaches 10^10–10^11 rows.

## 3. Derived request / throughput load

| Signal | Today (6,310 merchants) | Linear projection to 3M | Note |
|---|---|---|---|
| Agent runs/day | 182,400 | **~87M/day (~1,000/s avg, peak ~3–5k/s)** | drives the run queue + workers |
| API req/s (Eng Monitor) | 4,210 | **~2,000,000/s if linear** | almost certainly super-linear-pessimistic; the #1 number to validate |
| Model tokens/min | 1.9M | **~900M/min if linear** | governed by tier mix + caching (deflection 40%, semantic cache 22%, prompt cache 71%) |
| Audit events/day | 3.1M | **~1.5B/day if linear** | append-only, partitioned; ingest must be async off the event bus |

Architecture that makes these tractable: stateless Cloud Run/GKE workers autoscaling on queue depth
(ADR-0005); at-least-once event bus with per-tenant ordering (ADR-0006); read-model projections for
counters (no base-table scans); deterministic-first deflection + semantic/prompt caching to keep
token load and cost sub-linear to traffic.

## 4. Cost → margin check (the number that must stay under the floor)

- Inference/compute COGS ≈ runs/day × cost/run = **87M × $0.011 ≈ $957k/day ≈ $29M/mo** at target.
- Gross-margin target is **87%** (admin FinOps). Holding it at $29M/mo COGS implies platform
  revenue ≈ **$220M/mo** — i.e. ~**$73/merchant/mo** all-in contribution, consistent with the
  base-plus-outcome pricing in `docs/PRICING.md`.
- **The margin lever is the tier mix.** A regression that moves routine→high-stakes routing is a
  first-order margin event (PRICING §5) — hence cost telemetry per tenant/category and the cost
  circuit-breaker are mandatory, and default-model / tier-policy changes are governed (HITL).
- Sensitivity: if avg cost/run rises to $0.02, COGS ~$52M/mo and the 87% floor breaks unless price
  or tier mix adjusts. The cost/efficiency eval suite (≥85) and per-tenant contribution-margin
  telemetry are the guardrails.

## 5. Bottleneck ranking (where it breaks first)

1. **API/edge request rate** (~2M req/s if linear) — the most uncertain and the first thing to
   load-test; mitigated by statelessness, caching, and projections, but unproven at this multiple.
2. **Message/event write path** (~10^11 msgs/yr, ~1.5B audit/day) — needs async ingest, partition
   management, and tiering discipline; a synchronous write on the request path would not survive.
3. **Vector memory** at 10^9–10^10 vectors — per-tenant namespacing keeps queries small, but total
   index cost/sizing (pgvector vs dedicated) is unresolved and cost-sensitive.
4. **Inference cost/margin** — not a throughput wall but the economic one; governed by tier mix.
5. **Distributed-Postgres operational scale** — rebalancing, backup/restore, and cross-region at
   10^10–10^11 rows is real ops work (ADR-0004 trade-off).

## 6. Residual risks a paper model cannot close (→ go/no-go conditions)

Because no validating PoC/load-test was commissioned in this phase, these are **carried as explicit
conditions** on the go/no-go and should be the first thing the build phase validates empirically:

- The **~2M req/s** projection is a linear extrapolation of one console metric; the real number and
  its super/sub-linearity must be measured on a representative slice before committing edge/API
  topology and cost.
- Per-action cost ($0.011) and the **95/4/1 tier mix** holding at fleet scale — the entire margin
  story rests on these; confirm on real traffic with the cost eval gate live.
- Vector-store economics at 10^9–10^10 vectors (engine choice + $/query + recall).
- Distributed-Postgres rebalancing/restore times at target row counts (RTO/RPO below).
- **Cache hit rates holding at fleet scale** — deterministic deflection ~40% / semantic ~22% /
  prompt ~71% (`model-gateway.md`); these keep token load and cost sub-linear to traffic, so a
  regression is a margin event.
- **Commitment utilization** — committed-use/reserved coverage vs. actual usage (`ADR-0010`); an
  under-utilized commitment is a margin leak, over-100% on-demand spillover a signal to commit more.

## 7. SLOs, reliability, DR (targets from the mockups)

- **SLOs:** p95 API latency ≤ 280 ms; availability 99.98% (error budget tracked); live-chat reply
  target ~4 s. Per-service SLOs in the Engineering Monitor (Agent API, Model Gateway, Webhooks,
  Billing).
- **Auto-heal within guardrails** (restart/reroute/scale/failover) — cost-changing fixes become
  Approval Center proposals (`docs/HITL-POLICY.md` §4).
- **DR:** tested backups/restore, documented RTO/RPO per store class, region-aware (US now,
  EU-per-tenant roadmap); the tenant-keyed layout scopes DR blast radius per shard.

## 8. Verdict

With ADR-0004 (portable distributed Postgres, tenant-sharded), ADR-0005 (event-driven runtime), and
ADR-0006 (event backbone + projections), the architecture **can** meet the storage and agency
volumes on paper, and the margin holds **if** the tier mix and per-action cost hold. The open
question is not the design's shape but the **empirical constants** in §6 — which is why they are
go/no-go conditions rather than assumptions.
