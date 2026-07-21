# Design Spec — Attribution & Billing Engine

_Realizes ADR-0007. This is billing-critical, governed infrastructure (not analytics). Backs the
merchant **Revenue Home / Net position / Payments & Payouts / Billing & Usage / Plans** and the
admin **FinOps / Deal Close / Expansion** screens._

## 1. Attribution (the fee basis)

- **Method: incrementality against a holdout/control.** Per merchant and per play (cart recovery,
  upsell, win-back, nurture), a control group is maintained; attributed revenue = measured lift of
  treated vs. control over the period. **No last-touch credit** (forbidden by `docs/PRICING.md` §2).
- **Outputs per period:** `outcome_ledger_entry { merchant_id, period, play, attributed_incremental_
  revenue, control_ref, method, confidence }`. Confidence + method are stored and auditable; the
  merchant UI shows attributed value next to the bill ("you made me $X, you charged $Y").
- **Only incremental counts.** Organic/baseline revenue is excluded (merchant "6% on attributed, 0%
  on organic"). Holdout is small and un-monetized by design — the honesty cost.
- **Governed & versioned.** The attribution/fee model is a versioned artifact; any change walks the
  full evolution pipeline, must pass **attribution-correctness eval ≥95** and **compliance =100**,
  and needs **two-person human approval** (governance spec §4–5). Never auto-applied.

## 2. Metering (the usage/COGS ledger — separate from attribution)

- **Deterministic credit meter.** Every action emits `usage_ledger_entry { merchant_id, action,
  credits, billable|absorbed, cost_cogs, category, ts }`. Credit model (admin FinOps): email = 1,
  conversation = 10, SMS = 13, image ≈ tens, video by the second, regenerate = the asset; overage
  $0.008/credit.
- **Absorbed / not-charged to merchant** (metered for COGS only): background inference, agent tax,
  heartbeat, diagnostics, segmentation, memory embeddings, rejected drafts. The distinction is
  explicit and testable.
- One wallet per merchant; usage rolls up per cycle for overage + basic-mode logic.

## 3. Billing assembly (per cycle, transparent)

`invoice = base(plan) + performance_fee(6%/etc × outcome_ledger) + overage(usage_ledger beyond
included credits)`. Rendered with the value breakdown the merchant UI shows (Net position: "you keep
94%"). Plans: Launch $0+8%, Starter $99+7%, Growth $399+6%, Pro $1,200+4%, Enterprise custom (both
base and fee tiers from the Plans screen).

## 4. Money movement (PalUp never holds funds)

- Charges settle through **Shopify Billing** (`commerce.createBillingCharge` /
  `payments.settleViaShopifyBilling`). PalUp stores **no card/PAN**, cannot view/change/deduct from
  merchant payouts (merchant Payments screen; PCI minimization in `docs/SECURITY.md` §5).
- Plan/cap changes are approved in Shopify; a failed charge pauses proactive work and Shopify
  retries (dunning). PalUp's own subscriptions (admin **Deal Close**) collect the same way.

## 5. Spend cap → graceful degradation (never over-bill)

- Per-merchant **overage spend cap** (warn-at % + hard cap; tiered self-approve ≤$25k / Enterprise
  above). At cap: the agent **pauses proactive work** but **live chat keeps running in basic mode**;
  **customers never see billing state**; billed only up to the hard cap. Implemented as a Policy
  limit enforced by the runtime, surfaced by the eventing layer (cap-hit banner).

## 6. PalUp-side economics (admin FinOps)

- Same metering feeds **per-tenant and per-category COGS**, the 8-category cost stack, contribution
  margin per account, CAC/payback, NRR — see the cost/margin telemetry spec. Performance fees
  collected are reconciled against the outcome ledger.

## 7. Invariants (tests)

1. Fee is computed only from `outcome_ledger` (incremental), never usage. 2. Absorbed items never hit
a merchant invoice. 3. No code path lets PalUp move/hold merchant money. 4. At hard cap, billing
stops at the cap and live chat continues. 5. Any attribution/fee-model change is blocked without
eval-pass + two-person approval. 6. Outcome and usage ledgers reconcile per cycle.
