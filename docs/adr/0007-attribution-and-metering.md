# ADR-0007: Attribution and metering as the billing basis

- **Status:** Accepted
- **Context:** PalUp's revenue model is **outcome-based**: a percentage fee on the *incremental*
  revenue the agent creates (merchant plans show base + 4–8% of attributed revenue), plus a credit
  metering model that governs PalUp's own COGS. The merchant UI states "only *incremental* revenue
  counted" and shows attributed value next to the bill; the admin FinOps/Evolution surfaces state
  the performance fee is "charged only on incremental revenue measured **against a control group**"
  and that the **attribution/fee model gets the highest governance scrutiny** (Eval Dashboard:
  attribution-correctness suite, threshold ≥95). This makes attribution and metering **billing-
  critical infrastructure**, not analytics. `docs/PRICING.md` §2 requires conservative,
  incrementality-based attribution and explicitly forbids last-touch inflation as "the billing form
  of engagement-maxxing."

## Decision

1. **Attribution is incrementality-based, measured against a holdout/control.** For each merchant
   (and each agent play), a control group is maintained; attributed revenue is the measured lift of
   treated vs. control, not last-touch credit. The method, holdout sizing, and confidence are
   recorded per billing period and are auditable.
2. **The attribution model is a governed, versioned artifact.** Any change to attribution logic or
   the fee model is a **money/business-model boundary crossing** → it walks the full evolution
   pipeline (`docs/AGENT-GOVERNANCE.md`), must pass the **attribution-correctness eval (≥95) and the
   compliance gate (=100)**, and requires **human approval** (two-person for fee-model changes).
   Never auto-applied.
3. **Metering is a separate, deterministic ledger.** Every billable action emits a metered event
   into an append-only usage ledger with the credit model the FinOps UI defines (email = 1,
   conversation = 10, SMS = 13, image ≈ tens, video by the second, regenerate = the asset;
   overage $0.008/credit). **Absorbed/not-charged** items (background inference, agent tax,
   heartbeat, diagnostics, segmentation, memory embeddings, rejected drafts) are metered for COGS
   but explicitly **not** billed to the merchant.
4. **Two ledgers, one truth each.** The **outcome ledger** (attributed incremental revenue → the
   fee) and the **usage ledger** (credits → overage + PalUp COGS) are distinct, reconciled per
   cycle. Billing to the merchant is assembled from both and rendered transparently ("you made me
   $X, you charged $Y").
5. **PalUp never holds money.** Charges settle through **Shopify Billing**; PalUp stores no card/PAN
   and cannot deduct from merchant payouts (`docs/SECURITY.md` PCI minimization). At the merchant
   spend cap the agent degrades to basic mode (live chat continues; customers never see billing
   state) rather than over-billing.
6. **Cost side mirrors it.** The usage/COGS meter feeds per-tenant and per-category contribution-
   margin telemetry and the cost circuit-breaker (`docs/PRICING.md` §5); the margin floor is a
   governed boundary.

## Alternatives considered

- **Last-touch / heuristic attribution.** Simple, higher headline numbers. **Rejected** — it
  inflates the fee, breaches trust, and is explicitly disallowed by `docs/PRICING.md` §2 and the
  anti-manipulation guardrail.
- **Flat subscription only (no outcome fee).** Removes attribution complexity. Rejected — it inverts
  margin under variable COGS and abandons the value-aligned pricing that drives adoption (PRICING §3).
- **Bill from raw usage as the primary metric.** Rejected as the merchant-facing basis (bill-shock,
  discourages value-creating usage); kept only as a COGS meter and overage guardrail.

## Consequences

- (+) The fee is defensible and honest, which is a retention and trust asset, not just a billing
  detail.
- (+) Clean separation of "what we charge for value" (outcome ledger) from "what it costs us"
  (usage ledger) makes both auditable and independently governable.
- (−) Maintaining control/holdout groups adds product and statistical complexity, and a small
  holdout is un-monetized by design. Accepted as the cost of an honest fee.
- (−) Attribution becomes safety-critical infrastructure with its own eval suite, versioning, and
  auditability — it must be maintained to that bar.
