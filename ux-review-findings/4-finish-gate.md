# UI Finish Gate — PalUp Skincare Jason storefront + assistant panel

**Screens reviewed:** `/` (home grid) at 1440/768/390px, embed panel cold + recommending states, keyboard focus on load.
**Bar:** a consumer product used by hundreds of millions — no rough edges, one coherent product.

## Decision: HOLD

Two of the ten leads in EVIDENCE.md resolve to the same root cause and are load-bearing enough to block on
alone (the footer text engine). Three more are independently confirmed, visible, and cheap to fix. None of
this requires a redesign — every item below is a specific code change, not a taste note.

---

## Findings, ranked by severity

### 1. [BLOCKER] The footer is the entire CLS 0.345 (POOR) — not a vague "images without dimensions" guess

**Where:** `packages/widget/public/storefront/app.js:154` (`setPolicy`, called from the `fetchPage(null).then(...)` handler) writing into `packages/widget/public/storefront/home.html:39-40` (`<p data-policy-shipping>` / `<p data-policy-returns>`).

**Evidence:** `review-screenshots/lighthouse-mobile.json`, audit `layout-shifts`, is not a guess — it names the single culprit node directly:
```
"selector": "body > footer.site-footer",
"boundingRect": { "height": 638 },
"score": 0.3450789793438639   // == the entire reported CLS
```
100% of the page's CLS is this one element. Confirmed at `file:line`, not inferred.

