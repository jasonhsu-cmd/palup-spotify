# Design Spec — Cost Optimization Architecture & FinOps Program

_Consolidates the operating-cost levers across the platform and the **continuous** optimization loop
that minimizes COGS over time. Cost *control* machinery (metering, tiering, caching, circuit-breaker,
margin floor) lives in `cost-margin-telemetry.md`; capacity commitments in `ADR-0010`; this spec adds
the levers that were named-but-undesigned and the FinOps discipline that turns them into ongoing
savings. Backs the admin **FinOps & Margin** screen._

**Honest framing (read first):** a design cannot be "fully optimized" — optimization is an empirical,
continuous result measured on real traffic. This spec builds the **architecture and program** to
minimize cost; the **numbers that prove it** (per-action cost, tier mix, cache hit rates, vector
$/query, commitment utilization) are validated in operation and are the go/no-go constants in
`capacity-model.md` §6. Every cost lever below is also **quality-** and **safety-bounded**: no lever
may breach the quality floor, the HITL boundary, or tenant isolation to save money.

## 1. The cost stack and its biggest levers (by impact)

Ordered by share of the ~$29M/mo COGS envelope (`capacity-model.md` §4):

1. **Inference (largest).** Levers: tier routing 95/4/1 + quality floor; the three cache tiers
   (deflection 40% / semantic 22% / prompt 71%); **Vertex committed-use** for the steady floor
   (ADR-0010); batch/async where latency allows. A 1-pt shift routine→expensive is a margin event
   (`cost-margin-telemetry.md` §4).
2. **GPU eval & training.** Levers: **spot/preemptible with checkpointing** (ADR-0010, 60–90% off),
   scale-to-zero when idle, right-sized GPU class per job.
3. **Infra (GKE/Cloud Run/DB).** Levers: scale-to-zero (Cloud Run), autoscale-on-queue-depth (GKE),
   **committed/reserved baseline**, **right-sizing + bin-packing**, spot for batch node pools.
4. **Storage.** Levers: **partition tiering to cold storage** + retention drops (audit 7-yr tiered,
   traces 90-day, messages hot-window-then-cold); compression; dedupe.
5. **Egress (often underestimated).** Levers: keep chatty services co-located/co-region; minimize
   cross-region + provider egress; cache to avoid re-fetch; **egress is a metered cost line**, not
   only a security control.
6. **Media generation.** Levers: **draft on a cheaper tier first**, resolution/length caps on video
   (Veo), reuse/version assets, regenerate metered and bounded.
7. **Messaging / third-party.** Levers: dedup sends, batch where allowed, volume-tier negotiation.

## 2. Purchasing strategy (ADR-0010)

Committed-use/reserved for the **predictable baseline**, **spot/preemptible** for interruptible batch
(eval/training/embeddings), on-demand only for the elastic peak. Buying/raising a commitment is a
**governed money decision → Approval Center**; utilization is tracked (§4). Never auto-purchased.

## 3. Workload placement rules (cost, without breaking guarantees)

- **Latency-critical / safety path** (live chat, high-stakes steps, kill-switch, money tools): never
  spot, never a quality-floor downgrade — reliability and correctness win over cost here.
- **Interruptible / batch** (embeddings, eval, training, analytics rollups, non-urgent nurture):
  spot + off-peak + batch discounts.
- **Bursty stateless** (console API, webhooks): Cloud Run scale-to-zero.
- **Steady baseline**: committed/reserved.

### Safety-critical infrastructure is fenced off from cost cuts (hard rule)

