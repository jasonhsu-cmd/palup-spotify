# UX Review — PalUp Skincare Jason storefront + AI assistant

**Target:** https://palup-widget-staging-270594351425.us-central1.run.app/
**Bar:** a consumer product used by hundreds of millions — professional, obvious, no rough edges.
**Date:** 2026-08-21 · **Method:** live capture via Playwright MCP (real, not guessed) → 8 parallel specialist reviewers (UX, UI, 3-persona, finish-gate, WCAG 2.2 accessibility, evidence-collector, performance, frontend-fixes) → a reality-check pass (verify/kill/downgrade). **No code was changed — review only.**

Screenshots: `./review-screenshots/` · per-reviewer findings: `./ux-review-findings/` · this is the synthesis.

## Scorecard (objective)
| | Result |
|---|---|
| Lighthouse Performance (mobile) | **82** |
| Lighthouse Accessibility | **100** (automated — catches ~⅓ of issues; the real gaps below are behavioral, which it can't see) |
| Lighthouse Best-Practices / SEO | 96 / 100 |
| **CLS** | **0.345 — POOR** (target <0.1; this is ~3.5× the "poor" threshold) |
| LCP / FCP / TBT | 2.2s / 1.2s / 0ms |
| Color contrast | **All pairs pass AA** (measured from source hex — not a problem area) |
| Console | 1 error (`/favicon.ico` 404) |

**Verdict: HOLD.** The plumbing is good (contrast passes, reduced-motion wired, native `<details>` disclosure, contrast-safe merchant theming, aspect-ratio on grid images). But the assistant — the whole reason this product exists — refuses to quote prices the page shows right next to it, the page visibly jumps on load, and the primary CTA appears twice in two different colors. Those read as "broken," not "premium."

---

## Top 5 to fix first (in order)

### 1. The assistant won't tell you a price the storefront shows one line away — BLOCKER
Every recommended card reads **"current price needs confirming"** with no number, while the storefront lists **`$50.0`** for that exact SKU in the same session (`review-screenshots/panel-390-card.png` vs `desktop-1440-light.png`). All three personas hit this wall; it's the single highest-leverage fix. The mechanism is correct-by-design (fail-honest price staleness, `brain.ts:141` / `hydrate-facts.ts:24`), but the **symptom is an operational gap**: the Tier-2 price facts for this tenant are stale, so the hedge fires on essentially every card. **This is not a frontend bug** — it needs the price-facts producer running / `PRODUCT_FACTS_HYDRATION` populated for this tenant. *(Honest note: this ties to the catalog work done earlier today — the vector corpus was refreshed, but the Tier-2 price facts were not, so retrieval finds the product yet can't confirm its price.)*
**What good looks like:** the assistant is never *less* informative than the page it floats on; a shown price matches (or explicitly explains) the storefront's.

