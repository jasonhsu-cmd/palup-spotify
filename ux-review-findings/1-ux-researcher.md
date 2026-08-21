# UX Researcher — first-time-buyer walkthrough findings

Lens: a first-time shopper with intent to buy, walking hero → grid → assistant open → ask a question → price card → memory consent → sign-in → empty/error states. Each finding says whether it is screenshot-verified or source-only-inferred.

---

## BLOCKER

### 1. The assistant cannot quote a price for the exact product the storefront prices right next to it
- **Severity:** Blocker
- **Where:** `panel-390-card.png` vs. storefront grid. Code: `packages/widget-brain/src/hydrate-facts.ts:78` (`isFactStale` → `priceConfirmed:false` on channel-unhealthy/stale facts), `packages/widget-brain/src/brain.ts:141` (`PRICE_UNCONFIRMED_TEXT = "current price needs confirming"`) and `:782-787` (`buildProductCards` forces the sentinel onto the card). Storefront price for the same item comes from a different, un-hydrated path: `packages/widget-backend/src/shopify-grounding.ts:107-110` (`formatPrice`), rendered at `packages/widget/public/storefront/app.js:171` (`price` cell) — shown as `$50.0` on the grid.
- **Evidence:** `panel-390-card.png` — the card for "The Art of Shaving After Shave Balm - Unscented 3.3 OZ" reads "current price needs confirming" with no number. `desktop-1440-light.png` — the same product's grid tile shows `$50.0`. Screenshot-verified for this one product; the code confirms the *mechanism* is systemic (any product whose Tier-2 fact is stale or whose freshness channel reads unhealthy gets this treatment), not confirmed to be literally every card in the catalog since only one recommending-state screenshot exists.
- **Why it hurts the user:** A shopper opens the assistant specifically because it promises expert help picking a product. The very first useful answer it gives refuses to state the price of the thing it just recommended, while the page the shopper is already looking at states the price plainly. That is not "being careful" to a first-time user — it reads as "the AI is broken" or "the AI is hiding something," and it undermines every other claim the assistant makes in the same reply. This is the single most damaging trust break in the whole flow because it happens in the assistant's first substantive turn.
- **Fix:** Either (a) make the storefront price path and the assistant's price path agree — if the storefront can show a live price for this SKU, the assistant should be able to confirm the same value instead of hedging, or (b) if the hydration channel is genuinely unhealthy in this environment, don't hedge silently — have the reply say *why* ("I can't verify today's price for this item right now — here's what's listed on the page: $50.00") rather than a bare, unexplained "needs confirming" with no number and no path forward besides "would you like me to check." A shopper cannot act on "would you like me to check" — that should either happen automatically or should not be asked as an open question with no visible next step.
- **What good looks like:** The assistant's stated price for a product always matches (or explains any discrepancy with) the price the shopper can already see on the same page, in the same visit.

