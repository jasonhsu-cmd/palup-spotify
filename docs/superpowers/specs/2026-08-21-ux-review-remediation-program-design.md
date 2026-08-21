# UX-Review Remediation Program — design

**Status:** design (brainstorming output; not yet an implementation plan)
**Source:** `UX-REVIEW.md` (live review of the staging storefront + assistant, 2026-08-21) + `ux-review-findings/`
**Goal:** raise the PalUp Skincare Jason storefront + embedded assistant to a consumer-product bar — professional, obvious, no rough edges — by remediating the reviewed findings as a sequenced program of scoped, independently-shippable changes, without crossing §3 (money/model/autonomy) or the memory-consent legal gate.

## Owner decisions locked (this session)
1. **Scope:** full program — all five workstreams A–E.
2. **Sequencing:** *polish-first* — ship A, then B, then D as normal test-first PRs; the governance/decision items (C2, E price-facts, E sandbox) run on a separate track and never block the safe fixes.
3. **CTA color:** recolor only the storefront **hero** "Ask the expert" button to evergreen `#0c4a3c` so it matches the launcher; the rest of the storefront's terracotta accent is unchanged. (Not §3 — a branding call.)
4. **Price-facts staleness:** *make prices real* — populate fresh Tier-2 price facts and let the assistant quote them. This is the **§3 money-honesty path**, promoted by a human, not auto-applied.
5. **Sign-in sandbox:** test-first — confirm the break live in the real embed before any sandbox change.
6. **Consent copy/sequencing (C2):** **legal-gated** — specified here for a human/legal ruling, not built as a free redesign.

## The invariant (do not cross)
No workstream changes money/model/autonomy semantics without the §3 human path, and none alters the memory-consent design (what is asked, when, in what words) without the legal gate. Presentation, formatting, performance, focus management, and image handling are free; the *price the assistant asserts* and the *consent it collects* are governed.

---

## Workstream A — Storefront polish (one PR, non-§3, auto-merge on green)
**Files:** `packages/widget-backend/src/shopify-grounding.ts`; `packages/widget/public/storefront/{app.js,app.css,home.html,cart.html,product.html}`.
**Changes:**
- **A1 · Currency format.** `formatPrice` (`shopify-grounding.ts:107-110`) → `Intl.NumberFormat('en-US',{style:'currency',currency:p.currencyCode||'USD'}).format(Number(p.amount))`. One source, flows to grid/PDP/cart. Fixes `$35.0`.
- **A2 · Footer policy truncation.** `shopify-grounding.ts:66,70,156-157` — truncate on a word boundary with a trailing `…`; raise the policy-body cap from 600 to ~2000; split source on `\n\n` into multiple `<p>` (stop the run-on block). Fixes mid-word cutoffs.
- **A3 · Blank-tile fallback.** `app.js thumb()` (`:131-143`) — add `img.onerror` that swaps the `<img>` for the existing `.ph` "No image" placeholder, so a failed load never renders an empty box.
- **A4 · Right-sized images.** `app.js thumb()` — request Shopify CDN thumbs at display size (`?width=350`, or a `173w/346w` `srcset`). Saves ~406 KiB.
- **A5 · Favicon.** Add `packages/widget/public/storefront/favicon.svg` + `<link rel="icon">` in the three storefront HTML files; serve it. Clears the `/favicon.ico` 404.
- **A6 · Non-blocking script.** `home.html:47` `<script defer …>`.
- **A7 · CSS polish.** `.skip:focus-visible{outline:2px solid var(--accent);outline-offset:3px}`; `.site-footer .inner p{max-width:70ch}` (`app.css`).
- **A8 · CTA color (owner decision 3).** Recolor `[data-testid="hero-ask"]` to evergreen `#0c4a3c` with white ink; leave `--accent` terracotta for Browse all / cart / links.
- **A9 · Panel price-hedge styling** (low-risk presentation in `index.html`) — a muted/italic `.rec-p--unconfirmed` so a hedge reads differently from a real price; `.rec{align-items:center}` for thumbnail balance. *(Presentation only — the hedge text/mechanism is unchanged.)*
**Testing:** unit tests for `formatPrice` and the truncation helper (no mid-word cut, ellipsis on overflow); extend `e2e/tests/storefront.spec.ts` — grid renders `$XX.XX`, a forced-404 image renders the placeholder, footer text ends cleanly, hero CTA computed background = evergreen.
**Acceptance:** every price `$XX.XX`; no customer copy ends mid-word; no empty image tiles; no favicon 404; the two "Ask the expert" entries are one color.

## Workstream B — CLS + LCP (one PR, non-§3)
**Root cause (confirmed):** `#grid` (`home.html:32`) paints empty; `app.js:177-222` fills it after the catalog fetch, shifting the footer (Lighthouse `layout-shifts` → `body>footer.site-footer` = 100% of CLS 0.345). Grid images are already `aspect-ratio:1/1` — not the cause.
**Approach — server-render the first page (recommended).** `home.html` is read into a string at boot (`server.ts:290`) and served by a route, so SSR reuses the **existing marker-injection pattern** (the panel already injects theme FOUC-free at `<!--PALUP_THEME-->`). Add markers to `home.html`; the serving route injects (a) the first page of catalog JSON so `#grid` has real cards at first paint, (b) the resolved brand into `<title>`/`[data-brand]`, (c) the resolved shipping/returns policy into the footer. This single change retires CLS **and** the 1038 ms LCP discovery delay **and** the `{brand}`/`Auria` FOUC together.
- *Fallback if SSR proves too invasive in the plan:* skeleton `.card`s painted synchronously into `#grid` (stable height) + a reserved-height footer. Frontend-only, fixes CLS but not LCP-discovery/FOUC.
- Also drop `loading="lazy"` on the first card image + `fetchpriority="high"` regardless of approach.
**Testing:** a Playwright layout-shift probe (CLS ≈ 0), LCP element present in the initial HTML response, no `{brand}` in the served `<title>`.
**Acceptance:** CLS < 0.1; nothing below the grid moves after first paint; LCP < 2.5 s.

