# Design Spec — Compute Topology & Delivery

_How PalUp's services are decomposed, run, scaled, networked, and shipped. Realizes ADR-0001
(Cloud Run + GKE, portable), ADR-0005 (event-driven workers), ADR-0006 (event bus), and the
progressive-delivery rule (ADR-0003, `release-manager`). Backs the admin **Engineering Monitor**
(service health, auto-heal/scale) and **Settings → Environments** (Production/Staging)._

## 1. Service topology

Start with a **small set of services** (ARCHITECTURE §4.2), split further only when a seam hurts:

| Service | Host | Why |
|---|---|---|
| **console-API** (merchant + admin) | Cloud Run | stateless request/RBAC/SSE; scales to zero at low traffic |
| **agent-runtime workers** | GKE | durable run loops, connection pools, GPU adjacency, long-lived (ADR-0005) |
| **scheduler** (cadence timers) | GKE | per-tenant next-action times at fleet scale (§4) |
| **monitoring plane** (eng + business monitors) | GKE | firehose consumers, self-heal loops |
| **billing/finops** | Cloud Run | cyclical + webhook-driven |
| **model-gateway** | GKE (GPU-adjacent) | caching, routing, self-trained serving (`model-gateway.md`) |
| **integration/webhook ingress** | Cloud Run | Shopify/comms/ads callbacks → event bus |

All are **independently deployable behind flags**; agents/feature code depend only on ports.

## 2. Autoscaling

- **Cloud Run** services scale on request concurrency (to zero when idle — cheap at low traffic).
- **GKE worker pools** scale on **queue depth** (ADR-0005) — the run backlog drives capacity, so cost
  tracks work not tenant count. GPU pool scales on eval/training + self-trained-serving demand.
- Per-service **resource limits + HPA**; scale events surface in the Engineering Monitor auto-heal
  table ("scaled 12→28 cells").

## 3. Networking & isolation

- **Private VPC**, VPC-SC perimeter, private service connect to data stores; **egress controls +
  allow-lists** (the agent egress allowlist, `security-data-path.md`); **Cloudflare WAF/CDN** at the
  edge. No data store is publicly reachable. Per-region networking for residency (ADR-0001/0004).

## 4. Cadence scheduler (24/7 agency at scale)

- Agents are event-driven, but nurture/replenishment/win-back need **timed triggers** for millions of
  tenants. A durable, sharded **scheduler** stores per-(tenant, play) next-fire times and enqueues
  runs on the `queue` at due time — **no persistent per-merchant process** (ADR-0005). Idempotent;
  missed ticks catch up; honors kill-switch/cap state before enqueueing.

## 5. CI/CD & progressive delivery

- **IaC** (Terraform-class) for all infra; policy checks in the pipeline (SECURITY.md); no click-ops
  in prod.
- **Pipeline:** build → SAST/DAST + dependency/license scan + SBOM → sign artifact → deploy to
  **staging** → **progressive prod rollout behind a flag (canary → full)** with automatic rollback on
  regression (`release-manager`). Every deploy is reversible and audited.
- **Build-time vs run-time separation is absolute (ADR-0002):** the CI/CD pipeline ships code humans
  merged; it is **not** a path for a run-time agent to reach production. Run-time behavior changes go
  only through the evolution pipeline (`governance-subsystems.md` §4). No pipeline step lets an agent
  self-deploy.
- **Environments:** Production + Staging (admin Settings), per-tenant residency config; secrets via the
  `secrets` port only — **never in pipeline logs, images, or IaC state** (short-lived, rotated).

## 6. Reliability & self-heal

- Monitors may restart/reroute/scale/failover/scale-to-zero automatically (Engineering Monitor
  auto-heal table); **cost-changing** fixes become Approval Center proposals (`HITL-POLICY.md` §4).
  SLOs, error budgets, and DR live in `observability-and-sre.md`.

## 7. Invariants (tests / `security-reviewer` + `release-manager`)

1. No service holds cross-tenant ambient authority; all data access is tenant-scoped. 2. No CI/CD path
promotes to prod without green tests + security scan + (for run-time agent changes) the evolution
pipeline. 3. No agent can self-deploy via the pipeline (ADR-0002). 4. Secrets never appear in logs/
images/IaC state. 5. Data stores are not publicly reachable; egress is allow-listed. 6. Every deploy
is flagged, reversible, and audited. 7. The scheduler honors kill-switch/cap before enqueueing.
