# UX Review — shared evidence (captured live via Playwright MCP, 2026-08-21)

**App under review:** https://palup-widget-staging-270594351425.us-central1.run.app/
**What it is:** A Shopify storefront sample page (`/`) for the merchant "PalUp Skincare Jason" with an embedded PalUp AI shopping-assistant widget (floating launcher → panel). Bar to judge against: a consumer product used by hundreds of millions — professional, obvious, no rough edges.

## Screenshots (in `review-screenshots/`) — READ THESE, they are real captures
- `desktop-1440-light.png` — storefront, full page, 1440px
- `tablet-768-light.png` — storefront, full page, 768px
- `mobile-390-light.png` — storefront, full page, 390px
- `mobile-390-viewport.png` — storefront above-the-fold, 390px (shows the terracotta hero CTA + evergreen floating launcher)
- `panel-390-open.png` — assistant panel, COLD state (server greeting + opener chips "Find my match / Bestsellers / New here?" + large empty gap before input)
- `panel-390-card.png` — assistant panel, RECOMMENDING state (product card WITH image, "current price needs confirming", memory-consent card, collapsed "▸ What I remember" disclosure)
- `keyboard-focus-skiplink.png` — first Tab focuses the "Skip to content" link
- `lighthouse-mobile.json` — full Lighthouse report

## Objective measurements
- **Lighthouse (mobile):** Performance **82**, Accessibility **100**, Best-Practices **96**, SEO **100**
- **Core Web Vitals:** FCP 1.2s · LCP 2.2s · TBT 0ms · **CLS 0.345 (POOR — target <0.1)** · Speed Index 2.1s · TTI 2.2s
- **Console:** 1 error — `GET /favicon.ico 404`
- **Keyboard:** skip link present & first in tab order (good). Focus outline on skip link = browser default 1px auto. Tap targets: hero CTA 173×52, cart link 63×42 (height slightly under 44).
- **Theme:** storefront `<html data-theme="light">` and the embed panel are DELIBERATELY pinned light (owner directive — the widget never darkens on a dark-OS shopper to match the light storefront). So there is no product dark mode; judge whether that's acceptable, don't treat its absence as a bug without argument.

## Observed leads (VERIFY these against the screenshots/source — do not assume; expand or kill)
1. **Two "💬 Ask the expert" buttons in different brand colors** for the same action: the hero CTA is terracotta (`#a6482f`/accent, `storefront/app.css`), the floating launcher is evergreen (`#0c4a3c`, `packages/widget/src/loader-core.ts:91`). See `mobile-390-viewport.png`.
2. **Assistant won't show prices** — the recommending card says "current price needs confirming" and offers no price, while the storefront lists `$50.0` for that same product. Stale Tier-2 price facts → every card hedges. `panel-390-card.png`. This is the biggest credibility hit.
3. **Price format `$35.0`** (one decimal) throughout the storefront grid. `desktop-1440-light.png`.
4. **Footer policy text truncated mid-word** — "…it's basical" and "…look 22 agai" (cut off). `desktop-1440-light.png` / DOM snapshot. Shipping/returns policy is incomplete.
5. **Blank product image tiles** — several grid products render an empty grey tile (no image). `desktop-1440-light.png` bottom rows.
6. **Brand FOUC** — page `<title>` renders raw `{brand}` before JS replaces it with "PalUp Skincare Jason".
7. **Panel cold state has a large empty vertical gap** between the opener chips and the input. `panel-390-open.png`.
8. **CLS 0.345** — significant layout shift (likely grid images without reserved dimensions and/or async launcher injection).
9. **Favicon 404**.
10. **Verbose AI reply + verbose footer copy** — the footer is a long jokey wall of text; AI replies are long. Judge against the professional bar.

## Source map (findings MUST point at real files:lines)
- Storefront page: `packages/widget/public/storefront/home.html`, `cart.html`, `product.html`
- Storefront CSS/JS: `packages/widget/public/storefront/app.css`, `app.js`
- Assistant panel (served at `/embed/panel` and `/widget`): `packages/widget/public/index.html` (all markup + CSS + JS inline)
- Loader (floating launcher + iframe): `packages/widget/src/loader-core.ts`
- Merchant theme injection (brand color): `packages/widget-backend/src/widget-theme.ts`
- Card build (price hedge / imageUrl): `packages/widget-brain/src/brain.ts` (`buildProductCards`), price staleness in `hydrate-facts.ts`

## Output contract for every agent
Write your findings to `ux-review-findings/<your-role>.md`. For EVERY issue:
- **Title**, **Severity** (Blocker / Major / Minor / Polish)
- **Where** (screen + `file:line`)
- **Evidence** (which screenshot shows it; if not visible in a screenshot, say so — unverifiable findings will be cut)
- **Why it hurts the user** (concrete)
- **Fix** (specific: what to change and to what value — no "improve spacing")
- **What good looks like** (1 line)
No vague advice. Empty/loading/error states count. Rank your own list by severity.