### 2. The first meaningful assistant turn stacks three separate asks with no price at the center of them
- **Severity:** Blocker
- **Where:** `panel-390-card.png`. Sequencing in `packages/widget/public/index.html`: reply text → `addProductCards` (price-hedged card) → `showConsentPrompt` (`:551-575`) all render into the same `#messages` log with no pacing between them.
- **Evidence:** `panel-390-card.png` — in one scrollable turn the shopper sees: a paragraph ending in a price question, a product card that withholds the price, and immediately below it a "I remember your preferences to help you shop" consent card with two buttons, on a phone screen where all three don't fit without scrolling.
- **Why it hurts the user:** A first-time shopper's first real answer from the assistant is: no price, an unresolved question ("would you like me to check?"), and a request to consent to being remembered — three decisions before they've decided anything about the product itself. This is cognitive overload precisely at the moment the shopper most needs a simple, confident answer, and it reads as the assistant talking about itself (memory, confirmation) instead of doing the one thing it was opened for.
- **Fix:** Defer the memory-consent card to a natural pause (e.g., after the shopper's second turn, or only once a preference has actually been captured) rather than firing it on the same turn as the first product recommendation. Resolve the price question before or instead of asking it.
- **What good looks like:** The first product-recommendation turn contains one clear answer and, at most, one follow-up question — never a stacked consent ask on top of an unresolved price question.

---

## MAJOR

### 3. Two "Ask the expert" buttons in different colors, and on mobile the floating one covers the product grid it's supposed to help you shop
- **Severity:** Major
- **Where:** Hero button: `packages/widget/public/storefront/home.html:28` (`class="btn"`), colored terracotta via `packages/widget/public/storefront/app.css:18` (`--accent:#a6482f`) and `:120`. Floating launcher: `packages/widget/src/loader-core.ts:87-93` — fixed position (`:37-40`, `bottom:20px;right:20px`) with `background:#0c4a3c` (evergreen). Per `packages/widget-backend/src/widget-theme.ts:54-58`, this evergreen is a deliberate owner-directed brand choice for the widget ("so the widget reads as PalUp-native rather than the old storefront terracotta") — the mismatch with the storefront's own terracotta accent is intentional on PalUp's side, but that doesn't change what the shopper sees.
- **Evidence:** `mobile-390-viewport.png` — the terracotta hero button and the evergreen floating pill are both visible on first load, same icon (💬), same words ("Ask the expert"), different colors. The same screenshot also shows the floating pill's fixed position overlapping the second row of the product grid (partially covering a product thumbnail) with no scrolling at all.
- **Why it hurts the user:** Two identically-labeled buttons in different colors on the same screen reads as a bug, not a design choice, to someone who has never seen this store before — they don't know one is "the merchant's button" and one is "PalUp's button," they just see the same CTA rendered twice, inconsistently. Separately, the floating launcher sitting on top of live product content at first paint (no scroll needed) hides part of a product a shopper might be trying to evaluate, on the exact page whose job is to sell that product.
- **Fix:** At minimum, resolve the overlap: the launcher's fixed position (`loader-core.ts:39`) should respect a safe area so it never sits directly over grid content on narrow viewports (e.g., bottom offset that accounts for grid bleed, or a `scroll` listener that nudges it, or simply confirm the grid's own bottom padding/`main{padding:32px 24px 96px}` in `app.css:82` already reserves 96px — evidently not enough on a 2-column mobile grid where a full card row is taller than that). For the two-CTA mismatch, if the evergreen widget-brand is a firm decision, differentiate the hero CTA in wording (not just relying on color) so the two buttons don't read as duplicates — e.g., hero says "Ask the expert" and the launcher's accessible label already says "Ask the expert" too (`loader-core.ts:82`), making them functionally indistinguishable except by color.
- **What good looks like:** One clearly primary "talk to the assistant" affordance per viewport, or two affordances that are visually and verbally distinguishable as different things, and neither ever occludes live page content at rest.

### 4. Cumulative Layout Shift 0.345 (POOR) — traced to a single event: the footer jumping down as the catalog loads
- **Severity:** Major
- **Where:** `packages/widget/public/storefront/home.html:32-33` (`<div id="grid" ... aria-busy="true">` starts empty) and `packages/widget/public/storefront/app.js:177-222` (`renderHome`/`appendPage` — cards are appended only after `fetchPage` resolves, with no reserved height beforehand); footer at `home.html:36-43`.
- **Evidence:** Lighthouse's own `layout-shifts` audit (`review-screenshots/lighthouse-mobile.json`) attributes the *entire* 0.345 CLS score to one shift of `body > footer.site-footer` (`boundingRect` height 638, `score: 0.345`) — i.e., this is not a diffuse many-small-shifts problem, it is the footer being shoved downward once as the grid's content streams in above it with no placeholder height. This is a concrete, single-cause number from the objective measurement, not a guess.
- **Why it hurts the user:** On a real 3G/4G mobile connection this is the shift a shopper would feel as "the page jumped" right as they're trying to read or tap something near the bottom of the screen — CLS 0.345 is nearly 3.5x the "poor" threshold (0.25) and 3.5x the "good" threshold (0.1). It also erodes the professional, stable feel expected of a checkout-adjacent page.
- **Fix:** Reserve height for the catalog before the fetch resolves — either render skeleton/placeholder cards sized like real ones for the expected first-page count while `aria-busy="true"`, or give `#grid` a `min-height` computed from the expected row count, so the footer doesn't move once real cards arrive.
- **What good looks like:** CLS well under 0.1; the footer's position doesn't move after first paint regardless of how long the catalog fetch takes.

