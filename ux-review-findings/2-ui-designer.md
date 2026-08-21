# UI Designer — Visual Quality Review

Scope: spacing/rhythm, type scale & hierarchy, color usage & contrast, alignment, button/form styling, and storefront↔panel consistency. Grounded in `review-screenshots/` + real source (`packages/widget/public/storefront/*`, `packages/widget/public/index.html`, `packages/widget/src/loader-core.ts`, `packages/widget-backend/src/widget-theme.ts`, `packages/widget-backend/src/shopify-grounding.ts`, `packages/widget-brain/src/brain.ts`). Ranked by severity.

---

## 1. Same "Ask the expert" action renders in two different brand colors at once

**Severity:** Blocker

**Where:**
- Storefront hero CTA: `packages/widget/public/storefront/app.css:18` `--accent:#a6482f` (terracotta), applied via `.btn` at `app.css:120` (`background:var(--accent)`); button markup at `packages/widget/public/storefront/home.html:28`.
- Floating launcher pill: `packages/widget/src/loader-core.ts:87-93` — hardcoded `background:#0c4a3c` (evergreen), label `"💬 Ask the expert"` (same icon+copy as the hero button).
- Panel header, which the launcher opens: `packages/widget-backend/src/widget-theme.ts:52,61-63` (`DEFAULT_THEME`/`palup-skincare-jason` both `#0c4a3c`) drives `packages/widget/public/index.html:18` `--brand:#0c4a3c`, painted at `.wh` (`index.html:83`).

**Evidence:** `mobile-390-viewport.png` — the terracotta hero "💬 Ask the expert" button and the evergreen floating "💬 Ask the expert" launcher are both on screen simultaneously, identical icon and copy, different fills.

**Why it hurts the user:** it is the identical labeled action rendered as two different brand colors on one screen. A shopper has no way to know these are the same button — it reads as two competing products, not one polished assistant. This is exactly the kind of thing a "hundreds of millions of users" bar does not ship.

**Fix:** pick one color for this action everywhere it appears. The theme file's own comment (`widget-theme.ts:56-58`) says the launcher/panel were *deliberately* retheme'd to evergreen `#0c4a3c` on 2026-08-21 "so the widget reads as PalUp-native rather than the old storefront terracotta" — the storefront hero CTA was not updated to match. Two options:
  - **(a) Converge on evergreen:** change `app.css:18-21` to `--accent:#0c4a3c; --accent-hover:#0a3d32; --accent-ink:#ffffff; --accent-soft:#e6f0ec;` (keep `--accent-soft` derived the same way as today, ~90% white tint of the new hex). This repaints the hero CTA, `.cart-link:hover`, and all outline buttons to match the launcher/panel.
  - **(b) Keep terracotta as the storefront's own accent, but give the "Ask the expert" affordance specifically its own consistent treatment** (e.g., style only `[data-testid="hero-ask"]` with `background:#0c4a3c;color:#fff`), leaving `Browse all`/`Load more` terracotta.
  Either way, the same icon+label must resolve to the same hex on every surface a shopper can trigger it from.

**What good looks like:** the "💬 Ask the expert" affordance is one color, one identity, wherever it appears — hero, launcher, panel header.

---

## 2. Price format `$35.0` — missing cents digit throughout the storefront

**Severity:** Major

**Where:** `packages/widget-backend/src/shopify-grounding.ts:107-110`
```
function formatPrice(p?: { amount?: string; currencyCode?: string }): string {
  if (!p?.amount) return "";
  return p.currencyCode && p.currencyCode !== "USD" ? `${p.amount} ${p.currencyCode}` : `$${p.amount}`;
}
```
Shopify's Storefront API returns `amount` as a decimal string with whatever precision the merchant's data has (e.g. `"35.0"`); this is concatenated raw with no numeric normalization.

**Evidence:** `desktop-1440-light.png` — every grid price (`$35.0`, `$50.0`, `$99.0`, `$26.0`, etc.).

**Why it hurts the user:** a one-decimal price on a commerce site reads as a broken currency formatter, not a stylistic choice — it plants doubt about the checkout math before the shopper even adds to cart.

**Fix:** normalize to 2 decimals before interpolating:
```
return p.currencyCode && p.currencyCode !== "USD"
  ? `${Number(p.amount).toFixed(2)} ${p.currencyCode}`
  : `$${Number(p.amount).toFixed(2)}`;
```
This fixes the value once at the source — it flows through to the grid, PDP, cart, and any place the assistant card reuses `p.price`.

**What good looks like:** every displayed price has exactly two decimal digits, everywhere, always.

---

## 3. The price-unconfirmed hedge is styled identically to a real price

**Severity:** Major

