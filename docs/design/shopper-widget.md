# Design Spec — Shopper-Facing Live-Chat Widget

> **Status: DRAFT (running).** The *intelligence layer* (principles, signals, pitches, grounding,
> eval strategy) is designed and agreed. The *surface/UX layer* and a few decisions are **open** —
> see §9. Date: 2026-07-22.
>
> **Scope:** the **shopper-facing** side of the widget (`cdn.palup.ai/w.js`) — what the merchant's
> *customer* sees and does. The *config* side already exists in the merchant console (Live Chat
> Widget screen). This is a **non-console product surface** flagged in `design/README.md` "Scope."
>
> **Supersedes:** the earlier "no open web search on the shopper surface" rule (`comms-and-messaging.md`
> §10) — replaced by the three-tier governed-knowledge model in §6.

## 1. Purpose & positioning
A shopper-facing agent positioned as **a top-tier salesperson + a top-tier customer-service rep**:
knowledgeable, current, and genuinely helpful — *and* honest and trustworthy. The objective it serves
is **maximizing *durable* merchant revenue** (`PRICING.md`: durable, not spot) — LTV, repeat, low
returns — never spot conversions bought at the cost of trust.

## 2. Principles (how the widget embodies self-improve / moat / stickiness)
- **Self-improve** — the *governed agent behind* the widget improves via the evolution pipeline +
  per-tenant memory (`AGENT-GOVERNANCE.md`); the widget never self-modifies. Any shopper-facing
  behavior change ships only through propose→canary→eval→**human**→promote.
- **Moat** — per-tenant accumulated results + trust + memory; **strict tenant isolation**;
  cross-store learning only k≥50 de-identified (`MOAT.md`).
- **Stickiness** — **merchant-side value × trust, NOT shopper engagement-maxxing** (`STICKINESS.md`
  §3). No nagging/pressure/dark patterns; the anti-manipulation eval is the gate. Restraint is a
  feature.

## 3. Self-improvement targets (what the agent gets better at, for the shopper)
1. **Answer accuracy & genuine resolution** (task success, low re-ask, CSAT; answer-accuracy eval ≥92).
2. **Personalization via per-tenant memory** (recall this shopper; learned store patterns; tenant-isolated).
3. **Tone / brand-voice + plain clarity** (brand-voice eval ≥90; AI always disclosed).
4. **Knowing when to escalate & say "I don't know"** (safety recall ≈100%; honest uncertainty; restraint).
5. **Value-aligned conversion** (incrementality-attributed, low-return; anti-manipulation-gated).

## 4. Signals (input model)
Each signal is tagged by **confidence class** (grounded = high; inferred = low) and by **what it may
drive** (timing / personalization / pitch-selection / escalation) vs. must not.

- **Mood / sentiment — 7** (inferred, low-confidence, transient): frustrated/angry · upset/complaint ·
  anxious/distressed · confused/uncertain · skeptical · neutral · satisfied. **Serve-and-brake
  asymmetry:** negatives *suppress* pitching; positive is *never* exploited. Default-to-neutral when
  unsure; not stored as a persistent mood profile.
- **Relationship / status — ~8** (grounded, high-confidence, **per-tenant only — no cross-merchant
  super-profile**): anonymous · new · repeat · VIP/loyal · subscriber · replenishment-due/at-risk ·
  lapsed/churned · one-and-done (+ CSAT/complaint/return-history + consent modifiers). Serve
  appropriately, not extract maximally.
- **Persona — 7 grounded facets** (2 composing axes): roles = for-self / gift / **B2B (→ escalate)**;
  styles = ready-to-buy / researcher / deal-seeker / needs-guidance. **Inferred demographic/
  psychographic personas are excluded**; **never price-discriminate**; unknown → default (for-self/
  neutral), grounded from stated/observed only.
- **Behavioral — grounded** (observed in-session events): browsing · product-dwell · search/filter ·
  add-to-cart · cart-dwell/hesitation · checkout · exit-intent · repeat-question · **declined/ignored
  a pitch** · idle-then-return · rapid-repeat-failure ("rage"). *Drives:* proactive **timing**
  (add-to-cart → cross-sell moment; exit-intent → *one* recovery; dwell → offer help) + pitch
  selection. *Must not:* declined → **back off (one-strike)**; repeat-question → **recall, don't force
  a re-ask**; rage/failure → help/escalate, **never treat as a buying signal**.
