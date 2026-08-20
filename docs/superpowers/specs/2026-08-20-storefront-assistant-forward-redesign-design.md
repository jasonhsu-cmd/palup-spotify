# Storefront + Assistant "Assistant-Forward" Revenue-UX Redesign — Design

**Date:** 2026-08-20
**Status:** Draft for review (brainstorming output; precedes an implementation plan)
**Approach:** A — "Assistant-forward refresh" (evolve the current IA; elevate the assistant to a prominent, memory-aware, trust-forward, calm partner)

## 1. Context & objective

The sample storefront (`packages/widget/public/storefront/*`, served at `/`) and the embeddable chat
widget (`packages/widget/public/index.html` = `/embed/panel`, loaded by `packages/widget/src/loader-core.ts`)
are the shopper-facing surface of PalUp. This redesign elevates their UI/UX toward a professional, light-toned,
easy-to-read, simple, mobile-aware experience that advances the **dual objective**:

- **Merchant revenue** — the embeddable widget converts more shoppers on real merchant stores.
- **PalUp revenue** — the demo storefront is a credible sales tool that converts merchant prospects.

**Moat/stickiness thesis (grounded in `docs/MOAT.md` + `docs/STICKINESS.md`, not invented here).** The UI is
**not** the moat — a storefront is copyable in a weekend. The moat is *per-merchant accumulated results +
trust*, *agent memory*, *per-tenant self-improvement (the flywheel)*, and *privacy-safe network learning*, spun
as a flywheel. This redesign's honest job is to be the moat's **surface**: make the accumulated relationship
*visible*, *invite* the engagement that feeds memory + the attributed-outcome flywheel, and *protect the trust*
that is the retention substrate — **without** manufactured retention. `MOAT.md §6`: there is no perfect moat;
design for one that must be defended.

## 2. Scope

**In scope (one design language, delivered in two buildable stages):**
- **Stage 1 — the widget** (`packages/widget`: `public/index.html` panel + `src/loader-core.ts`): the assistant
  panel redesign and its three states, memory/trust surfacing, the labeled launcher pill, and the mobile
  full-height sheet.
- **Stage 2 — the storefront page** (`packages/widget/public/storefront/*`): the calm hero entry, grid/readability
  polish within the existing light theme, and the persistent mobile entry.

**Out of scope:** the merchant/admin consoles (deferred, unbuilt); any change to `selectPitch`/money/offer/pitch
mechanics; any new backend capability (this is UI wiring over existing seams); any framework/stack change.

## 3. Non-negotiable constraints (these bound every design decision)

1. **§3 (CLAUDE.md).** The revenue lever here is **conversion, clarity, trust, speed** — never agent-tuned
   money mechanics. The assistant must not surface offers, discounts, urgency, or money-gated pitches unless the
   *merchant* authorized them through the existing human-gated path (`MONEY_GATED_PITCHES`, `selectPitch`). No UI
   affordance may create manufactured urgency.
2. **Stickiness = value, not lock-in (`STICKINESS.md §3`).** Memory **export / "forget everything"** is a
   first-class, visible control. **No engagement-maxxing** — nagging, over-messaging, or dark-pattern upsell is a
   *failed eval*, not a feature. Do not weaken the HITL boundary to reduce friction.
3. **Trust is the retention substrate (`MOAT.md §5`, `STICKINESS.md §1`).** Honest "AI-generated" framing,
   calm copy, reliability, and never fabricating (prices, stock, claims) outrank any conversion flourish.
4. **Stack.** The widget + storefront are **vanilla HTML/CSS/JS** (embeddable → CSP-safe, dependency-light).
   No framework. Reuse existing design tokens / the `palup-design-system`; extend tokens, don't invent colors.
5. **Memory is consent-gated + must degrade gracefully.** Memory recall requires shopper recognition + consent
   (ADR-0015/0017; the health/special-category consent gates). Memory-aware UI appears **only** when recognized
   & consented; otherwise it silently becomes the first-visit state. Never render a broken "welcome back."
