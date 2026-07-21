# Design Spec — Payments & Billing (lifecycle, adjustments, money tools)

_The complete money-path design. Attribution + metering fundamentals live in
`attribution-and-billing.md`; the Shopify settlement mapping is `ADR-0008`. This spec adds the
lifecycle, reconciliation, dunning, adjustments, PalUp-side credits/write-offs, the merchant-side
money tools, tax/currency, and the money-domain audit that make payments **fully** planned. Backs
merchant **Payments & Payouts / Billing & Usage / Plans** and admin **FinOps / Deal Close /
Expansion** + the money approval types._

**Prime invariant (everything here obeys it):** PalUp **never holds, moves, or deducts merchant
funds and stores no card/PAN.** Merchant billing settles via Shopify Billing (ADR-0008); merchant-
side money actions (refunds, etc.) are **executed by the merchant in Shopify** — the agent only
drafts and, where a scoped money tool is granted, calls Shopify on the merchant's behalf under
ceiling + HITL.

## 1. Ledgers (three, each single-truth)

- **`outcome_ledger`** — attributed incremental revenue (fee basis; `attribution-and-billing.md` §1).
- **`usage_ledger`** — credits metered per action, billable vs. absorbed (§2 there).
- **`adjustment_ledger`** *(new)* — every post-hoc money movement on PalUp's own billing:
  clawbacks, credits (SLA/goodwill), bad-debt write-offs, custom/below-floor fee deltas, and
  attribution restatements. Each entry: `{ merchant_id, kind, amount, reason, source_ref, approver,
  reversal_of?, applies_to_invoice, audit_ref }`.

An `invoice` for a cycle = `base + performance_fee(outcome_ledger) + overage(usage_ledger) +
Σ adjustment_ledger(this cycle)`.

## 2. Billing lifecycle & reconciliation

- **Cycle** aligns to Shopify's 30-day `AppSubscription` cycle (ADR-0008).
- **Usage submission:** performance-fee + overage amounts are submitted to Shopify as
  `AppUsageRecord`s under the approved `cappedAmount`. Submission is **idempotent** (dedup key =
  merchant + cycle + ledger-batch id) and written via the **transactional-outbox** (committed with
  the ledger row, same pattern as durable audit) so a charge is neither lost nor double-submitted on
  retry.
- **Reconciliation (per cycle):** compare PalUp's assembled invoice (outcome + usage + adjustments)
  against Shopify's **actually-captured** charges. Output a reconciliation record; any mismatch
  (capped-amount clipping, partial capture, currency rounding) raises a **FinOps exception** →
  Approval Center, never silently absorbed. Backs the FinOps "collection this cycle" and
  performance-fee totals.
- **Exception disposition is an audited HITL action, never auto-cleared.** Resolving/dismissing a
  reconciliation exception is an operator action written to the immutable audit log (actor+role,
  before→after, reason); the reconciliation job itself **cannot** auto-clear an exception — a
  reconciliation-tampering guard.
- **Cap interaction:** if fees would exceed `cappedAmount`, Shopify stops charging; PalUp records the
  un-billed remainder, applies the **basic-mode degradation** (§5 of `attribution-and-billing.md`),
  and surfaces the cap-hit event — it does **not** try to collect around the cap.

## 3. Dunning / delinquency state machine

```
healthy ─▶ warn (charge upcoming / cap near)
        ─▶ failed_charge (Shopify retries per its schedule)
             ├─ card/payment updated → recovered ─▶ healthy
             └─ retries exhausted ─▶ pause_proactive ─▶ basic_mode ─▶ suspend
```

- Transitions are driven by Shopify billing webhooks + retry status. **Proactive agent work pauses**
  before suspension; **live chat continues in basic mode**; **the merchant's customers never see any
  billing state** (hard invariant). Recovery (card update / successful retry) walks back to healthy.
- Mirrors admin Deal Close "failed / retrying" and the merchant billing "failed charge → pause
  proactive, Shopify retries." PalUp's own subscription collection uses the same machine.

## 4. Fee adjustments after the fact (clawbacks, restatements, corrections)

- **Returns/refunds reduce attributed revenue.** When revenue previously counted as incremental is
  later refunded/returned, the attribution engine **restates** the affected `outcome_ledger` period
  within a defined **restatement window**; the delta posts to the **`adjustment_ledger` as a
  clawback/credit on the next invoice** (never a retro-charge to a closed Shopify cycle).
- **Restatements are policy-bounded.** The restatement window *and* the per-cycle restatement
  magnitude are Policy limits; a mass restatement (e.g. an attribution recompute) that would swing
  many merchants' fees beyond the bound raises a **FinOps exception** rather than silently auto-
  posting — so an attribution change can't quietly move fleet-wide fees.
- **Routine billing corrections vs. disputes:** small, rule-bounded corrections (the admin
  "routine billing corrections" rule) may auto-apply and log; **disputed or contested amounts always
  escalate to a human** (explicit rule scope in the mockup) → Approval Center.
