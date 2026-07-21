# Pricing & Packaging Strategy

This strategy is derived from PalUp's SWOT, moat (`docs/MOAT.md`), and GTM (`docs/GTM.md`).
Its goal is **maximum *durable* revenue with a healthy margin** — not spot
revenue-extraction, which (given PalUp's variable COGS and churn-prone SMB base) would
destroy both margin and adoption. The north-star metric is **Net Revenue Retention (NRR)**,
protected by a **gross-margin floor**.

> Numbers below are illustrative starting points to validate with real cohort data and
> willingness-to-pay research, not settled figures.

## 1. SWOT — through a pricing lens

| | Helpful | Harmful |
|---|---|---|
| **Internal** | **Strengths** → *pricing implication* <br>• Measurable agent-attributed outcomes → enables **value-based pricing** <br>• Recursive low-CAC growth engine → can afford a **low-friction / free-to-start** entry <br>• Trust/governance architecture → lets us charge a premium for *safe* autonomy <br>• Model-tiering → **gross-margin engine** that funds aggressive value pricing | **Weaknesses** → *pricing implication* <br>• **Variable COGS** (inference per action) → flat-rate can invert; need margin controls <br>• Unproven SMB unit economics → price must protect CAC payback <br>• Attribution complexity → outcome pricing needs honest, defensible measurement <br>• New brand → hard to charge high base fees cold |
| **External** | **Opportunities** → *pricing implication* <br>• Land-and-expand across channels/autonomy → **expansion pricing drives NRR** <br>• Outcome pricing aligns with WTP → adoption unlock <br>• Multi-platform/enterprise later → higher-ACV tiers | **Threats** → *pricing implication* <br>• Shopify native AI + crowded field → **can't over-price; value must be obvious** <br>• Capability commoditization → price on outcomes/trust, not features <br>• Regulation → pricing transparency matters <br>• Inference-cost/margin squeeze → **margin floor is non-negotiable** |

**Net read:** price on **outcomes**, land with **near-zero friction**, grow via
**expansion**, and wrap the whole thing in **margin controls** because COGS is variable.

## 2. The value metric: agent-attributed outcomes

Charge for what the merchant values and can see — recovered/incremental revenue, closed
deals, resolved issues — not seats (agents do the work) and not raw usage (bill-shock
discourages the value-creating usage that also drives stickiness).

**Honest attribution is a hard requirement.** Use conservative, incrementality-based
attribution (holdouts / control), never last-touch inflation. Over-claiming credit is the
billing form of engagement-maxxing and breaches trust — it falls under the anti-manipulation
eval guardrail (`docs/AGENT-GOVERNANCE.md` §5). A defensible outcome number is worth more
than a flattering one.

## 3. Recommended model: trust-sequenced hybrid (platform + outcome)

Packaging mirrors the GTM trust ladder (`docs/GTM.md` §2): land assistive → earn autonomy →
expand.

| Tier | Who | Base | Value component | Autonomy / scope | Purpose |
|---|---|---|---|---|---|
| **Perform (entry)** | New / SMB, trust-building | **$0 or nominal** | Small % of agent-**attributed recovered** revenue (e.g. illustrative 10–15%) | Assistive; merchant approves all boundary actions | **Land** with ~zero friction; self-funding; the wedge (cart recovery) |
| **Growth (workhorse)** | Proven value, multi-channel | Modest monthly (predictability + covers baseline COGS + reduces attribution disputes) | Lower % on outcomes (e.g. illustrative 5–8%) | Supervised autonomy within policy; email + chat + outreach + upsell | Where **most revenue** sits; graduate Perform users here |
| **Scale / Plus** | High-GMV, Shopify Plus | Higher committed base or committed spend | Capped % or committed-usage pricing | Full multi-channel autonomy, advanced controls, SLAs, dedicated support | **Higher ACV**; predictable, negotiated |

**Why hybrid, not pure-anything:**
- *Pure flat subscription* → margin inversion under variable COGS. Rejected as sole model.
- *Pure usage/per-action* → bill-shock, discourages value-creating usage, kills stickiness.
  Rejected as primary metric (kept only as a margin guardrail).
- *Pure outcome %* → best alignment, but 0 base leaves COGS uncovered on low-value accounts
  and invites attribution disputes. Used **only at entry**, then blended with a base.
- *Hybrid (base + outcome)* → predictability + margin coverage + value alignment + expansion
  headroom. **Chosen.**

## 4. Expansion levers (the real revenue — drive NRR > 120%)

Land small, expand automatically as trust and results compound:
- **More channels** (add outreach, live-chat, upsell as separate value).
- **More autonomy** (assistive → supervised → autonomous tiers).
- **More agent types** (add a service agent, a growth agent).
- **Volume / GMV bands** and **team seats** for control/visibility.
- **Insights & benchmarks add-on** (the network-effect data from `docs/MOAT.md`).

Expansion revenue is PalUp's cheapest revenue (no new CAC) and compounds with the moat
flywheel. Instrument and price for it deliberately.

## 5. Margin architecture (pricing's other half)

Because COGS is variable, pricing is incomplete without margin control:
- **Model-tiering is the gross-margin engine.** Routing ~95% of actions to a cheap tier is
  what makes value-based pricing profitable. Protect this routing; regressions are a
  margin event.
- **Per-merchant cost telemetry + circuit-breaker.** Track contribution margin per account;
  no customer should be structurally unprofitable. Fair-use thresholds + usage overage on
  the base tiers catch outliers.
- **Margin floor is a hard guardrail.** Any pricing/discount/plan/commitment change that would
  move margin is a PalUp-plane boundary crossing → **two-person administrator approval + step-up
  via the Approval Center** (`docs/HITL-POLICY.md`; consistent with
  `docs/design/governance-subsystems.md` §3 and `docs/design/cost-margin-telemetry.md` §4). Pricing
  is governed, not ad hoc and never single-approver.

## 6. Anchoring, fences, and psychology

- **Anchor price to value delivered**, not cost. If the agent recovers $10k/mo, a
  value-based fee reads as cheap; a flat $99 both under-monetizes big merchants and scares
  tiny ones.
- **Fences by autonomy and channel**, not by crippling core value — the entry tier must
  deliver a real, undeniable win (else the GTM wedge fails).
- **No lock-in pricing.** Frictionless export stays free (`docs/STICKINESS.md`); the moat is
  value, never exit friction. Do not add cancellation/exit fees.
- **Transparency.** Show attributed value next to the bill; a merchant who sees "you made me
  $X, you charged $Y" renews willingly.

## 7. Two-sided consistency

This is exactly what PalUp's own growth agent sells ("sell PalUp with PalUp"). Keep the
merchant-facing pricing and the growth agent's offers consistent; any offer/discount the
growth agent proposes is a boundary crossing requiring administrator approval.

## 8. Metrics to run pricing by

NRR (north star), gross margin & contribution margin per account, CAC payback, LTV:CAC,
attributed-value-to-price ratio (the renewal predictor), Perform→Growth graduation rate,
discount leakage, and outlier-account margin. Review pricing as a living system on cohort
data — never a one-time decision.

## 9. Bottom line

The revenue-maximizing move is **not** to extract peak price; it's to **land at near-zero
friction on honest outcomes, expand relentlessly, and defend margin with model-tiering and
governed pricing.** That maximizes durable revenue (NRR + LTV) while keeping the trust that
underpins the moat, the stickiness, and the GTM — the same flywheel, priced.