6. **Ownership.** `packages/widget` is owned by other active sessions (the chat panel and the storefront). This
   is a **design spec**; implementation coordinates with those sessions and is a separately gated step. It builds
   on the already-merged mint→attach work (#394/#395/#402) and must keep those + the flag-off/byte-identical
   goldens green.

## 4. Design principles

Professional & light-toned · high readability (type scale, ~65-char line length, adequate contrast — WCAG 2.2 AA)
· simple interactions (low-effort starts, one clear action) · mobile-first ergonomics · trust-forward · memory-aware
· calm (never interrupting or pressuring).

## 5. Information architecture & layout

**Desktop.** Header (brand + cart) → a **calm hero entry** ("Not sure where to start? Shop with our expert —
it knows this catalog and builds your routine." + a primary "Ask the expert" and a secondary "Browse all") →
the **product grid** (stays primary; browse-and-buy always works) → a **labeled launcher pill** ("💬 Ask the
expert") docked bottom-right (never an auto-opening pop-up).

**Mobile.** Header → full-width hero → 1-column grid → a persistent, thumb-reachable "Ask the expert" entry;
opening the assistant is a **full-height sheet** (see §8).

The hero *invites* the conversation (feeding memory + the flywheel) without hijacking browsing. Approved as a
wireframe on 2026-08-20.

## 6. Component design

### 6.1 Assistant panel — three states
- **① First visit (cold).** Greeting with the honest label "**AI · replies are AI-generated**"; a value prompt
  ("tell me your skin & goals — I'll build a routine") + the promise "**I'll confirm the price before you buy**";
  low-effort **starter chips** (e.g. "Sensitive skin", "Anti-aging", "Shave routine").
- **② Returning (memory-aware).** "Welcome back 👋 last time we were building a routine for *sensitive skin* —
  pick up there or start fresh?" + a **"What I remember"** card (a short, human-readable summary of remembered
  preferences / considered items) with a **"Manage · Forget everything"** control. Rendered only when the shopper
  is recognized & consented (§3 constraint 5); else falls back to ①.
- **③ Recommending (converting).** A product recommendation card: name, image, **"Price confirmed · $X"** (real,
  hydrated price — never fabricated; "let me confirm the price" when unknown), and one calm **"Add to cart"** →
  the existing attributed checkout path. No urgency, no dark-pattern upsell.

### 6.2 Hero entry (storefront)
A light hero card (desktop) / stacked block (mobile) with the invite copy + primary/secondary CTAs. Opens the
same panel as the launcher. Slimmable to a one-line bar if products should sit higher (a build-time option).

### 6.3 Launcher
A **labeled pill** ("💬 Ask the expert"), not a bare dot — inviting, calm, non-interrupting. Persistent.

### 6.4 Storefront chrome
Keep the current light theme; apply the shared type scale, spacing, and contrast for readability + a
professional feel. No new IA.

## 7. Memory & trust surfacing
- **Memory made visible** = the moat made tangible (continuity a cold competitor can't reproduce). Surfaced via
  the state-② "welcome back" line + the "What I remember" card.
- **Consent + degradation:** only when recognized & consented; otherwise state ①. No empty/partial memory card.
- **No lock-in, in the UI:** "Manage · Forget everything" is a first-class control (`STICKINESS.md §3.1`).
- **Honesty cues:** the AI label, "confirm price before you buy", grounded recommendations only.

## 8. Mobile behavior
Full-height sheet on open; input pinned above the keyboard; "✕" returns to the store; closed = the launcher pill,
one tap away. Browsing/cart/checkout remain fully usable with the sheet closed.

## 9. Error / edge / graceful-degradation states
| Case | Behavior |
|---|---|
| Assistant unavailable | Never blocks the store; calm "briefly unavailable — you can still browse & check out"; grid/cart/checkout keep working. |
| Cold / memory off / not consented | Silently falls back to the first-visit greeting; no broken "welcome back", no empty memory card. |
| Price not yet confirmed | Assistant says so honestly; never invents or shows a stale number. |
| Offers / discounts / urgency | Shown only if merchant-authorized (§3); no manufactured urgency, no dark-pattern upsell. |
| Attribution tag | Invisible to the shopper; attaches silently at checkout; dark until the merchant enables it. |
| Empty / unavailable catalog | Honest empty state + browse link (current behavior); the assistant won't recommend what it can't ground. |

## 10. Data flow (UI over existing seams — no new backend capability)
- **Chat:** the panel POSTs `/chat` (existing) with its `sessionId`; a bucketed turn feeds the holdout arm + memory.
- **Memory:** recall/consent via the existing widget-memory seam (consent-gated); the "What I remember" card reads
  the recalled summary only when present.
- **Price:** the recommendation card uses the existing ProductFacts price-hydration ("confirmed" vs "needs confirming").
- **Attribution:** panel mints `/checkout/join-token`, loader exposes `window.PALUP.joinToken`, storefront attaches
  it at click time (already merged, #394/#395/#402). Unchanged by this redesign.

## 11. Success criteria (outcome, not activity — avoid the metric trap, `STICKINESS.md §4`)
- Assistant **engagement rate** (share of sessions that open + send ≥1 message) rises — a leading input to memory
  + flywheel data — **without** a rise in opt-out/complaint rate (the manipulation smoke alarm).
- **Attributed** conversion / revenue-per-session (via the incrementality holdout) is non-inferior or better —
  measured, not last-touch.
- Readability/a11y bar met (WCAG 2.2 AA on both surfaces, verified in E2E, matching the existing storefront tests).
- No regression to the flag-off/byte-identical goldens or the §3 money-boundary tests.

## 12. Delivery stages
- **Stage 1 (widget):** panel three states + memory/trust surfacing + labeled launcher + mobile sheet. Own spec→plan.
- **Stage 2 (storefront page):** hero entry + readability/token polish + persistent mobile entry. Own spec→plan.
Each ships behind the existing patterns, test-first, security-reviewed where it touches the attribution/memory
paths, coordinated with the owning sessions, human-merged if it crosses a governance surface.

## 13. Testing
- E2E (Playwright, `e2e/tests/storefront.spec.ts` + a new widget-panel spec): the three states (incl. memory-aware
  only-when-consented + graceful fallback), mobile sheet open/close + input-above-keyboard, and every §9 edge case.
- a11y: WCAG 2.2 AA (AxeBuilder) on both surfaces.
- Guardrails intact: the flag-off/byte-identical goldens, the `select-pitch-money-boundary` tests, and the
  attribution click-time-refresh test all stay green.

## 14. Open questions / deferred
- Exact "What I remember" content + affordance (chips vs list vs link) — refine in the Stage-1 plan.
- Whether the hero is a full card or a slim bar (build-time toggle; default: full card).
- Memory recall on the sample demo store depends on the memory-consent path being exercised there; the demo may
  show state ① until a recognized+consented shopper exists (acceptable for the showcase).
