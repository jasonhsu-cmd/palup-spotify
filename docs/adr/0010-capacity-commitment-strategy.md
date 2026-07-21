# ADR-0010: Capacity-commitment strategy (committed-use / reserved / spot)

- **Status:** Accepted
- **Context:** At target scale, inference + compute COGS is ~$29M/mo (`capacity-model.md` §4) and the
  87% gross-margin target depends on driving unit cost down. On-demand pricing is the most expensive
  way to buy every resource; providers offer **committed-use discounts (CUDs) / reserved capacity /
  savings plans** (20–55% off) and **spot/preemptible** compute (60–90% off) for the right workloads.
  The admin console already anticipates this — it shows a **"Vertex committed-use commitment"** cost
  approval — but no design backs it. Buying commitments is also a **money/margin decision**, so it
  must be governed, not ad hoc.

## Decision

1. **Match the purchasing mode to the workload:**
   - **Committed-use / reserved** for the predictable baseline: steady-state inference floor (Vertex
     CUDs), always-on Cloud Run/GKE baseline, Cloud SQL/storage. Cover the **trough**, not the peak.
   - **Spot / preemptible** for interruptible, restartable workloads: **eval, self-training, batch
     embeddings**, and other batch jobs (`observability-and-sre.md` §6, `model-gateway.md` §4). Never
     for latency-critical serving or the kill-switch/halt path.
   - **On-demand** only for the elastic peak above the committed baseline.
2. **Commitments are governed like any money/margin change.** Buying, raising, or letting a commitment
   lapse is a **PalUp-plane boundary crossing → Approval Center** (`HITL-POLICY.md`, the mockup's
   "committed-use commitment" approval), with the utilization/breakeven analysis attached. Never
   auto-purchased by an agent; a monitor may *propose* based on utilization, never commit.
3. **Utilization is a tracked FinOps metric.** Commitment coverage %, utilization %, and
   spot-eviction/interruption rate are telemetry (`cost-optimization.md`); under-utilized commitments
   are a margin leak surfaced to FinOps, over-100% on-demand spillover is a signal to commit more.
4. **Portability caveat (ADR-0001).** Commitments are inherently provider-specific and create *soft*
   lock-in (a sunk discount on one cloud). Keep commitment terms **short/ladder them**, size them to
   the **portable baseline** (not to speculative growth), and treat a second-cloud/second-provider
   move as a decision that weighs remaining commitment against migration benefit — the ports keep the
   *code* portable even when a commitment temporarily favors one provider.

## Alternatives considered

- **All on-demand (no commitments).** Maximum flexibility / zero lock-in. Rejected — it forfeits
  20–90% savings on wholly predictable baseline + batch load, directly hurting the margin the
  business is built on.
- **Aggressive long (3-yr) commitments sized to forecast growth.** Deepest discount. Rejected —
  over-commitment on an unproven SMB growth curve is a margin trap and hardens vendor lock-in against
  ADR-0001; ladder shorter terms sized to the proven baseline instead.
- **Spot for everything to chase max discount.** Rejected — eviction on latency-critical serving or
  the kill-switch path is unacceptable; spot is scoped to interruptible batch only.

## Consequences

- (+) Materially lower unit cost on the predictable baseline and on GPU eval/training — the biggest
  COGS lines — without touching latency-critical or safety paths.
- (+) Commitments stay governed (Approval Center) and measured (utilization telemetry), so they can't
  become an ungoverned margin leak.
- (−) Some soft, time-boxed provider lock-in (the discount is sunk on one cloud); mitigated by short/
  laddered terms sized to the portable baseline.
- (−) Spot workloads must be genuinely interruption-tolerant (checkpointing for training); adds
  engineering discipline to the eval/training pipeline.