### 2. The page visibly jumps on load — CLS 0.345 (POOR) — BLOCKER
Lighthouse attributes **100% of the shift to one node: `body > footer.site-footer`.** The product grid (`#grid`, `home.html:32`) starts empty with no reserved height and is filled async by `app.js:177-222` after the catalog fetch — the DOM grows ~3000px in one reflow and shoves the footer down. (Grid *images* are not the cause — `aspect-ratio:1/1` already reserves them.) **Fix:** server-render (or inline-JSON) the first page of products, or paint skeleton cards sized to the real grid so `#grid` height is stable across the swap. Bonus: the same fix removes the LCP discovery delay (#8).
**What good looks like:** CLS <0.1; nothing below the grid moves after first paint.

### 3. The same "Ask the expert" action appears in two different brand colors — BLOCKER
The hero CTA is **terracotta** (`app.css:18` `--accent:#a6482f`); the floating launcher + panel are **evergreen** (`loader-core.ts:91` / `widget-theme.ts:61` `#0c4a3c`) — same 💬 icon, same four words, same `palup:open` action, both on screen at once (`mobile-390-viewport.png`). This is **unreconciled drift, not intent**: the widget was retheme'd to evergreen *today* while the storefront hero stayed terracotta. **Fix:** pick one. Either recolor the hero CTA to evergreen (`app.css:18` → `#0c4a3c`), or if terracotta stays the storefront accent, style only `[data-testid="hero-ask"]` evergreen so the "ask the expert" identity is one color everywhere. *(This one traces to the evergreen retheme shipped earlier today — my debt to reconcile.)*
**What good looks like:** one color, one identity for that action, on every surface.

### 4. Footer policy is truncated mid-word, and prices read `$35.0` — MAJOR (pair, same file)
Footer: "…it's basical" and "…look 22 agai" — a raw `.slice(0, 600)` byte-cut with no word boundary or ellipsis (`shopify-grounding.ts:66,70,156`), on the one page a buyer checks returns terms. Prices: `formatPrice` (`shopify-grounding.ts:107-110`) concatenates Shopify's raw amount string with no `toFixed(2)` → `$35.0`. Both scream "unfinished" on a page selling things; both fix in one file. **Fix:** `Intl.NumberFormat('en-US',{style:'currency',currency:p.currencyCode||'USD'})` for money; truncate policy on a word boundary + "…" (and raise the 600-char cap for policy bodies, and split on `\n\n` so it's not one run-on block).
**What good looks like:** every price is `$XX.XX`; no customer copy ever ends mid-word.

### 5. The assistant's first real turn stacks three asks at once — BLOCKER
On the first recommendation, the panel shows: a reply ending in a price question, a **price-less** product card, and a **memory-consent** card — three decisions before the shopper has decided anything about the product (`panel-390-card.png`). **Fix:** defer the memory-consent card to a natural pause (after the 2nd turn, or once a preference is actually captured) instead of firing it on the same turn as the first recommendation.
**What good looks like:** the first recommendation turn is one clear answer + at most one follow-up — never a stacked consent ask on an unresolved price.

---

## Full issue list by severity

Screenshots are under `review-screenshots/`. "src-only" = confirmed in source but not visible in a static screenshot. Each Major carries a *What good looks like* line.

### BLOCKER
- **B1 — Assistant hedges a price the storefront shows** (`panel-390-card.png`; `brain.ts:141`, `hydrate-facts.ts:24`). See Top-5 #1. Operational (stale Tier-2 facts), not frontend.
- **B2 — First assistant turn overloads: price-question + price-less card + consent** (`panel-390-card.png`; sequencing in `index.html` `addProductCards`→`showConsentPrompt:557`). See Top-5 #5.
- **B3 — CLS 0.345, footer shift from unreserved async grid** (Lighthouse `layout-shifts` names `body>footer.site-footer`; `home.html:32`, `app.js:177-222`). See Top-5 #2.
- **B4 — Two "Ask the expert" CTAs in two brand colors** (`mobile-390-viewport.png`; `app.css:18` vs `loader-core.ts:91`). See Top-5 #3.