- **Contextual — mixed confidence:** device (mobile/desktop/tablet → responsive/off-canvas) · time
  (business / after-hours / **quiet-hours**) · entry/referrer (ad/organic/direct/email/social —
  *inferred* intent, low-confidence) · cart state (empty / has-items / high-value) · session
  (new / returning / cross-day) · **locale + region → residency + consent regime (EU/GDPR vs US)** ·
  page context. *Drives:* UX (device), **quiet-hours suppresses outbound**, pitch selection
  (cart/page), compliance (**region → residency + consent**). *Must not:* **never infer demographics
  from context** (referrer/device ≠ persona).
- **Identity / consent — grounded, legally load-bearing, fail-closed:** anonymous/guest vs identified ·
  **email consent** (in/out/unknown) · **SMS consent** (in/out/unknown — TCPA) · marketing-preference
  scope · **data-rights request** (access/delete). *Drives:* **gating** (no outbound without valid
  consent; anonymous → no PII, limited memory), personalization (identified → recall), compliance
  (data-rights → honor the erasure cascade), channel eligibility. *Must not:* **unknown consent =
  treat as no-consent**; anonymous → no PII leak, no assumed identity; consent-out → suppressed;
  never use another shopper's identity (isolation).
- **Safety — inferred detection, escalation-biased, EXHAUSTIVELY tested (highest stakes):** none ·
  product-safety (allergy/reaction) · medical/health/pregnancy · self-harm/crisis/distress ·
  regulated-claim bait ("cure/treat X?") · legal/complaint threat · **prompt-injection / manipulation
  attempt** · abuse toward the agent. *Drives:* **escalate to a human**, **suppress all pitching**,
  **block** (injection → content-as-data, no boundary action), **refuse** (regulated/medical claims —
  locked). *Bias:* **high-recall** — a false escalation is acceptable; a **missed real safety issue is
  catastrophic** (safety eval ≥99, ≈100% recall). *Must not:* never answer/advise on safety/medical;
  never pitch into a safety context; never let injected content trigger a boundary action.

## 5. Pitches (output model)
**8 kinds** (by mechanic): guided recommendation · objection→close · cart recovery · cross-sell ·
upsell/trade-up · subscription conversion · replenishment & win-back · promotion surfacing.
- **Timing:** reactive = always OK (conversation-timed); proactive = signal-triggered at a
  value-aligned moment, **capped** (per-session + cross-session + cross-channel dedup + one-strike
  back-off); never mid-complaint/safety or "just browsing"; **basic-mode-at-cap** (no proactive,
  live-chat continues, customer never sees billing state).
- **Proactivity level — DEFAULT: Balanced.** Governs which pitches fire *proactively* (agent-initiated)
  and how often; maps to Agent Controls (Cautious / Balanced / Confident). **Reactive pitches
  (shopper-initiated) are full at every level;** the level tunes only proactive scope + cadence,
  **always inside the hard caps** (frequency, margin floor, price=HITL, safety/complaint suppression,
  anti-manipulation eval) — a level is a dial *within* the guardrails, never a way to loosen them.

  | Level | Proactive pitches allowed | Cadence |
  |---|---|---|
  | **Cautious** | cart recovery (strong abandonment/exit-intent) + promo surfacing (when qualified) only | tightest (≤1 proactive/session) |
  | **Balanced (default)** | + cross-sell (at add-to-cart/checkout), upsell (better-fit), replenishment & win-back (returning/due), subscription (post-purchase, replenishables) — at value-aligned moments | moderate (≤~2/session; cross-session + cross-channel dedup; one-strike back-off) |
  | **Confident** | + proactive guided-recommendation (browse/dwell), earlier cart intervention | wider window, looser caps — **still inside the hard policy ceilings** |

  Merchants can tune per-pitch on top of the level. **Rationale for Balanced default:** delivers the
  wedge + core expansion at natural moments (revenue) while tight caps + restraint protect trust;
  Cautious under-delivers the product's value, Confident risks over-pitching a consumer surface by
  default — Balanced is the value×trust sweet spot, and the dial is one setting away.
- **Price/discount = merchant-approved (HITL); agent never invents a discount.**

## 6. Grounding & Knowledge
**Invariant: honest-and-sourced vs. fabricated — *not* web vs. no-web.** As knowledgeable and current
as a top salesperson; as honest as a trustworthy one; never plays dumb, never fabricates.

