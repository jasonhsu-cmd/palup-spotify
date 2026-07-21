# Go-To-Market Strategy

The admin console has a full "Growth (sell PalUp with PalUp)" section — prospect pipeline,
campaigns, site experiments, outreach, inbox, deal close, expansion — with nothing behind
it. This document is that backing. **No GTM is guaranteed to win.** GTM is *adversarial and
reactive*: it is a move in a game where competitors and the platform (Shopify) respond to
what works. Plan for a fast, capital-efficient engine that must out-run the responses it
provokes — not a winning move against a passive market.

## 1. The distinctive asset: the product is the GTM

"Sell PalUp with PalUp" — PalUp's own growth agent runs on the same machinery it sells.
Consequences:
- **Live proof + software-like scale.** The growth engine is a working demo and it scales
  cheaply, keeping CAC structurally low.
- **One flywheel, not two.** The GTM flywheel *is* the moat flywheel:
  `results → trust → referrals & expansion → more merchants → more learning → better results`
  (`docs/MOAT.md`).
- **Correlated risk (the catch).** Because the product is the growth engine, a product
  stumble and a growth stall are the same event. Reliability and trust (kill switch,
  auto-rollback, HITL) are therefore GTM infrastructure, not just safety.

## 2. The central problem: trust-sequencing

Merchants will not hand revenue decisions to an autonomous AI cold. The winning motion
earns autonomy in stages:

```
   LAND (assistive) ──▶ SUPERVISED (approvals) ──▶ AUTONOMOUS (within policy)
   measurable wedge      Approval Center as         trust compounded;
   fast time-to-value    the trust onramp           expansion revenue
```

- **Wedge:** start narrow with an undeniable, low-trust-barrier, measurable win —
  **cart recovery** is ideal (ROI visible in days, assistive not scary). Avoid leading with
  "AI does everything."
- **Approval Center = trust onramp.** The HITL surface is what lets a merchant grant more
  autonomy at their own pace. GTM and the HITL design (`docs/HITL-POLICY.md`) are the same
  design.
- **Expand:** once trust is established, expansion revenue (more channels, more autonomy,
  higher tiers) is the compounding, low-CAC growth — the cheapest revenue PalUp has.

## 3. Channels

| Channel | Strength | Watch-out |
|---|---|---|
| **Self-serve PLG** | Fast time-to-value wedge → low-touch signup at SMB scale | Requires excellent onboarding + instant proof |
| **Recursive agent-driven acquisition** (own growth agent) | Cheap, scalable, live demo | Cold outbound → deliverability/spam + regulatory (CAN-SPAM etc.); must stay under anti-manipulation eval + HITL |
| **Shopify App Store** | Enormous distribution | Double-edged: Shopify controls ranking/terms + take rate, and it deepens the platform-dependency moat risk (`docs/MOAT.md`); Shopify may favor its own AI (Sidekick) |
| **Agencies / Shopify Plus partners** | Higher ACV, credibility | Longer cycles; not the initial SMB motion |

Concentration on the Shopify App Store is a channel risk, not just a moat risk — diversify
acquisition as the second commerce platform comes online.

## 4. Pricing as a GTM lever

- **Outcome-based pricing** (a share of revenue the agent recovers/generates) crushes
  adoption friction — merchants pay when it works — and aligns with the trust-sequenced
  motion. Trade-off: attribution complexity and margin variability; needs clean, defensible
  measurement or the value story collapses.
- Likely blend: a low/free assistive tier to land, outcome or usage-based pricing as value
  is proven, subscription tiers for predictability at expansion. Any pricing/plan change is
  a PalUp-plane boundary crossing → administrator approval (`docs/HITL-POLICY.md`).

## 5. Unit economics reality (don't hand-wave this)

Shopify SMBs churn hard and carry low ACV. A "millions of merchants / $30B" ambition lives
or dies on CAC:LTV. The recursive agent-driven engine is the bet that keeps CAC survivable,
but it is **unproven at target scale** — treat blended CAC, payback period, net revenue
retention, and logo vs revenue churn as first-order GTM metrics from day one, not later.

## 6. Guardrails (the growth agent is not exempt)

- The PalUp growth agent inherits the **anti-manipulation eval guardrail**
  (`docs/AGENT-GOVERNANCE.md` §5): acquiring merchants via spammy/pressure tactics is a
  failed eval, not a win.
- Paid spend, pricing, offers, and business-model moves route through the Approval Center
  (`docs/HITL-POLICY.md`), never auto-applied.
- Outbound must respect deliverability and anti-spam/consumer-protection law by
  construction.

## 7. Watch-signals (business monitor)

Blended CAC + payback, net revenue retention, logo vs revenue churn, time-to-first-value,
wedge → expansion conversion, App-Store dependency share, competitor/Shopify-native
feature-parity time, outbound complaint/deliverability rates. If any single channel exceeds
a concentration threshold, or Shopify ships a native equivalent of the wedge, escalate.

## 8. Honest bottom line

PalUp has the ingredients for a **strong, capital-efficient, self-reinforcing** GTM: a
recursive engine that doubles as proof, a measurable wedge, value-aligned pricing, and a
flywheel shared with the moat. It does **not** have a guaranteed win — the motion depends on
executing trust-sequencing well, surviving SMB unit economics, diversifying off Shopify, and
staying ahead of an incumbent platform and a crowded field that will react. Design for a GTM
that must keep winning, and the console's growth metrics become a live scoreboard rather than
a victory lap.