### 5. Prices render as `$35.0`, `$50.0`, `$99.0` — one decimal place, not currency-formatted
- **Severity:** Major
- **Where:** `packages/widget-backend/src/shopify-grounding.ts:107-110` — `formatPrice` does `` `$${p.amount}` `` directly on the Shopify Storefront API's raw decimal-string amount, with no rounding or `Intl.NumberFormat` currency formatting.
- **Evidence:** `desktop-1440-light.png` — every price in the grid reads with exactly one decimal (`$35.0`, `$50.0`, `$99.0`, `$26.0`, `$71.0`, etc.), confirmed across dozens of grid tiles.
- **Why it hurts the user:** A single decimal place on a price is the kind of thing that looks like a formatting bug on any consumer commerce site — real money is written to two decimals (`$35.00`). For a store literally trying to establish "clean, effective, professional" positioning (per its own hero copy), this reads as unfinished.
- **Fix:** Format with two decimal places, e.g. `` `$${Number(p.amount).toFixed(2)}` `` (or proper `Intl.NumberFormat('en-US',{style:'currency',currency:p.currencyCode||'USD'})` for correctness across currencies), applied at `shopify-grounding.ts:109`.
- **What good looks like:** Every price on the page renders as standard currency (`$35.00`), matching what a shopper would see at checkout.

### 6. Several grid tiles show a blank grey box instead of a product photo
- **Severity:** Major
- **Where:** `packages/widget/public/storefront/app.js:131-143` (`thumb()` — falls back to a `.ph` "No image" span when `p.imageUrl` is falsy) rendered by CSS `packages/widget/public/storefront/app.css:94-96` (`.card .thumb`, `.ph`).
- **Evidence:** `desktop-1440-light.png` — the bottom row (e.g. "CHRISTOPHE ROBIN color fixator wheat germ mask," "Stila Heaven's Hue Highlighter," "CHRISTOPHE ROBIN Regenerating plant oil...," "The Art of Shaving Pre-Shave Oil - Sandalwood 2 OZ") all render as plain grey/beige squares. The code does render a small "No image" label inside that box (`.ph` span), but at normal viewing size and resolution it reads as an empty, possibly-broken tile, not a deliberate "photo coming soon" state — the same visual as a product that failed to load.
- **Why it hurts the user:** Skincare is a visually-driven purchase category; a shopper deciding between two serums wants to see the bottle. Multiple blank tiles on the very first grid a new visitor sees reads as "this catalog isn't finished" or "something's broken," which undercuts trust before the shopper has even opened the assistant.
- **Fix:** Either backfill the missing product images at the data source, or make the fallback state visually intentional (icon + clearly legible "Photo coming soon" rather than a bare tinted box) so it can't be mistaken for a loading/broken image.
- **What good looks like:** Every catalog tile either shows a real product photo or an unmistakably deliberate placeholder, never an ambiguous blank box.