- Every adjustment is reversible and references the invoice/period it corrects.

## 5. PalUp-side money-out flows (ledgered, governed)

| Flow | Auto within rule | Above rule → | Ledgered as |
|---|---|---|---|
| **SLA credit** (remedy table) | ≤ $500 | HITL (Approval Center) | adjustment credit |
| **Bad-debt write-off** | ≤ $1,000 | HITL | adjustment write-off |
| **Custom / below-floor fee** | — | **two-person** (fee-floor is a margin boundary) | fee delta |
| **Goodwill credit** | within goodwill rule | HITL | adjustment credit |

Each is a proposal-or-rule (governance spec §2–3), lands in the `adjustment_ledger`, is audited with
a reversal path, and reconciles into the invoice. Fee-floor / margin-moving items are PalUp-plane
boundary crossings (`docs/HITL-POLICY.md`, `cost-margin-telemetry.md` §4).

**Separation of duties on money-out.** For *all* money-out adjustments (SLA credit, write-off,
goodwill, fee delta), the **approver ≠ the initiator**, and above an upper threshold (e.g. SLA credit
> $2,000, write-off > $5,000) approval is **two-person**. This closes the single-approver / self-
approval leakage path — no one person can grant unbounded credits or write-offs. (Reflected in
`governance-subsystems.md` §3.)

## 6. Merchant-side money tools (agent acts *for the merchant*, via Shopify)

These are **scoped Shopify money tools** an agent may be granted; granting one is an **authority
change (two-person, human-initiated)** and adding it to the money-tool allowlist is a security
approval (`security-data-path.md`, `governance-subsystems.md`).

- **Refund** (`refundCreate`): bounded by a **per-action ceiling** (e.g. auto ≤ $30; above →
  merchant approval), **duplicate-detection** (not already refunded for that order), policy-window
  check; on high-value or out-of-policy, the agent **drafts** and the **merchant executes in
  Shopify.** Run-Replay shows the guardrail step ("$24.50 ≤ $30 ✓ · within refund permission ✓ · not
  a duplicate ✓").
- **Cancellation** and **in-rule discount**: same pattern — within rule → act+log; else → proposal.
- **Chargeback / dispute**: the agent **assembles evidence** and drafts the response; submission is
  HITL. PalUp never moves the disputed funds.
- **Aggregate/velocity ceiling (money-denominated), not just per-action.** Each auto money tool
  carries a **per-merchant, per-cycle cumulative $ *and* count cap** in addition to the per-action
  ceiling; breaching either forces HITL. This stops many individually-in-policy sub-ceiling refunds
  (e.g. driven by injected customer-chat requests — `security-data-path.md` §1, or a loop bug) from
  aggregating into material un-approved money movement. It is stronger than the Policy
  blast-radius/rate limits, which are count-based, not money-based.
- Semantic firewall on all money tools; never auto above ceiling; every call audited with reversal
  pointer.

## 7. Tax & currency

- **Phase 1 (US):** rely on **Shopify Billing's tax handling** for PalUp's app charges; PalUp does
  not compute/remit SaaS tax itself.
- **Currency:** charge in the merchant's Shopify billing currency; the ledgers store currency +
  amount.
- **Multi-region (EU/VAT):** additive behind the `payments` port when residency expands (ADR-0001);
  not built in Phase 1. _(Confirm this posture.)_

## 8. Money-domain audit & reversal (completeness)

- **Every** fee, usage charge, credit, write-off, refund, dispute action, and adjustment writes an
  **immutable, hash-chained `audit_entry`** with actor+role, before→after, and an **explicit reversal
  path** (durable transactional-outbox write — `governance-subsystems.md` §6; "no silent action").
- The **per-cycle reconciliation report** (§2) is an audit artifact linking ledgers ↔ Shopify
  captures ↔ adjustments.

## 9. Invariants (tests — `test-engineer` / `security-reviewer`)

1. No code path holds/moves/deducts merchant funds or stores PAN. 2. Fee derives only from
`outcome_ledger`; absorbed items never bill. 3. Usage submission is idempotent; no double-charge on
retry. 4. Charges never exceed the Shopify `cappedAmount`; at cap → basic mode, customers unaware.
5. Refund tool respects per-action ceiling + duplicate-detection + policy window; granting it is
two-person. **5a. Auto money tools also honor a per-merchant, per-cycle aggregate $ and count
ceiling; breaching either forces HITL.** 6. Disputed/contested amounts always escalate to a human.
7. Every adjustment/credit/write-off is rule-or-proposal + audited + reversible + reconciled, with
**approver ≠ initiator and two-person above the upper threshold.** 8. Per-cycle reconciliation flags
every ledger↔Shopify mismatch to FinOps; **exception resolution is an audited HITL action, never
auto-cleared.** 9. Attribution restatements are window- and magnitude-bounded; a fleet-wide swing
raises a FinOps exception.