**Where:** `packages/widget/public/index.html:204` — `.rec-p{ font-size:13px; color:var(--fg); flex:0 0 auto }`. This single class renders both a real price (`index.html:949-951`, `p.textContent = c.price`) and the hedge text `"current price needs confirming"` (`packages/widget-brain/src/brain.ts:141`, `PRICE_UNCONFIRMED_TEXT`), with no distinguishing style.

**Evidence:** `panel-390-card.png` — "current price needs confirming" renders in the same full-strength ink color and weight (`var(--fg)`, 13px) that a real price would.

**Why it hurts the user:** a shopper scanning the card can't visually tell "this has a real price" from "this is a caveat, no price shown" — the hedge is dressed with the same visual confidence as a fact, which undercuts the very safety mechanism it exists to signal.

**Fix:** give the unconfirmed state its own class, e.g.
```
.rec-p--unconfirmed{ color:var(--muted); font-style:italic; }
```
and apply it in the render branch at `index.html:949` when `c.price === PRICE_UNCONFIRMED_TEXT` (or better, have the server send an explicit `priceConfirmed:false` flag through to the card payload so the client branches on data, not string-matching copy).

**What good looks like:** a shopper can tell "priced" apart from "price pending" at a glance, without reading the sentence.

---

## 4. Footer policy text truncated mid-word, no ellipsis

**Severity:** Major

**Where:** `packages/widget-backend/src/shopify-grounding.ts:66` (`MAX_DESC = 600`) and `:156-157` / `:175-176` — `bound(data.shop?.refundPolicy?.body, MAX_DESC)` slices the **raw HTML** policy body at a fixed 600-character count. Only afterward does `toPlainText()` (`packages/widget-backend/src/routes/storefront-catalog.ts:46-56`) strip tags for display — so the cut already landed mid-word/mid-tag before stripping, and nothing marks that it was cut.

**Evidence:** `desktop-1440-light.png` footer — "…FREE shipping on orders over $50 — treat yourself, it's basical" and "…roughly the time it takes a sheet mask to not stay on your face. \*It didn't make me look 22 agai" both stop mid-word.

**Why it hurts the user:** shipping/returns policy is a trust- and legal-relevant surface; text that just stops mid-word reads as a broken page, not an intentional excerpt.

**Fix:** truncate on a word boundary and mark the cut, e.g. after `toPlainText()`, if the source exceeded the cap: find the last space before the limit and append `"…"`. Concretely, move the bound to after `toPlainText` (or re-derive it there) so the 600-char budget is spent on visible characters, not markup, and always end on a word boundary with a trailing ellipsis when truncated.

**What good looks like:** truncated copy always ends cleanly at a word boundary with a visible "…", never mid-word.

---

## 5. Panel cold state: a large empty gap between the opener chips and the input

**Severity:** Major

**Where:** `packages/widget/public/index.html:98` — `#messages{ flex:1; overflow-y:auto; padding:16px 14px; display:flex; flex-direction:column; gap:10px; }`, inside `#widget{ ...height:min(620px, calc(100vh - 40px)); display:flex; flex-direction:column; }` (`index.html:67-69`) or the mobile full-screen variant `:root[data-palup-panel] #widget{ ...height:100% }` (`index.html:82`). No `justify-content` is set on `#messages`, so with only the greeting bubble + 3 opener chips rendered, the flex column's default `flex-start` leaves the entire remaining height of the panel as blank white space above the input.

**Evidence:** `panel-390-open.png` — roughly half the 390×~868 viewport is empty between the "Find my match / Bestsellers / New here?" chips and the text input.

**Why it hurts the user:** on first open — the shopper's very first impression of the assistant — the panel looks broken or unfinished rather than intentional.

**Fix:** either
  - vertically center the cold state only: add a `.cold` class to `#messages` while `message count ≤ 1` and opener chips are present (`justify-content:center`), removed once the shopper sends a real message or the conversation grows, or
  - fill the space with something intentional (a short "popular right now" row, or brand art), or
  - cap the panel's rendered height to its content in the cold state instead of stretching to the full `min(620px, 100vh-40px)`.

**What good looks like:** the first-open state is visually composed — centered or filled — never a large accidental void.

---

## 6. Blank/empty product-image tiles read as broken, not "no photo"

**Severity:** Major

**Where:** `packages/widget/public/storefront/app.js:131-142` (`thumb()`) renders `<span class="ph">No image</span>` when `imageUrl` is falsy; styled at `packages/widget/public/storefront/app.css:96` — `.card .thumb .ph{ color:var(--muted); font-size:12px; letter-spacing:.08em; text-transform:uppercase; }` sitting on a `var(--surface-2)` (`#f2f0ec`) tile background (`app.css:94`).