### 7. Footer shipping & returns policy text is truncated mid-word
- **Severity:** Major
- **Where:** Rendered via `packages/widget/public/storefront/app.js:154-160` (`setPolicy`, `textContent` — confirmed this is not a CSS/JS truncation bug; the string itself arrives cut off from the merchant's live Shopify policy data, fetched through `packages/widget-backend/src/shopify-grounding.ts` shell fetch). `packages/widget/public/storefront/home.html:38-40` is the container.
- **Evidence:** `desktop-1440-light.png` — footer text reads "...FREE shipping on orders over $50 — treat yourself, it's basical" and "...Refunds land back on your original payment method in 5-7 business days — roughly the time it takes a sheet mask to not stay on your face. *It didn't make me look 22 agai" — both cut off mid-word, with no closing punctuation.
- **Why it hurts the user:** A shipping/returns policy that's cut off mid-sentence, on the *only* page that states it, leaves a shopper without the actual policy they'd rely on when deciding whether to buy (especially the returns terms) — and the visible truncation itself looks like the site is broken, in the section meant to reassure a first-time buyer about risk.
- **Fix:** This is merchant-entered content (not a template or CSS clipping issue — `textContent` doesn't truncate), so the fix is at the data source: the merchant's Shopify policy text needs to be completed/corrected. This should not ship live in this state; flag for the merchant/content owner to fix before this counts as launch-ready.
- **What good looks like:** The shipping and returns policy reads as complete sentences with no mid-word cutoffs.

---

## MINOR

### 8. Cold-state panel has a large dead zone between the opener chips and the input
- **Severity:** Minor
- **Where:** `panel-390-open.png`. CSS: `packages/widget/public/index.html:98` (`#messages{flex:1; ... display:flex; flex-direction:column}` — top-aligned content, no centering/min-content sizing for the empty state).
- **Evidence:** `panel-390-open.png` — greeting + 3 opener chips occupy the top ~25% of the panel; the remaining ~55% down to the input is blank white space.
- **Why it hurts the user:** A near-empty chat window with a large unexplained gap can read as "still loading" or "broken" to a first-time user, especially since nothing in that space hints that more will appear there once they reply.
- **Fix:** Either vertically center the greeting+chips block in the empty state, or reduce the panel's minimum height when the log has only one turn, so the empty state doesn't look like an unfinished layout.
- **What good looks like:** The cold-state panel looks intentionally composed, not like content is missing.

### 9. Brand placeholder `{brand}` flashes in the page title before JS replaces it
- **Severity:** Minor
- **Where:** `packages/widget/public/storefront/home.html:6` (`<title>{brand} — Clean, effective skincare</title>`), replaced at runtime by `packages/widget/public/storefront/app.js:152` (`setBrand`).
- **Evidence:** Source-only — confirmed in code that the literal string `{brand}` is the initial `<title>` content and is replaced only after the first catalog fetch resolves; not independently re-verified via a fresh network-throttled load in this session, but the FOUC window is real given the fetch is async and off the critical render path.
- **Why it hurts the user:** A raw, unresolved template token in a browser tab (or a bookmarked/shared link) looks like a bug, however briefly it's visible — a small but real "not finished" signal.
- **Fix:** Set a neutral literal title server-side by default (e.g. "Skincare — Clean, effective skincare") that JS still overwrites with the real brand name, so the fallback is never a template token.
- **What good looks like:** The tab title never shows an unresolved placeholder, even for a moment.

### 10. Favicon 404
- **Severity:** Minor
- **Where:** Console error noted in `EVIDENCE.md` (`GET /favicon.ico 404`); not traced to a specific source file in this session.
- **Evidence:** Objective measurement in `EVIDENCE.md` ("Console: 1 error — `GET /favicon.ico 404`"); not independently re-captured this session.
- **Why it hurts the user:** Small, but a missing favicon is one of the most basic "does this look like a real, finished product" signals, and it's a one-line fix.
- **Fix:** Add a `favicon.ico` (or `<link rel="icon">` pointing at an existing asset) to the storefront's static files.
- **What good looks like:** No 404s for basic browser assets on a production-facing page.

### 11. Header "Cart" link's tap target is shorter than the hero CTA right above it
- **Severity:** Minor
- **Where:** `packages/widget/public/storefront/app.css:75` (`.cart-link{padding:9px 16px; ...}`).
- **Evidence:** Objective measurement in `EVIDENCE.md`: cart link measured 63×42px vs. hero CTA 173×52px. Not independently re-measured this session.
- **Why it hurts the user:** Nothing breaks, but the header's primary persistent action (Cart) is comfortably tappable while sitting just under the more generously-sized hero button — a small inconsistency in how "important" each element feels, and 42px sits just under the commonly-cited 44px comfortable minimum.
- **Fix:** Bump `.cart-link` vertical padding slightly (e.g. `11px 16px`) to clear 44px height, matching the hero button's generosity.
- **What good looks like:** Every persistent, always-visible tap target meets the same minimum size, not just the hero CTA.

---

## POLISH

### 12. Sign-in opens a fixed 480×760 desktop-sized popup from inside a 390px mobile panel
- **Severity:** Polish
- **Where:** `packages/widget/public/index.html:796-808` (`startShopperSignIn` — `window.open(url, "palup_signin", "width=480,height=760")`), with a well-built popup-blocked fallback (`:799-806`, inline "Click to sign in" link that redirects the top frame).
- **Evidence:** Source-only — not exercised in this session's screenshots (no sign-in click was captured). The popup-blocked fallback is a genuinely good, deliberate piece of design (comment at `:795` shows the author already reasoned about the gesture requirement), so this is a low-severity note, not a broken flow.
- **Why it hurts the user:** On a phone, `window.open` with explicit desktop dimensions is typically ignored by the mobile browser (it just opens a full tab/window), so this is likely fine in practice — but it's unverified, and a full context-switch away from a 390px-wide embedded panel to sign in is inherently more friction than an in-panel flow would be.
- **Fix:** If not already tested on real mobile Safari/Chrome, verify the popup path there specifically; consider whether an in-panel (iframe-safe) sign-in redirect would be lower-friction than a popup on small viewports.
- **What good looks like:** Sign-in feels native to whatever surface it's launched from, without an obvious "this was built desktop-first" seam.

### 13. Consent and health-consent card copy is long and paragraph-heavy for a first-touch UI element
- **Severity:** Polish
- **Where:** `packages/widget/public/index.html:559-561` (ordinary consent body, two full sentences) and `:591` (special/health consent body, three clauses in one sentence).
- **Evidence:** `panel-390-card.png` — the visible consent card ("I remember your preferences to help you shop... You're in control: manage or turn this off anytime.") is legible but is one of three dense text blocks stacked in the same turn (see Blocker #2 above).
- **Why it hurts the user:** Not wrong or dishonest — the copy is careful and well-reasoned (per the code comments, this went through real security/legal review) — but its length compounds the overload problem in Blocker #2, and it sits in visual tension with the terse, tap-friendly opener chips ("Find my match," "Bestsellers") a shopper saw seconds earlier.
- **Fix:** Once Blocker #2's sequencing fix is in place, consider shortening the first-touch consent body to one sentence, with the fuller explanation available on demand (the "What I remember" disclosure already exists for this purpose).
- **What good looks like:** Consent language stays legally sound but reads as one short, scannable sentence on first contact, with detail available on tap rather than upfront.

---

## Ranked summary (most to least severe)
1. Blocker — assistant won't quote a price the storefront shows for the same product (finding 1)
2. Blocker — first assistant turn stacks price-hedge + card + memory consent (finding 2)
3. Major — duplicate-colored "Ask the expert" CTAs + launcher overlaps grid on mobile (finding 3)
4. Major — CLS 0.345, entirely a footer-shift from an unreserved catalog grid (finding 4)
5. Major — unformatted `$X.0` prices throughout the grid (finding 5)
6. Major — blank product tiles with no photo (finding 6)
7. Major — footer policy text truncated mid-word (finding 7)
8. Minor — empty gap in cold-state panel (finding 8)
9. Minor — `{brand}` title FOUC (finding 9)
10. Minor — favicon 404 (finding 10)
11. Minor — cart link tap target under 44px (finding 11)
12. Polish — mobile popup sign-in, unverified (finding 12)
13. Polish — verbose consent copy (finding 13)