Cost levers **may not** reduce the coverage, frequency, retention, or integrity of: the **blocking
eval harness** (incl. the eval model tier and the security evals), the **audit log** (7-yr retention
+ hash-chain integrity), **security/SOC observability**, **PII redaction / DLP**, **guardrail /
semantic-firewall coverage**, or the **kill-switch path**. These are **not** normal cost proposals —
touching them is a **gate-weakening class** change that requires an explicit policy change with named
**security sign-off** (`HITL-POLICY.md` §5), not the Approval Center cost flow. In particular:
**GPU-pool scale-to-zero must never delay or skip a blocking eval gate**, and auto-allowed self-heal
scale-to-zero (`compute-and-delivery.md` §6, `observability-and-sre.md` §3) never applies to these
components. Saving money is never a reason to see less or remember less.

## 4. The continuous FinOps optimization loop (the part that actually minimizes cost)

A standing program, not a one-time pass:
- **Instrument:** per-tenant/per-category/per-tier cost + commitment coverage % + utilization % +
  spot-eviction rate + cache hit rates + cost-per-conversation + contribution margin per account
  (all already metered — `cost-margin-telemetry.md`).
- **Detect:** anomaly detection on cost (spike, drift, unprofitable-account, under-utilized
  commitment, cache-hit regression, tier-mix drift). Cost is a first-class alert + kill-switch
  trigger (`observability-and-sre.md` §2). **Cost anomalies are cross-checked against SOC signals
  before being attributed to FinOps** — a spend spike or unbounded-consumption trip can be a
  **denial-of-wallet** attack or exfil-via-inference burst, and cost "noise" must not mask a security
  signal (`observability-and-sre.md` §4).
- **Propose → govern:** cost-reduction actions (rightsize, commit more, retune cache, reroute
  provider, cap a workload) are **Approval Center proposals** where they touch cost/margin/business-
  model (`HITL-POLICY.md` §4) — never auto-applied. A monitor proposes; a human commits.
- **Verify:** the **cost/efficiency eval (≥85)** gates any agent/model change that would move cost;
  regressions auto-revert. **Crucially, any cost lever that can affect delivered answer quality —
  even a config/infra-only one (semantic-cache similarity threshold, deflection-rule scope,
  tier-routing thresholds, media "draft on a cheaper tier") — must ALSO pass the quality /
  value-alignment eval before sign-off**, not only the cost/efficiency eval. This closes the
  "cheaper-but-worse config change slips the eval because it isn't an agent/model change" path.
  Anti-manipulation guardrail applies throughout — cost cuts must not degrade delivered value or trip
  the quality floor.
- **Review cadence:** FinOps reviews unit economics on cohort data (NRR, contribution margin, CAC
  payback, outlier accounts — `PRICING.md` §8); no structurally-unprofitable account persists.

## 5. Unit-economics guardrails

- **No structurally-unprofitable account** persists (fair-use + overage + per-plan COGS ceilings catch
  outliers — `cost-margin-telemetry.md` §3).
- **Margin floor is a hard governed boundary**; any pricing/plan/commitment change that moves margin
  is two-person + step-up via the Approval Center.
- **Quality floor and safety are never traded for cost** — the explicit non-negotiable of every lever
  here.

## 6. Invariants (tests / FinOps + `security-reviewer`)

1. No cost lever breaches the quality floor, HITL boundary, or tenant isolation. **1a. No cost lever
reduces eval / audit-retention-and-integrity / SOC / redaction / guardrail / kill-switch coverage —
that is a gate-weakening change requiring security sign-off, never a cost proposal or auto scale-to-
zero; GPU scale-to-zero never delays a blocking eval. 1b. Any quality-affecting lever (cache
threshold, deflection scope, routing thresholds, media tier) must pass the value/quality eval, not
just cost/efficiency. 1c. Cost anomalies are triaged against SOC signals before FinOps attribution.**
2. Latency-critical/safety workloads never run on spot or a downgraded tier. 3. Commitment purchase/raise is a governed
proposal, never auto-committed; utilization is tracked. 4. Cost-reduction actions touching cost/margin
route through the Approval Center. 5. Egress is metered as a cost line. 6. No structurally-
unprofitable account persists undetected. 7. The optimization constants (§ empirical) are validated on
real traffic, not assumed (`capacity-model.md` §6).
