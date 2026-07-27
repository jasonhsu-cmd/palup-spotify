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

## 2a. Verified competitive landscape (as of July 2026)

_Calibration: competitor capabilities/pricing are **vendor- or reviewer-reported** (sourced below),
not independently tested; resolution-% are vendor claims; the market-size figure is **single-source,
directional**. My knowledge cutoff is Jan 2026 — these were web-verified July 2026._

- **Shopify native — three DISTINCT things (verified against primary sources, July 2026):**
  1. **Agentic Storefronts** (*Winter '26*, Dec 10 2025) — **off-site syndication only.** The catalog
     appears inside third-party AI clients (ChatGPT, Perplexity, Copilot, Google AI Mode, Gemini) where
     the shopper chats *and checks out in that client*; default for eligible merchants since ~Mar 24
     2026, merchant-of-record + attribution back. **Not an experience on the merchant's own domain.**
  2. **Storefront AI assistant** (*Spring '26*, Jun 17 2026) — an on-site AI sales associate delivered
     **through Shopify Inbox**, which (verified on the App Store listing) is a **free, first-party
     (developer = Shopify), merchant-*installed* app — NOT a default baked-in storefront feature.** It
     answers product/order questions, recommends, personalizes for Shop sign-in, merchant controls
     tone/rules. **Generic and support-leaning.** So the competitive shape is **app-vs-app in the App
     Store**, not PalUp-vs-a-default; Shopify's real edge is **distribution** (it can rank/promote its
     own free app), not default-presence.
  3. **Storefront MCP** (shopify.dev) — **verified a developer building block, NOT the engine of #1/#2.**
     Overview: *"connect any AI assistant to real-time commerce data… two MCP servers"*; it does **not**
     mention Agentic Storefronts or Inbox AI. This is the **on-site / custom-agent rail** — you build
     your own agent (theme-extension chat bubble + your LLM/backend) on it.
  4. **Universal Commerce Protocol (UCP) + Catalog API** (*Spring '26 dev edition*) — the infra
     **actually** under buy-side agentic commerce, which Shopify says it **co-developed with Google**:
     *"the infrastructure for how AI agents transact with merchants,"* with ChatGPT / Copilot / Shop App
     as the visible surfaces. **This — not Storefront MCP — is what powers #1 (Agentic Storefronts).**

  **Net (verified July 2026; corrects two earlier over-swings AND a shared misread):** **two rails, not
  one** — **Storefront MCP = on-site/custom** (PalUp builds its widget here); **UCP + Catalog API =
  buy-side transaction/discovery** (PalUp's cross-surface reach rides here). A free *generic* native
  on-site assistant exists (Inbox AI), so the *generic* chat widget is commoditized — but **none of these
  is a governed, self-improving, cross-tenant-learning, honest-attribution, portable agent.** On-site is
  a **live surface you build via MCP**; the bigger structural shift is off-site **buy-side (R9)** on
  UCP/Catalog. *(Exact internal wiring of UCP / Catalog / MCP / Inbox not fully mapped — stated at that
  confidence.)*
- **Competitors already shipping PalUp's exact positioning:**
  - **Rep AI** — markets itself as the *"first Agentic Commerce OS for Shopify"*: **sales + support +
    shopper intelligence, unified**, taking pre- and post-purchase actions in Shopify. This is PalUp's
    "salesperson + CSR + intelligence" wedge, **already occupied head-on.**
  - **Gorgias** — support-automation incumbent that **added a Shopping Assistant in 2026** (pre-purchase
    recs) → now sales+support. **Pricing anchor: ~$1.00 / resolved conversation** ($0.90 annual). Claims
    up to 60% autonomous; its own case studies show 26–56%.
  - **Tidio (Lyro)** — positioned "best overall" value; up to 64% ticket resolution; multi-platform.
  - **Intercom Fin** — up to 55% resolution; enterprise, custom-quoted; full order actions.
  - Plus **Manifest AI, Alby, KX Claude Shopping Agent, Selli, Zendesk AI, Ada, Klaviyo**.
- **Market:** e-commerce AI-assistant market ≈ **$4.33B (2025), ~27%/yr** *(single blog source —
  directional only).*

**Honest implications for PalUp:**
1. **"AI sales + support agent" is already taken** (Rep AI head-on; Gorgias converging). PalUp **cannot
   win on *being* one** — only on **how**: governed two-plane self-improvement (HITL, no auto-deploy),
   value-aligned/anti-manipulation, **auditable/defensible attribution**, the **per-tenant compounding
   moat**, and portability.
2. **Pricing has a hard anchor (~$1/resolution).** PalUp's durable-revenue model must be **legible
   against that number** or it loses the SMB comparison (see R4).
3. **The widget's on-site surface is contested but live — build it on Storefront MCP.** A free *generic*
   native on-site assistant (Inbox AI) commoditizes the *generic* widget, but MCP is the sanctioned path
   to build a deeper on-site agent on the merchant's own domain. The defensible reframe is **not** "a
   better chat widget" but **the merchant's governed, attribution-honest agent across *every* surface**
   — on-site (built on **Storefront MCP**) **+** the off-site buy-side channels (via **UCP / Catalog API +
   Agentic Storefronts**) — leaning on governance + honest attribution + portability, which neither the
   generic native assistant nor the buy-side platforms provide per-merchant. Buy-side (R9) is the larger
   structural shift.

## 2b. Beachhead vertical & ICP — Health & Wellness DTC (lead skincare/beauty → fast-follow supplements)

**Focus; don't go horizontal.** A horizontal "AI sales+support widget" fights a free first-party app
(R1) and an occupied positioning (R2). A vertical with domain depth + compliance is something neither
Shopify's generic Inbox AI nor the horizontal leaders build — and it **flips the honesty headwind (R3)
into a must-buy.**

**The pick:** the **Health & Wellness DTC** cluster. **Lead skincare/beauty** (fastest proof — the eval
corpus is already this vertical and incumbents lack the depth), **fast-follow supplements/wellness**
(highest governance premium + retention).

**Sizing (web-verified July 2026; figures reported / mostly single-source — directional):** beauty
ecommerce ≈ **$580B (2025)**, skincare **>$180B by 2026** (~42% of beauty, fastest-growing), DTC beauty
on Shopify **+15–20%/yr**; US supplements **$68.74B (2025)**, online **$38B**; **Shopify hosts 45,000+
live supplement stores, +169% YoY**; **subscription retention 55–70%**.

**Why it scores on every beachhead criterion:**
- **Advice-driven** (ingredient / skin / shade / regimen) → the "top salesperson" value is real, and
  **incumbents lack it** — Rep AI is documented as *lacking "ingredient analysis, skin assessment, or
  shade matching."*
- **Safety/compliance stakes** → governance is a **legal must-have** (below).
- **Returns + replenishment + subscription** → durable-LTV pricing, win-back, subscription pitches, and
  per-tenant memory all pay off (retention data confirms).
- **Dense on Shopify** + **fragmented** (Shopify won't build vertical depth).

**The R3 flip — with enforcement data (governance = a compliance product merchants must buy):**
merchants are **liable for what their chatbot says** — an AI **disease claim = same regulatory weight
as a label claim**; **FDA issued its first AI-specific warning letter (Apr 2026); FTC won a $4M
supplement-claims judgment the same month; ~$53k/violation; the FDA now runs AI surveillance scanning
storefronts for non-compliant claims.** PalUp's **regulated-claim + honest-uncertainty +
safety-escalation** guardrails enforce exactly the FDA structure/function-vs-disease line — "your
store's AI **cannot** make a non-compliant claim and escalates safety correctly" is a paid feature here.

**Honest caveat — the wedge is contested, not virgin:** **Octane AI** owns quiz-discovery for
beauty/skincare/supplements (~$50/mo, but a *quiz*, not a governed agent); **Alhena.ai** already markets
*"AI for supplement compliance."* PalUp's edge must be the **full governed agent** (governed
self-improvement + per-/cross-tenant moat + honest attribution + cross-surface: MCP on-site + UCP/Catalog
buy-side) — **not** a point quiz or a compliance checker. Win on the whole stack, in a vertical.

**Avoid as beachhead:** fashion/apparel (returns real, governance stakes low, most commoditized);
generic commodity retail (governance = over-engineering). **Expansion path:** pet health · specialty
food/allergen · baby/maternity (same advice + safety + subscription shape).

**Not an architecture change** — verticalizing is a GTM focus; the platform stays horizontal and
portable (ADR-0001).

## 3. Channels

| Channel | Strength | Watch-out |
|---|---|---|
| **Self-serve PLG** | Fast time-to-value wedge → low-touch signup at SMB scale | Requires excellent onboarding + instant proof |
| **Recursive agent-driven acquisition** (own growth agent) | Cheap, scalable, live demo | Cold outbound → deliverability/spam + regulatory (CAN-SPAM etc.); must stay under anti-manipulation eval + HITL |
| **Shopify App Store** | Enormous distribution | Double-edged: Shopify controls ranking/terms + take rate, and it deepens the platform-dependency moat risk (`docs/MOAT.md`); Shopify may favor its own AI (Sidekick) |
| **Agencies / Shopify Plus partners** | Higher ACV, credibility | Longer cycles; not the initial SMB motion |

Concentration on the Shopify App Store is a channel risk, not just a moat risk — diversify
acquisition as the second commerce platform comes online.

## 3a. The two motions, sequenced — bottom-up leads, top-down follows (+ agency play)

**Not "both at once."** Two motions run full-tilt from zero = focus dilution (the classic dual-motion
failure). Sequence them:

- **Bottom-up (primary, now).** PLG via the App Store: self-serve, instant-proof onboarding, the
  cart-recovery wedge (§2), Shopify Billing. Also the **cold-start solver** — it generates the data the
  per-tenant moat needs (R5). **Positioning here = ROI + "attribution you can defend to your CFO"** —
  turn honest measurement into the sell, not a handicap.
- **Top-down (sequenced; follows the usage signal).** *Not* classic enterprise ABM — **channel/agency-
  led + Shopify Plus / mid-market**, triggered once bottom-up surfaces expansion/portfolio signal.
- **The governance flip (the key insight).** PalUp's governance / anti-manipulation / brand-safety
  posture is a **headwind bottom-up** (solo SMBs buy the bigger headline number) but a **tailwind
  top-down** (Plus brands + agencies buy on brand safety, compliance, and auditable behavior — their
  reputation is on the line). **Route the trust story up-market and the ROI story down-market — one
  product, two value props.**

**Agency-channel play (the top-down force multiplier):**
- **Why agencies:** a Shopify agency/SI manages a *portfolio* of stores — one signed agency = many
  merchant deployments. Highest-leverage top-down lever in Shopify-land, and far cheaper than direct
  SMB sales.
- **The pitch to the agency *is* governance:** "deploy an AI sales+support agent across your clients
  **without risking their brand** — HITL, kill switch, anti-manipulation eval, auditable actions,
  per-client isolation." Exactly where competitors' ungoverned automation is a *liability* for an
  agency answerable to many clients.
- **Mechanics:** an **agency/partner program** — a multi-store console (portfolio view, per-client
  isolation + kill switch), **margin/rev-share**, co-selling + onboarding enablement, governance as the
  differentiator (optional partial white-label *under* the governance guarantees). Every agency-plane
  action still routes through the same HITL/audit surfaces (`docs/HITL-POLICY.md`).
- **Sequencing gate:** stand this up **after** bottom-up proves the wedge and yields reference results
  — agencies buy proof, not promises.

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

## 5a. Risk register

Severity = how existential. Each carries the **early-warning signal** the business monitor watches
(feeds §7). This makes "no guaranteed win" concrete instead of a disclaimer.

| # | Risk | Severity | Why it bites | Mitigation | Early-warning signal |
|---|---|---|---|---|---|
| R1 | **Free first-party *installable* app** (Shopify Inbox AI, Spring '26) competes app-vs-app | Med-High | Not default-on — a free Shopify-made app in the same App Store, sets a free generic baseline, and Shopify can give it ranking/placement (distribution) advantage | **Build on Storefront MCP** (don't reinvent commerce plumbing); win on governance + auditable attribution + per-tenant voice/memory + cross-platform portability + depth — beat the *free first-party* option, don't fear a default; watch App-Store ranking bias | Inbox pre-install/promotion rising; churn to "Shopify Inbox is free and does enough"; Inbox-AI depth approaching parity |
| R1b | **Shopify protocol dependency** — both rails are Shopify's: Storefront MCP (on-site) + UCP/Catalog API (buy-side, co-developed w/ Google) | Medium | Shopify controls the rails PalUp's cross-surface agent rides | Keep the agent portable behind PalUp's own ports (ADR-0001); MCP/UCP are adapters, not the core; UCP being an open-ish Shopify+Google standard slightly lowers lock-in | Shopify restricting MCP/UCP terms/scope for third parties |
| R9 | **Buy-side disintermediation of the storefront** — shoppers buy via ChatGPT / Copilot / Perplexity / Google AI Mode, not on the merchant's site | **Existential / structural** | The on-site widget serves a shrinking share of the journey; a platform stands between brand and buyer and decides what's shown | Be the merchant's **governed cross-surface agent** — on-site *and* syndicated to buy-side channels (MCP/Agentic Storefronts) — with honest attribution across channels and portability off Shopify | Share of orders via agent channels rising; on-site session/conversion share falling |
| R2 | **Positioning already occupied** (Rep AI = same "Agentic Commerce OS"; Gorgias converging) | High | Can't win on *being* sales+support; buyers perceive parity | Differentiate on governance + auditable attribution + compounding moat — never on the commodity claim; **verticalize into a domain incumbents lack depth in (§2b)** | Competitors matching governance/attribution messaging; adding beauty/supplement depth |
| R3 | **Honesty-as-marketing headwind** (conservative attribution → lower headline ROI than inflating competitors) | High (bottom-up) | SMBs buy the bigger number | Make defensible attribution *the feature* ("CFO-/audit-proof"); route the trust story up-market (§3a); **beachhead in regulated health/wellness where governance is a legal must-buy (§2b) — this flips the headwind** | Win/loss lost to "their number was higher" |
| R4 | **Per-resolution price anchor (~$1) vs the durable-revenue model** | Med-High | If the model isn't legible against $1/resolution, PalUp loses the SMB comparison | Publish an apples-to-apples equivalence; tier; keep COGS (Gemini; Fable premium-only) under the anchor | CAC / close-rate degrading on pricing objections |
| R5 | **Cold-start: moat weakest exactly at acquisition** | Medium | New merchants have no data; the compounding advantage is absent Day 1 | Data-free Day-1 value (the wedge works pre-moat) | High trial→paid drop before value compounds |
| R6 | **SMB unit economics / churn** (low ACV, hard churn) | Medium | Erodes the LTV/durable-revenue thesis from both ends | Durable-value pricing + stickiness; the agency channel raises effective ACV | NRR <100%; payback period stretching |
| R7 | **Dual-motion focus dilution** | Medium | Both motions from zero → neither works | Sequence: bottom-up leads, top-down on signal (§3a) | Top-down spend before bottom-up proof |
| R8 | **Top-down raises Shopify-visibility + incumbent collision** | Medium | Plus deals go head-to-head with Gorgias/Intercom and put you on Shopify's radar | Lead with governance (their weak spot); avoid pure feature fights | Losing Plus deals to incumbents on breadth |

**Kill / falsify conditions (rethink the whole motion, don't tweak):** Shopify's *generic* on-site
assistant (R1) closes the depth gap and reaches governance/attribution parity · buying shifts
decisively to buy-side agents (R9) and PalUp has no cross-surface play there · PalUp can't get COGS
under the ~$1/resolution anchor at SMB scale · governance fails to convert **even up-market**. Any one
= strategy pivot. **Framing note:** Shopify has already shipped a *generic* on-site assistant + off-site
syndication (not a governed, deep, portable agent), so the widget's defensibility rests on the
**cross-surface + governance + build-on-MCP** reframe above — not on being first to an on-site chat
agent (that ship has sailed) nor on assuming Shopify can't/won't (it partly has).

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

## 9. Sources & calibration (competitive landscape, §2a / §5a)

Web-verified **July 2026** (my training cutoff is Jan 2026). Competitor capabilities, pricing, and
resolution-rates are **vendor- or reviewer-reported**, not independently tested by us; the market-size
figure is **single-source and directional**. Verify current specifics before betting spend on them.

- Shopify Sidekick / Magic (incl. Winter '26 "Pulse" proactive features): [shopify.com/sidekick](https://www.shopify.com/sidekick) · [wearepresta — Sidekick 2026](https://wearepresta.com/shopify-sidekick-features-2026-the-merchants-guide-to-agentic-commerce/) · [trueprofit — 15+ Shopify AI features (Jul 2026)](https://trueprofit.io/blog/shopify-ai-features-2026)
- Gorgias AI Agent pricing (~$1/resolution) + Shopping Assistant: [myaskai — Gorgias Automate guide 2026](https://myaskai.com/blog/gorgias-automate-ai-agent-complete-guide-2026) · [getmacha — Gorgias AI Agent explained](https://www.getmacha.com/blog/gorgias-ai-agent-explained)
- Rep AI "Agentic Commerce OS", Tidio Lyro, Intercom Fin, landscape: [hellorep — AI shopping assistants](https://www.hellorep.ai/blog/ai-shopping-assistants) · [eesel — best Shopify chatbot apps](https://www.eesel.ai/blog/best-shopify-chatbot-apps) · [gominimal — top AI agents for Shopify 2026](https://gominimal.ai/blog/top-ai-agents-support-chatbots-shopify-2026)
- Market size (~$4.33B 2025, ~27%/yr) + Rep AI / Gorgias shopping assistant: [vellum — best AI assistants for Shopify](https://www.vellum.ai/blog/best-ai-assistants-for-ecommerce-shopify-stores) · [eesel — Shopify AI shopping assistant guide](https://www.eesel.ai/blog/shopify-ai-shopping-assistant-guide)
- **Shopify shopper-facing storefront agent (R1) — primary sources:** [Shopify — Agentic Storefronts, Winter '26](https://www.shopify.com/news/winter-26-edition-agentic-storefronts) · [Shopify — Spring '26 merchant edition (Inbox on-site AI sales associate)](https://www.shopify.com/news/spring-26-edition-merchant) · [Shopify — Spring '26 dev edition (UCP + Catalog API, co-developed w/ Google)](https://www.shopify.com/news/spring-26-edition-dev) · [Shopify Editions — Spring '26](https://www.shopify.com/editions/spring2026) · [shopify.dev — Storefront MCP overview (dev building block)](https://shopify.dev/docs/apps/build/storefront-mcp) · [Shopify Inbox app listing](https://apps.shopify.com/inbox)
- **Buy-side disintermediation (R9):** [Tinuiti — agentic commerce](https://tinuiti.com/blog/commerce/agentic-commerce/) · [alhena — ChatGPT vs Perplexity vs Gemini vs Google AI Mode](https://alhena.ai/blog/ai-shopping-platforms-comparison-chatgpt-perplexity-gemini/) · [opascope — agentic commerce protocols 2026](https://opascope.com/insights/ai-shopping-assistant-guide-2026-agentic-commerce-protocols/)
- **Beachhead vertical sizing + compliance (§2b):** [ringly — skincare industry statistics 2026](https://www.ringly.io/discover/skincare-industry-statistics-2026) · [easyappsecom — Shopify health & wellness guide](https://easyappsecom.com/guides/shopify-health-wellness-ecommerce-guide) · [foundrycro — DTC supplements benchmarks 2026](https://foundrycro.com/blog/dtc-supplements-marketing-benchmarks-2026/) · [alhena — best AI for DTC beauty (incumbent depth gap)](https://alhena.ai/blog/best-ai-dtc-beauty-brands/) · [alhena — AI for supplement compliance (contested wedge)](https://alhena.ai/blog/ai-health-supplement-brands-compliance-support/) · [trytruli — FTC health claims 2026](https://trytruli.com/blog/ftc-health-claims-what-supplement-brands-need-to-know) · [influencers-time — AI health-claims FTC/FDA checklist](https://www.influencers-time.com/ai-assisted-health-claims-checklist-for-ftc-and-fda-risk/)

_Calibration for §2b: market-size figures are reported / mostly single-source (directional, not
audited); the enforcement facts (FDA first AI warning letter Apr 2026, FTC $4M judgment, AI storefront
surveillance) and the incumbent depth-gap/contested-wedge notes are reviewer-reported — verify specific
figures before betting spend._

_Calibration: Shopify Edition facts are from Shopify's newsroom + reputable recap blogs; buy-side usage
numbers (e.g. ChatGPT ~800M WAU / 50M daily shopping queries) are **reported, not audited**; two of the
four planned searches this session returned a transient "unavailable" error, so the ACP/OpenAI-Stripe
protocol specifics were **not** independently confirmed here — treat those as unverified pending a
re-check._