## Workstream C — Panel UX
Split by governance.
- **C1 (buildable now, `index.html`, non-§3):** cold-state panel sizes to content / centers the greeting+chips (`:98`); the "What I remember" disclosure gets a labeled affordance ("Show what's remembered ▾") at ≥14px (`:174-176`); a 14px floor on decision-bearing panel text (`:159,168,180,182`).
- **C2 (LEGAL-GATED — spec only, do not build):** the memory-consent **wording** (proposed: an explicit binary "Remember my preferences for next time? [Yes, remember] [No thanks]") and **deferring** the consent card off the first recommendation turn (fire it after the 2nd turn or once a preference is actually captured). *When and how consent is asked is part of the legally-reviewed consent design.* This spec records the proposal; a named human/legal owner rules before any change. **Blocks:** B2/B5 first-turn-overload is only fully resolved once C2 is approved.
**Testing (C1):** e2e assertions on cold-state layout + disclosure label/size. **C2:** legal sign-off recorded before implementation.

## Workstream D — Accessibility behavioral (one PR + a manual SR pass, non-§3)
**Files:** `packages/widget/src/loader-core.ts`, `packages/widget/public/index.html`, `packages/widget/public/storefront/app.js`.
**Changes:** panel `close()` → `launcher.focus()` (`loader-core.ts:208-211`); cart rebuild restores focus to the equivalent control (`app.js:356-411`); product titles → `<h3>` (`app.js:161-174`); drop the redundant `role="status"` on cards appended into the `role="log"` list (`index.html:253`+); `inert` the host document while the mobile full-screen panel is open (`loader-core.ts:46-55`).
**Testing:** Playwright focus assertions where feasible **plus a real NVDA/VoiceOver pass** (these are behavioral; automated tools already score 100 and miss them). Contrast is already AA — not in scope.
**Acceptance:** minimize/Escape returns focus to the launcher; cart edits keep focus on the item; the mobile panel traps focus; heading-jump works over the grid.

## Workstream E — Decisions & ops
- **E1 · Price-facts = make prices real (owner decision 4 — §3 money path).** Two levers, both existing: run the catalog indexer with `PRODUCT_FACTS_POLL=true` (`catalog-index.ts:1409`) for `palup-skincare-jason` so the poll writes fresh Tier-2 price/availability facts; and promote `PRODUCT_FACTS_HYDRATION=true` (+ decide `PRICE_REQUIRES_LIVE_CHANNEL`, `server.ts:754,767`) on the serving service so the assistant quotes them. **Governance:** enabling hydration is the §3 money promotion — it goes through eval → shadow → canary → **human approve**, not a deploy toggle. This program *prepares* it (runs the producer, verifies fresh facts, drafts the promotion) and *surfaces* it for the owner to promote. Until promoted, A9's styling makes the hedge at least legible.
- **E2 · Sign-in sandbox (owner decision 5).** Live-click-test "Sign in to view your orders" inside the *real* embed (not `/embed/panel` direct). If confirmed broken by the `sandbox` on `loader-core.ts:147`, add `allow-popups allow-popups-to-escape-sandbox` (and/or `allow-top-navigation-by-user-activation`) — **security-reviewer required** (loosening an iframe sandbox on an auth flow).

---

## Program-level acceptance (lift the HOLD)
1. Every price `$XX.XX`; no mid-word customer copy; no favicon 404; no empty image tiles.
2. CLS < 0.1 and LCP < 2.5 s on mobile; `{brand}` never visible in `<title>`.
3. One color for the "Ask the expert" action on every surface.
4. Keyboard focus is never stranded on panel close or cart edit; mobile panel is a real focus trap.
5. The assistant quotes a confirmable price (post §3 promotion) **or** its hedge is legible + actionable in the interim.
6. C2 (consent wording/sequencing) carries a recorded legal ruling before it ships.
7. E2 (sandbox) verified live and, if changed, security-reviewed.

## Out of scope / explicitly not doing
- **Contrast** — measured AA-clean; do not touch.
- **Dark mode** — intentionally light-pinned (owner directive).
- **The "duplicate-word / capitalized" product titles** — merchant catalog data, not an app defect; flag to the demo-tenant data owner.
- **Jokey footer/AI copy register** — merchant-authored content; flag to the content owner, not code.
- Any change to the price-honesty mechanism or the consent design beyond what decisions 4 and 6 authorize.

## Sub-project → PR map (for writing-plans)
| PR | Workstream | §3/legal | Merge |
|---|---|---|---|
| 1 | A (storefront polish + A8 CTA + A9 panel CSS) | none | auto on green |
| 2 | B (SSR first page → CLS/LCP/FOUC) | none | auto on green |
| 3 | C1 (panel cold-state/disclosure/text) | none | auto on green |
| 4 | D (focus mgmt + a11y) + manual SR pass | none | auto on green |
| — | C2 (consent wording/sequencing) | **legal** | human/legal ruling first |
| — | E1 (price-facts producer + hydration promotion) | **§3 money** | prepare; human promote |
| — | E2 (sandbox) | security | test-first; security-reviewer |
