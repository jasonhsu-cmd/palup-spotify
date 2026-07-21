# Design Spec — Cost & Margin Telemetry

_Backs the admin **FinOps & Margin**, **Business Monitor**, **Engineering Monitor** (model gateway),
and **Policy** (budget) screens. Realizes the margin-architecture half of `docs/PRICING.md` §5 and
the cost-as-first-class-metric stance in `docs/ARCHITECTURE.md` §6. Cost is telemetry we gate on,
not an afterthought._

## 1. What is metered

- Every agent step calls `telemetry.recordCost(ctx, category, amount)` (runtime spec §9). Cost is
  attributed to **tenant × agent × category × model-tier**.
- **8 cost categories** (admin cost stack): Inference (Vertex Gemini Flash/Pro, self-trained
  canary, embeddings + rerank), Agent-tax/background, Infra (GKE/Cloud Run, distributed Postgres,
  object storage, observability), Eval & training (GPU), Media (Veo/Imagen/Firefly/ElevenLabs),
  Messaging (Twilio A2P + SES/SendGrid), Growth/S&M (ad platforms, prospect data, referral credits),
  Vendor stack (Shopify commission, WAF, secret manager). Each has a meter method + budget.

## 2. Two spend buckets (kept separate — they govern differently)

- **Cost-to-serve / COGS** (drives gross margin): platform monthly cap with auto-allocation across
  the 8 categories, warn-at %, burn/day, projected. Adjusting the COGS cap is a **Policy** change
  (governed).
- **Go-to-market / S&M / CAC** (drives growth efficiency, not COGS): ad spend, B2B email, content,
  prospect data — each with a ceiling. Adjusting these is an **Automation Rules** change (within the
  GTM budget policy), and real ad spend still routes to the Approval Center.

## 3. Margin computation

- **Gross margin = 1 − COGS/revenue** (target 87%); **contribution margin per account** = (attributed
  fee + base + overage) − per-tenant COGS. Blended margin ~90% shown.
- Per-plan margin model (admin FinOps): base, fee, included credits, avg/max COGS per plan, margin on
  base, effective-including-fee. No customer should be **structurally unprofitable** — outliers are
  flagged (fair-use + overage catch them).

## 4. Guardrails (enforced, not advisory)

- **Cost circuit-breaker:** per-tenant/per-agent spend beyond budget **freezes the agent** and
  raises an alert (this is also a kill-switch trigger, `docs/ARCHITECTURE.md` §6). Ties to the
  unbounded-consumption ceiling (5×) in Policy. **On a live/latency-critical path** (live chat, an
  in-flight high-stakes/money step) the freeze does a **graceful human handoff/takeover**, never a
  mid-interaction drop or a mid-money-action abort. A spike is also triaged against SOC signals
  (denial-of-wallet) — `cost-optimization.md` §4.
- **Margin floor is a hard, governed boundary:** any pricing/discount/plan change that would move
  margin is a PalUp-plane boundary crossing → **two-person administrator approval + step-up** via the
  Approval Center (`docs/HITL-POLICY.md`, `docs/PRICING.md` §5; consistent with
  `governance-subsystems.md` §3). Pricing is governed, never ad hoc and never single-approver.
- **Tier-mix protection:** the model-tier mix (≈95/4/1) is the gross-margin engine; a routing
  regression toward expensive tiers is a **margin event** flagged by the cost/efficiency eval (≥85)
  and cost telemetry. Quality floor still forbids downgrading high-stakes steps to save cost.

## 4b. Cost-optimization program

The full set of operating-cost levers (committed-use/reserved/spot purchasing per ADR-0010, egress,
right-sizing/bin-packing, storage cold-tiering, media caps, batch/off-peak placement) and the
**continuous FinOps optimization loop** are specified in `docs/design/cost-optimization.md`. This doc
owns the metering + guardrails; that doc owns the levers + the loop.

## 5. Cost-reduction levers (observed, governed)

Deterministic-first deflection (~40%), semantic cache (~22%), prompt cache (~71%), provider fallback
(<1%), scale-to-zero of idle capacity — all tracked in the Model Gateway view. Any lever that would
change cost/margin/business-model is an Approval Center proposal, never an auto-applied change
(monitoring-plane rule, HITL §4).

## 6. Metrics surfaced (business monitor)

NRR (north star), gross + contribution margin per account, cost-to-serve per conversation ($0.012
today), CAC + payback (11 days), LTV:CAC, attributed-value-to-price ratio (renewal predictor),
Perform→Growth graduation, discount leakage, outlier-account margin (`docs/PRICING.md` §8). Watch-
signals include approval-fatigue and churn-after-incident (`docs/STICKINESS.md`).

## 7. Invariants (tests)

1. Every metered step attributes cost to a tenant + category. 2. Absorbed vs billable classification
matches the billing spec. 3. Circuit-breaker freezes an agent at the configured ceiling. 4. No
pricing/margin change auto-applies. 5. Cost telemetry drives the FinOps screens off rollups, not
base-table scans (ADR-0006).