**Why it hurts the user:** the footer starts at its HTML-authored height (two short one-line placeholders: "Free US shipping over $75." / "30-day returns on unopened items.", `home.html:39-40`), then — after the async catalog fetch resolves — `setPolicy()` overwrites that `textContent` with up to 600 characters of real merchant policy text (see #2). The footer balloons from ~2 lines to ~10+ lines with no reserved space, shoving everything below it (nothing, it's the last element, but it shoves the scrollbar/viewport ratio and anything the user was reading right as they scroll toward it) — exactly the "POOR" CLS Lighthouse flags, at a value 3.4x over the "poor" threshold.

**Fix:** reserve footer height before the async replacement — either render the real policy text server-side into `home.html` (you already have it via the grounding fetch used for the API endpoint; use it for the static shell too) so there's no client-side swap, or give `.site-footer .inner p` a `min-height` sized to the truncated-text worst case and animate the swap. Do not ship a footer that changes height post-load with no reservation.

**What good looks like:** CLS < 0.1, and the Lighthouse `layout-shifts` audit reports zero large shifts.

---

### 2. [BLOCKER] Footer policy text is truncated mid-word — a hard byte-slice with no word boundary or ellipsis

**Where:** `packages/widget-backend/src/shopify-grounding.ts:66` (`const MAX_DESC = 600;`), `:70` (`const bound = (s, max) => (s ?? "").slice(0, max);`), applied to the merchant's real Shopify policy body at `:156-157` (`returns: bound(data.shop?.refundPolicy?.body, MAX_DESC)`, `shipping: bound(data.shop?.shippingPolicy?.body, MAX_DESC)`). Rendered via `textContent` (not `innerHTML`, so any paragraph breaks in the source policy collapse into one run-on block) at `app.js:157-158`.

**Evidence:** `desktop-1440-light.png` footer, literal text: "...FREE shipping on orders over $50 – treat yourself, it's basical" and "...Refunds land back on your original payment method in 5-7 business days — roughly the time it takes a sheet mask to not stay on your face. \*It didn't make me look 22 agai". Both cut off inside a word, not at a sentence or even a syllable boundary in the first case.

**Why it hurts the user:** this is not a stylistic truncation (no CSS ellipsis, no "…"), it's a raw JS `.slice(0, 600)` that has no idea where a word ends. On a *policy* page — the exact place a shopper checks before trusting a "30-day returns" claim — the text just stops mid-sentence with no indication more was intended. That reads as broken, not concise.

**Fix:** either raise `MAX_DESC` for policy bodies specifically (a shipping/returns policy is reasonably 1-3k characters; 600 was clearly picked as a generic "merchant text" cap and never revisited for this call site), or truncate on a word boundary and append an explicit ellipsis + "Full policy" link. Also preserve the source's paragraph breaks (split `.body` on `\n\n` into multiple `<p>`s) instead of collapsing to one `textContent` blob — the screenshot's wall-of-text effect is partly this, independent of the truncation.

**What good looks like:** policy text never ends mid-word; if bounded, it ends on a word boundary with a visible indicator and a way to read the rest.

---

### 3. [MAJOR] The storefront and the assistant disagree about the same product's price, in the same session

**Where:** storefront price string built by `formatPrice()`, `packages/widget-backend/src/shopify-grounding.ts:107-110` — `` `$${p.amount}` `` with **zero normalization** of Shopify's raw `MoneyV2.amount` string. Assistant hedge text: `PRICE_UNCONFIRMED_TEXT = "current price needs confirming"`, `packages/widget-brain/src/brain.ts:141`, driven by the D2 staleness ceiling in `packages/widget-brain/src/hydrate-facts.ts:24-28`.

**Evidence:** `desktop-1440-light.png` lists "The Art of Shaving After Shave Balm - Unscented 3.3 OZ" at "$50.0". `panel-390-card.png` shows the assistant recommending that same product with "current price needs confirming" and no number at all, plus prose telling the shopper it will "verify the exact price... before you make a purchase."

**Why it hurts the user:** a shopper can see the price on the page, then ask the assistant about the same product and be told the price can't be confirmed. That is not a graceful hedge, it's a visible contradiction between the two surfaces of the same product — the single strongest signal that this is two systems bolted together rather than one product. The mechanism (Tier-2 `ProductFactsPort` staleness ceiling, `hydrate-facts.ts:24-45`) is a deliberate, documented, governed design (money/NN#1 fail-honest, gated behind a human-promoted flag per ADR-0020) — the *policy* is defensible; the *symptom* (contradicting the page 5 seconds later, for the majority of cards) means the Tier-2 fact producer isn't keeping pace with the champion tenant, which is an operational gap, not a UI one, but it ships as a UI credibility hit either way.

**Also confirmed while here — the price format itself is a separate, smaller bug:** `formatPrice()` interpolates Shopify's `MoneyV2.amount` string with no `toFixed(2)`/`Intl.NumberFormat` currency formatting, which is why USD prices render as "$35.0" / "$50.0" (one decimal) instead of "$35.00" / "$50.00". This is the kind of unformatted-raw-API-value output nobody would ship deliberately on a page that's selling things.

**Fix:** (a) normalize money output through a real currency formatter — `new Intl.NumberFormat('en-US', {style:'currency', currency: p.currencyCode ?? 'USD'}).format(Number(p.amount))` — never raw string concatenation. (b) Either backfill/refresh the Tier-2 price facts for this tenant so hedging is the exception, or suppress showing an un-hedged storefront price for a product the assistant can't confirm (or vice versa) so the two surfaces never visibly disagree in the same session.

**What good looks like:** every USD price on the storefront renders as `$XX.XX`; if the assistant can't confirm a price, the storefront doesn't confidently show a different one for that same SKU without qualification.

---

### 4. [MAJOR] Two "💬 Ask the expert" buttons, two different brand colors, same label, same destination — an unfinished retheme, not a design choice

**Where:** hero CTA uses `--accent` terracotta `#a6482f` (`packages/widget/public/storefront/app.css:18`, applied via `.btn` at `:120`). Floating launcher hardcodes evergreen `#0c4a3c` (`packages/widget/src/loader-core.ts:91-93`), sourced from `DEFAULT_THEME` / the per-tenant override at `packages/widget-backend/src/widget-theme.ts:52,61-62`. Confirmed same action: the hero button's click handler dispatches `window.dispatchEvent(new CustomEvent("palup:open"))` (`app.js:473`), the exact event the loader listens for to open the panel (`app.js:468-470` comment).

**Evidence:** `mobile-390-viewport.png` shows both buttons live in the same viewport: terracotta "💬 Ask the expert" pill in the hero, evergreen "💬 Ask the expert" pill floating bottom-right. Identical copy, identical icon, different color, same click target underneath.

**Why this is a "default that slipped through," not a "deliberate and good" vendor-brand pattern:** a chat widget deliberately keeping its own brand chrome regardless of host-site color (Intercom, Drift) is a legitimate, arguable pattern — but that pattern signals "this is a separate thing" precisely by using *different copy/iconography* for the widget vs. the host CTA. Here the two buttons say the exact same four words for the exact same action, which reads as "we forgot to pick one color," not "these are two different systems." The codebase's own comments confirm this is drift, not intent: `app.css:4-5` describes the storefront's terracotta as "**cohesive with the brand-themed widget**... Deliberately NOT the console evergreen system," while `widget-theme.ts:54-55` documents an owner directive dated **2026-08-21 (today)** to retheme the widget to evergreen "**so the widget reads as PalUp-native rather than the old storefront terracotta**" — i.e., the storefront CSS's own justification for terracotta was invalidated by a widget retheme that shipped the same day, and nobody went back to reconcile the hero CTA.

**Fix:** pick one. Either (a) revert the hero CTA to evergreen (or drop the hero CTA color to a neutral outline, letting the launcher be the one branded "PalUp" surface), or (b) if the PalUp-native evergreen widget is the real product decision going forward, differentiate the hero CTA's copy from the launcher's copy (e.g., hero: "Build my routine" → assistant; launcher stays "Ask the expert") so two colors reads as two intentionally distinct entry points, not one broken one.

**What good looks like:** any two buttons that do the identical thing use the identical color, or are worded differently enough that a different color reads as intentional.

---

### 5. [MAJOR, medium confidence] Broken-image fallback exists in code but is never reached — blank tiles instead of "No image"

**Where:** `thumb()`, `packages/widget/public/storefront/app.js:131-143`. The "No image" placeholder (`:140`, `el("span", "ph", "No image")`) only renders when `imageUrl` is falsy; the `<img>` branch (`:134-138`) sets `img.src` and never attaches `onerror`, so a URL that 404s, times out, or is CORS-blocked fails silently into an empty box instead of falling through to the app's own placeholder.

**Evidence:** `desktop-1440-light.png` bottom row: "CHRISTOPHE ROBIN color fixator wheat germ mask," "Stila Heaven's Hue Highlighter," "CHRISTOPHE ROBIN Regenerating plant oil...," and "The Art of Shaving Pre-Shave Oil - Sandalwood 2 OZ" all render as flat grey `.thumb` boxes with **no** "NO IMAGE" label text visible — inconsistent with the code path that would show that label. The same two SKUs ("color fixator wheat germ mask," "Heaven's Hue Highlighter") appear blank again in `mobile-390-light.png`, but render *with* a visible product photo in `tablet-768-light.png` for the identical SKUs.

**Confidence caveat (stated, not glossed over):** that cross-viewport inconsistency for the same SKUs means this is more likely an intermittent load failure (network/CDN timing, or `loading="lazy"` interacting with how the full-page screenshot tool scrolls/captures) than a permanently broken image URL — I can't distinguish those from static screenshots alone, and I did not capture a network trace. What's not in doubt: whichever way it fails, the code has zero handling for it, so a shopper who hits it mid-session sees a wordless empty box, not a graceful fallback.

**Fix:** add `img.onerror = function(){ box.replaceChild(el("span","ph","No image"), img); }` (or swap in a real placeholder graphic) so any image load failure — flaky or permanent — degrades to the intentional empty state instead of an unlabeled blank tile.

**What good looks like:** every tile shows either a photo or the explicit "No image" state; nothing renders empty.

---

### 6. [MINOR] Raw `{brand}` / wrong-brand "Auria" FOUC on slow load

**Where:** `packages/widget/public/storefront/home.html:6` — `<title>{brand} — Clean, effective skincare</title>`, replaced only after JS runs (`app.js:151-152`, `if (document.title.indexOf("{brand}") >= 0) ...`). Separately, `home.html:14` and `:24` hardcode the placeholder brand name **"Auria"** as the pre-hydration DOM content of the header/hero `[data-brand]` spans, replaced by the real merchant name ("PalUp Skincare Jason") in `setBrand()` (`app.js:147-153`).

**Evidence:** confirmed from source, not from a screenshot — both captured screenshots already show the resolved brand ("PalUp Skincare Jason"), so the raw `{brand}` title and the "Auria" flash are real per the code but **unverified visually** here; call this the honest gap. On a slow connection or with JS disabled/delayed, a real user would see the browser tab literally read `{brand} — Clean, effective skincare` and the page briefly read "Auria" — a foreign brand name — before the real one appears.

**Fix:** template the title server-side with the real brand at request time (you already resolve `brandName` server-side for the API route; reuse it for the HTML shell), and remove the hardcoded "Auria" placeholder in favor of a generic non-brand fallback ("this store") that can never look like a shipped wrong-brand default.

**What good looks like:** the tab title and header never show templating syntax or another brand's name, at any load speed.

---

### 7. [MINOR] Favicon 404 on every load

**Where:** no `<link rel="icon">` anywhere in `packages/widget/public/storefront/{home,cart,product}.html`, and no favicon asset in `packages/widget/public/` at all.

**Evidence:** EVIDENCE.md's captured console log: `GET /favicon.ico 404` (the only console error). Confirmed independently by source: there is nothing for the browser to find, so it falls back to the default `/favicon.ico` probe and 404s every time.

**Fix:** add a real favicon (even a generic placeholder) and link it explicitly; takes one `<link rel="icon" href="...">` line.

**What good looks like:** zero console errors on load; a tab icon that isn't the browser's blank-page glyph.

---

### 8. [MINOR] Cold-state panel has a large dead gap with nothing intentional in it

**Where:** rendered panel markup/CSS in `packages/widget/public/index.html` (inline styles; the greeting bubble + opener chips block sits at the top, the input + "Sign in to view your orders" sit pinned at the bottom).

**Evidence:** `panel-390-open.png` — greeting + three opener chips ("Find my match" / "Bestsellers" / "New here?") occupy the top ~230px, then roughly 400px of pure white before "Sign in to view your orders" and the input bar at the bottom.

**Why it hurts the user:** on a *cold* conversation (nothing has happened yet) this is the very first thing a shopper sees when they open the assistant — the panel gives itself the same height budget as an active conversation with several message turns, but has nothing to fill it, so it reads as a template that hasn't been given content yet, not a deliberate empty state.

**Fix:** either size the panel to its actual content on cold-open (grow as messages arrive, capped at a max height) or fill the space intentionally — e.g. product-led prompts, a short "how this works" line, or move the opener chips to sit just above the input instead of anchored under the greeting.

**What good looks like:** the cold-open panel height matches its content; there is no unexplained blank region.

---

### 9. [POLISH, low confidence] Footer tone reads as a different brand than the catalog

**Where:** footer copy delivered via `data.policy.shipping`/`data.policy.returns` (see #2) — merchant-authored Shopify policy body text, not app code.

**Evidence:** `desktop-1440-light.png` footer: "Your glow is on its way... warehouse elves are moisturizing and resting," "we won't make you prove it with a dramatic monologue," "\*It didn't make me look 22 agai[n]." The catalog above it is The Art of Shaving, Christophe Robin, Stila — established, clinical-leaning prestige beauty brands.

**Why this is flagged as low confidence, not asserted as a bug:** this is merchant-authored content (a real Shopify shop's `refundPolicy.body`/`shippingPolicy.body`), not something the app generated or styled — I cannot tell from here whether this voice is deliberate demo-tenant flavor text or a genuine merchant choice the app should respect as-is. What IS in scope regardless of intent: pairing very informal, joke-dense long-form copy against a premium-skincare product grid, with no editorial pass, reads as mismatched register — worth a content review, not a code fix.

**Fix (if the team agrees it's wrong):** this is a merchant content edit, not a code change — flag to whoever owns the demo tenant's Shopify policy text, not to the builder agents.

---

### 10. [POLISH] Skip-link focus ring is the unstyled browser default

**Where:** no `:focus-visible` rule targets `.skip` in `packages/widget/public/storefront/app.css` (confirmed absent — every other interactive element in the file has an explicit `:focus-visible` rule using `var(--accent)`, e.g. `.brand:focus-visible` at `:73`, `.cart-link:focus-visible` at `:77`, `.card:focus-visible` at `:93`, `.btn-outline` link states, etc.; `.skip` has none).

**Evidence:** `keyboard-focus-skiplink.png` — the very first Tab press on the page shows a plain rectangular blue outline that doesn't match the terracotta focus rings used everywhere else on the same page.

**Why it hurts the user:** functionally fine (it's visible, which is the accessibility requirement, and Lighthouse Accessibility scored 100) — but it's the literal first pixel a keyboard user sees, and it's the one interactive element on the page that was never given the same focus treatment as the rest. Small, but exactly the kind of "everything got a pass except this one thing" signal this review is for.

**Fix:** add `.skip:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; border-radius: 6px; }` to match the rest of the file's convention.

**What good looks like:** every focusable element on the page uses the same focus-ring treatment; none default to the browser's outline.

---

## Keep — deliberate and good, don't touch

- **The memory-consent card and "What I remember" disclosure** (`panel-390-card.png`): dark evergreen header, consistent avatar/type system, a clear two-button consent choice ("Don't remember me" / "Got it") with plain-language copy about retention window. This is a considered, well-integrated piece of UI — better than most "we use cookies" treatments — and shares real visual language (color, radius, type) with the rest of the panel.
- **The panel's fail-honest price hedge as a *policy*** (not its current symptom, #3): refusing to quote a stale price and explicitly offering to confirm before purchase is the right call for a commerce assistant, and it's implemented with a real staleness ceiling (`hydrate-facts.ts` D2, ADR-0020) rather than a blanket "never show prices" cop-out. The problem is operational (facts aren't fresh enough for this tenant), not a UI decision to undo.
- **Reserved `aspect-ratio: 1/1` on product thumbs** (`app.css:94`): this is exactly the right defensive pattern against image-driven CLS, and it's why the CLS problem turned out to be the footer, not the grid — don't let #1's fix regress this.
- **The light-only theme decision**: per EVIDENCE.md, this is a stated owner directive (the widget never darkens to match a dark-OS shopper, matching the light storefront). A single coherent light experience across both surfaces is consistent, and there's no user-facing evidence in these captures that it's broken (the panel and storefront share the same light palette). Not treating "no dark mode" as a bug.

## PASS criteria (what must be true to lift the HOLD)

1. Lighthouse `layout-shifts` reports no shift attributed to `.site-footer`; CLS < 0.1 on mobile.
2. No policy text (or any customer-facing copy) ends mid-word; verify by reading the full rendered footer at 1440/768/390px.
3. Storefront prices render as `$XX.XX` (two decimals) via a real currency formatter — verify across the full grid, not just page 1.
4. The two "Ask the expert" buttons either match in color or are worded distinctly enough that the color difference reads as intentional — verify at the 390px viewport where both are visible together.
5. A forced broken image URL renders the app's own "No image" placeholder, not a blank box — verify with a deliberately-404 image URL in a test fixture, not just by eyeballing production data.
6. Console is clean of the favicon 404.
7. `.skip:focus-visible` matches the rest of the page's focus-ring treatment.
