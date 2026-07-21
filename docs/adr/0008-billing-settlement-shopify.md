# ADR-0008: Billing settlement via Shopify Billing primitives

- **Status:** Accepted
- **Context:** PalUp's pricing (`docs/PRICING.md`, ADR-0007) is **base plan + performance fee on
  attributed incremental revenue + credit overage**, and the mockups are explicit that PalUp
  **never holds merchant money**: charges are "billed through Shopify," the "monthly cap is approved
  in Shopify," there is "no card, no credits" held by PalUp, and a failed charge is retried by
  Shopify. The generic `commerce.createBillingCharge` / `payments.settleViaShopifyBilling` calls in
  the design don't yet map the pricing model onto Shopify's **actual** billing primitives, which
  have hard constraints (approval-gated capped amounts, 30-day cycles, a Shopify revenue share).
  This mapping is billing-critical and must be pinned down.

## Decision

Settle **all** PalUp charges — merchant billing and PalUp's own subscription collection (admin Deal
Close) — through **Shopify's Billing API**, mapped as follows, entirely behind the `payments` /
`commerce` ports (ADR-0001):

1. **Base plan → recurring `AppSubscription`** (per-merchant, 30-day interval), one line item per
   plan tier (Launch/Starter/Growth/Pro; Enterprise = custom).
2. **Performance fee + credit overage → `AppUsageRecord`s** appended to a usage line item on that
   subscription, submitted under the merchant-approved **`cappedAmount`.** This capped amount **is**
   the UI's "overage spend cap approved in Shopify" — Shopify will not charge beyond it, which is
   also the backstop for the "billed only up to the hard cap / basic mode at cap" behavior.
3. **One-time items** (e.g. a bespoke setup) → `AppPurchase` where needed.
4. **Cycle alignment:** PalUp's internal billing period aligns to the Shopify 30-day subscription
   cycle; the outcome + usage ledgers roll up per cycle and are reconciled against Shopify's
   captured charges (see `docs/design/payments-and-billing.md`).
5. **Shopify revenue share is a first-class margin input.** Shopify takes 0% or 15% of app charges
   (shown in the admin FinOps cost stack); the margin model (`cost-margin-telemetry.md`) treats it
   as a cost line, not a rounding error.
6. **PalUp holds no funds and no card data.** No PAN is stored; PalUp cannot view/deduct from
   merchant payouts. PCI scope stays minimized (`docs/SECURITY.md` §5).
7. **The `payments` port is designed to accommodate a future non-Shopify PSP** (needed when a second
   commerce platform comes online — `docs/MOAT.md`), but **only the Shopify Billing adapter is
   concrete now.** A direct-PSP adapter is future work, gated by its own PCI review.

## Alternatives considered

- **Direct PSP (Stripe/Adyen/Braintree) now.** Full control over billing mechanics and multi-
  platform from day one. **Rejected for Phase 1** — it pulls card data / PCI scope into PalUp,
  contradicts the "never holds money" trust promise the mockups make, and duplicates billing plumbing
  Shopify already provides for its merchants. Kept as a **future** `payments` adapter behind the
  port.
- **Off-platform invoicing (ACH/wire, PalUp-issued invoices).** Rejected — worse merchant friction,
  and again introduces money handling PalUp deliberately avoids.
- **Model the performance fee as a flat recurring amount.** Rejected — it isn't the pricing model
  (fee is a % of *measured* incremental revenue), and it would over/under-bill; usage records are
  the correct primitive.

## Consequences

- (+) The "PalUp never touches the money" trust story is enforced by construction — settlement is
  Shopify's, PCI scope stays minimal.
- (+) The merchant-approved `cappedAmount` gives a hard, Shopify-enforced ceiling that backs the
  spend-cap / basic-mode UX without PalUp having to police it alone.
- (−) PalUp inherits Shopify Billing's constraints: capped amounts require merchant re-approval to
  raise, usage must be submitted within the cycle, and the 0/15% revenue share is a real margin
  cost. The billing lifecycle spec must handle these explicitly.
- (−) Multi-currency / tax follow Shopify's handling for now (US Phase 1); a direct-PSP path is
  additional future work behind the port, not free.