### MAJOR
- **M1 — Prices render `$35.0`** (`desktop-1440-light.png`; `shopify-grounding.ts:107-110`). Fix: `toFixed(2)`/`Intl.NumberFormat`. *Good: every price shows two decimals, everywhere.*
- **M2 — Footer policy truncated mid-word** (`desktop-1440-light.png`; `shopify-grounding.ts:66,70,156`). Fix: word-boundary truncation + "…", raise the 600-char cap for policies. *Good: no customer copy ends mid-word.*
- **M3 — Blank product tiles + no `onerror` fallback** (`desktop-1440-light.png` bottom rows; `app.js:131-143`). The same SKUs render *with* photos at 768px but blank at 390/1440 → intermittent load failure, and the `<img>` has no `onerror`, so any failure = a silent empty box (the "No image" fallback only fires when the URL is falsy). Fix: add `img.onerror` → swap in the "No image" placeholder. *Good: every tile shows a photo or an unmistakable placeholder — never an ambiguous blank.*
- **M4 — Panel cold state is ~45% empty** (`panel-390-open.png`; `index.html:98` `#messages{flex:1}` with no `justify-content`). Reads as "still loading." Fix: size the panel to content on cold-open (auto-height up to max), or center the greeting+chips. *Good: the first-open panel looks composed, not half-empty.*
- **M5 — Floating launcher occludes product photos on mobile** (`mobile-390-viewport.png`, `mobile-390-light.png`; `loader-core.ts:37-40` fixed pos). Fix: increase the launcher's safe-area offset / ensure grid bottom padding clears it on 2-col mobile. *Good: the launcher never covers shoppable content at rest.*
- **M6 — LCP 2.2s: LCP image is `loading="lazy"` and not discoverable until the catalog fetch resolves** (Lighthouse `lcp-discovery-insight`; `app.js:137`). Fix: drop `lazy` on the first card, add `fetchpriority="high"`; SSR first page removes the 1038ms discovery delay. *Good: LCP <2.5s, resource-load-delay near zero.*
- **M7 — Grid images shipped at native resolution (~406 KiB wasted)** (Lighthouse `image-delivery-insight`; `app.js:131-143`, no `?width=`/`srcset`). Fix: request Shopify CDN images at display size (`?width=350` or a `srcset`). *Good: thumbnails ≤2× their CSS box.*
- **M8 — Closing the panel drops keyboard focus to `<body>`** (src-only; `loader-core.ts:208-211` `close()` never calls `launcher.focus()`; the cross-shadow-root/iframe boundary means the panel can't refocus the real launcher). Fix: `launcher.focus()` in the loader's `close()`. *Good: minimize/Escape returns focus to the launcher with its focus ring.*
- **M9 — Every cart quantity/remove click rebuilds the whole list, losing focus** (src-only; `app.js:356-411` `mount.textContent=""`). Fix: restore focus to the equivalent control after re-render (or patch rows). *Good: after "−", focus lands back on that item's "−".*
- **M10 — Sign-in is likely a dead button inside the real embed** (src-confirmed by spec; `loader-core.ts:147` `sandbox="allow-scripts allow-same-origin allow-forms"` has **no `allow-popups`/`allow-top-navigation`**, so both `window.open` and the top-redirect fallback in `index.html:796-808` are blocked). **Needs a live click-test in the real embed to confirm; would be a functional Blocker for account access.** Fix: add `allow-popups allow-popups-to-escape-sandbox` (and/or `allow-top-navigation-by-user-activation`). *Good: "Sign in to view your orders" actually opens sign-in in the embedded widget.*
- **M11 — Memory-consent card wording is vague for a cautious/older user** (`panel-390-card.png`; `index.html:557-568`). "Got it" reads like dismissing a notification, not consenting. Fix: explicit binary — "Remember my preferences for next time? [Yes, remember] [No thanks]". *Good: the choice and its consequence are statable by the user right after reading.*
- **M12 — "▸ What I remember" disclosure is a tiny 12.5px triangle, easily never found** (`panel-390-card.png`; `index.html:174-176`). It gates the only privacy controls (toggles + "Forget everything"). Fix: label it ("Show what's remembered ▾"), ≥14px. *Good: a privacy disclosure carries a visible verb, not just a glyph.*

### MINOR
- `{brand}` / "Auria" flash in the tab title before JS swaps the real brand (src-only; `home.html:6,14,24`, `app.js:152`). Fix: SSR the real brand into the initial HTML.
- Favicon 404 (`EVIDENCE.md` console; no `<link rel=icon>` in `storefront/*.html`). One-line fix.
- `app.js` is render-blocking (~110ms; `home.html:47`). Fix: add `defer`.
- Product names are `<span>`s, not headings — no heading-jump for screen readers across the 28-card grid (`app.js:161-174`). Fix: render titles as `<h3>`.
- Nested live regions: `role="status"` cards appended into the `role="log"` message list may double-announce (src-only; `index.html:253` + `:555,587,801,1033,1040`). Fix: drop the redundant `role="status"`.
- Mobile full-screen panel doesn't `inert`/hide the storefront behind it — keyboard can Tab into hidden content (src-only; `loader-core.ts:46-55`). Fix: `inert` the host doc while the panel is open on small viewports.
- The "current price needs confirming" hedge is styled identically to a real price (`index.html:204`) — can't tell priced from unpriced at a glance. Fix: a muted/italic `.rec-p--unconfirmed`.
- Panel card thumbnail top-aligns against a taller text block, leaving unbalanced whitespace (`panel-390-card.png`; `index.html:196`). Fix: `align-items:center`.
- Footer paragraphs have no line-length cap (full ~1072px measure; `app.css:148`). Fix: `.site-footer .inner p{max-width:70ch}`.
- Decision-bearing panel text sits at 11.5–12.5px (consent body, chips, toggles; `index.html:159,168,180,182`) — a real barrier past ~50. Fix: 14px floor for anything the user must read to act.

### POLISH
- Skip-link uses the default browser focus ring — the one control the design system missed (`keyboard-focus-skiplink.png`; add `.skip:focus-visible{outline:2px solid var(--accent)}`).
- Verbose AI replies and jokey footer copy vs a prestige-beauty catalog — a content/register mismatch (merchant-authored; flag to the content owner, not code).
- Opener chips are all discovery prompts ("Find my match / Bestsellers / New here?") — no shortcut for a shopper who already knows what they want.
- Card "View in cart" (new tab) vs "Add to checkout" (in-panel) behave differently with no signal (`index.html:970-991`).
- Sign-in `window.open` uses fixed 480×760 desktop dims from a 390px panel (`index.html:796`) — likely ignored on mobile, unverified.
- Tap targets: sign-in ~20px, cart 42px. **These PASS WCAG 2.2 AA** (SC 2.5.8 = 24px min); 44px is AAA. Worth moving to 44px as polish, not a compliance gap.

---

## Reality-check: what was cut or corrected (so you don't chase ghosts)
- **KILLED — "duplicate-word / capitalized title"** ("The Art Of Shaving Shaving Cream"): this is the **merchant's own catalog data**, rendered verbatim (`app.js:170`, `textContent`). Not an app defect — flag to whoever owns the demo tenant's Shopify product names.
- **NOT AN ISSUE — color contrast:** every pair measured (terracotta/white 5.86:1, evergreen/white ~10:1, all muted text ≥4.9:1) passes AA. Lighthouse's 100 is right here; don't spend effort on contrast.
- **NOT A BUG — no dark mode:** both surfaces are pinned `data-theme="light"` by an owner directive (the widget never darkens to match a dark-OS shopper). Intentional and consistent.
- **NOT A BUG — the price hedge as a *policy*:** refusing to quote a stale price is the right call; the problem is that facts are stale for this tenant (operational), not the mechanism.
- **Downgraded** tap-target findings from "violation" to Polish (they pass AA), per the WCAG 2.2 2.5.8 threshold.
- **3 leads are real but not screenshot-shaped** (FOUC, CLS, favicon) — verified via source / the Lighthouse JSON / the console log instead of a PNG.

## Suggested sequencing
1. **Ops:** refresh the Tier-2 price facts for this tenant (kills B1 — the biggest trust hit). 2. **One-file wins:** currency format + policy truncation (`shopify-grounding.ts`), favicon, `defer`, `img.onerror`, skip-link focus. 3. **CLS:** reserve grid height / SSR first page (also fixes LCP). 4. **Product decision:** reconcile the CTA color. 5. **Panel polish:** defer the consent card, cold-state height, focus-return on close. 6. **Verify:** a real NVDA/VoiceOver pass + a live sign-in click-test in the embed (M8–M10 are source-derived).