**Evidence:** `desktop-1440-light.png`, bottom grid row (CHRISTOPHE ROBIN color fixator, Stila Heaven's Hue Highlighter, etc.) — the tiles render as flat, indistinguishable light-gray boxes; the 12px muted-on-near-matching-background label is not legible at grid scale in the capture.

**Why it hurts the user:** these tiles are visually indistinguishable from a stalled/broken image load. At a glance across the grid, several products in the catalog look unfinished, undermining confidence in the whole catalog, not just those SKUs.

**Fix:** raise the empty state's visual weight so it reads as deliberate: add a simple centered glyph (a 20-24px image-placeholder icon) above the label, darken the label to `var(--ink-2)` (`#4b4843`, ~1.6× darker than `--muted`) at `font-weight:600`, and give the tile a 1px `var(--line-strong)` inset border so it visually separates from the surrounding card background rather than blending into it.

**What good looks like:** an image-less product is unmistakably "no photo yet," never confusable with a loading/broken state.

---

## 7. Footer body copy has no line-length cap — full-width paragraphs

**Severity:** Minor

**Where:** `packages/widget/public/storefront/app.css:148` — `.site-footer .inner{ max-width:var(--maxw); ...display:grid; gap:10px; }` constrains the footer *container* to 1120px but not the paragraphs inside it. Contrast with the hero, which explicitly caps prose width: `.hero{ padding:24px 0 12px; max-width:66ch; }` (`app.css:83`).

**Evidence:** `desktop-1440-light.png` — the footer's shipping/returns paragraphs run the full ~1072px content width (well past comfortable reading measure), while the hero paragraph on the same page is capped.

**Fix:** add `.site-footer .inner p{ max-width:70ch; }`.

**What good looks like:** body copy anywhere on the page wraps at roughly 60-75 characters per line, matching the hero's own precedent.

---

## 8. Panel product-card thumbnail pins to the top of a taller text block

**Severity:** Minor

**Where:** `packages/widget/public/index.html:196` — `.rec{ display:flex; align-items:flex-start; gap:11px; padding:9px 11px; ... }` with a fixed `.rec-img{ width:52px; height:52px; }` (`index.html:199`) beside a `.rec-body` that can wrap title + price/hedge + availability + cart-link across up to 4 rows (`index.html:202-208`).

**Evidence:** `panel-390-card.png` — the 52px thumbnail sits flush with the first line of the title; once the title wraps twice and the hedge/cart-link lines stack below it, the text column runs visibly taller than the image, leaving unbalanced whitespace beside it.

**Fix:** change `.rec` to `align-items:center` (or `align-items:stretch` with the image `align-self:center`) so the thumbnail centers against the full height of the text stack instead of anchoring to its top edge.

**What good looks like:** the thumbnail reads as balanced against its text block regardless of how many lines the title/hedge/link wrap to.

---

## 9. Cart-link tap target is 2px short of the 44px floor

**Severity:** Polish

**Where:** `packages/widget/public/storefront/app.css:75` — `.cart-link{ padding:9px 16px; ...font-size:14px; ... }`; measured 63×42px (per `EVIDENCE.md`).

**Evidence:** measurement recorded in `EVIDENCE.md`; element visible (unmeasured, by eye) in `desktop-1440-light.png` / `mobile-390-viewport.png` header.

**Fix:** raise vertical padding to `11px 16px` (or add `min-height:44px; display:inline-flex; align-items:center;`, already flex — just add the `min-height`).

**What good looks like:** every tappable control measures at least 44×44px.

---

## 10. Brand-name flash of unstyled content (FOUC)

**Severity:** Polish

**Where:** `packages/widget/public/storefront/home.html:6,14,24` — `<title>{brand} — Clean, effective skincare</title>` and `<span data-brand>Auria</span>` ship as literal placeholder text; `app.js` (line ~150, `setBrand`) swaps them in after the catalog fetch resolves.

**Evidence:** not visible in the static post-load screenshots (by nature of a FOUC, it only shows on the very first paint) — flagging from source only, per the "state if not visible in a screenshot" instruction. Unverifiable against these captures.

**Fix:** the backend already resolves the real brand name server-side (`widget-theme.ts` / `resolveTheme`); thread it into the storefront's initial HTML render (SSR the title/brand span) instead of shipping a client-side placeholder-then-swap.

**What good looks like:** the correct brand name is present on first paint; no placeholder flash.

---

### Summary (top 3)
1. **Blocker** — the "Ask the expert" action is terracotta on the storefront hero but evergreen on the launcher/panel — same action, two brand identities on screen at once (`app.css:18` vs `loader-core.ts:87-93` / `widget-theme.ts:61-63`).
2. **Major** — prices render as `$35.0` (one decimal) because `formatPrice` never normalizes the Shopify amount string (`shopify-grounding.ts:107-110`).
3. **Major** — the "current price needs confirming" hedge renders in the exact same style as a real price (`index.html:204`), so shoppers can't visually tell priced cards from unpriced ones.