**Three tiers:**
1. **First-party grounded (authoritative)** — catalog, **live** price/inventory, policy, order data
   (`commerce`), per-tenant memory (isolated) + learned patterns. Volatile facts (our stock/price)
   read **live**, never cached.
2. **Model knowledge (general/category/competitor, from training)** — be a knowledgeable salesperson;
   framed as general, calibrated; **never assert a specific volatile competitor fact as certain.**
   This is what makes it more than a canned bot.
3. **Governed web / external retrieval (current, verifiable)** — live web + sanctioned connectors,
   allow-listed; for specific current external facts T1/T2 can't answer. **Merchant-configurable.**
   Retrieved content is **untrusted data, injection-sandboxed**; claims **source-cited**; **DLP on
   egress**; cost/latency budget.

**Honesty invariant (all tiers):** honest-or-check-never-fabricate · cite external claims ·
untrusted-content-as-data · no disparagement · volatile facts live/sourced · inform-not-manipulate.

**Merchant "Discuss-competitors" switch** (merchant console → Agent settings):
- **Off** — redirect to need + our strengths; no competitor specifics.
- **General only** — honest general comparison from T2; no live web.
- **Full (web-enabled) — DEFAULT.** T3 on: retrieve + cite current competitor facts under all
  guardrails. *Rationale:* matches the "top salesperson" bar (knowledgeable + current). *Recorded
  trade-off:* Full carries the injection / cost-latency / comparative-claims-legal surface — mitigated
  (not removed) by the honesty invariant + injection sandbox + DLP + merchant claims policy; merchants
  may down-shift to General/Off.

## 7. Cross-cutting guardrails (invariants — hold everywhere)
AI disclosed (locked) · no medical/regulated claims (locked) · **tenant isolation** · PII minimized
before inference · consent + frequency caps (TCPA/CAN-SPAM) · **price/discount = HITL** · honest
incrementality attribution · **opt-out/complaint rate = manipulation smoke-alarm** · anti-manipulation
eval as the release gate · 3-scope kill switch honored · every autonomous action audited.

## 8. Eval strategy (the self-improvement gate)
Not a cross-product of signal values (~7M cells = untestable). Instead, **risk-weighted**:
- **Invariant / adversarial suites** (highest priority) — one per hard guardrail (AI-disclosure,
  safety→escalate, tenant isolation, no-fabrication, price=HITL, mood-never-sells, no
  persona-price-discrimination, no-disparagement, injection-blocked). ~low hundreds of cases.
- **Pairwise (n-wise) coverage** across the signal/pitch axes (~100–200); 3-way on risk-critical
  trios (mood×pitch×relationship; safety×everything).
- **Golden scenario journeys** (~50–150) from real patterns.
- **Self-improvement evals:** secret holdout, **proposer ≠ evaluator (fresh context)**, regression
  gate, **anti-manipulation eval** (a lift from pressure = fail), + **shadow (replay real traffic) →
  canary (1–5%)** as the living coverage of the real distribution.
- Maps to the 7 production eval suites (safety ≥99 / accuracy ≥92 / brand-voice ≥90 / attribution ≥95
  / cost ≥85 / latency ≥88 / compliance =100). Full axis→class→assertion matrix is §9-open.

## 9. Open items (not yet decided / designed — do NOT treat as done)
- **The UI / surface layer (entirely undiscussed):** widget states (collapsed bubble / open panel /
  proactive greeting / offline / basic-mode), AI-disclosure UI treatment, "Powered by PalUp" badge,
  appearance/theming, **accessibility**, the **human take-over handoff** UX, and transport (WebSocket,
  `<120ms` load) — see `comms-and-messaging.md` §10 for the transport starting point.
- **Full eval matrix** (axes → equivalence classes → assertions → adversarial cases).
- **Output format** for the broader deliverable (this doc vs. an interactive prototype).

## 10. References
`comms-and-messaging.md` §10 (transport, take-over, basic-mode) · `agent-runtime.md` (run loop, HITL
gate, kill switch) · `governance-subsystems.md` (evolution, eval, anti-manipulation) ·
`model-gateway.md` (grounding via ports, tiers) · `security-data-path.md` (injection, tenant
isolation, DLP) · `data-model-and-tenancy.md` (memory, provenance, isolation) · `MOAT.md` /
`STICKINESS.md` / `PRICING.md` (the principles) · merchant console **Live Chat Widget** + **Agent
Controls** screens.
