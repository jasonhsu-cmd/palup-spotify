# Accessibility review — WCAG 2.2 AA

**Scope:** live storefront (`palup-widget-staging-…run.app/`) for merchant "PalUp Skincare Jason" + the embedded PalUp assistant widget.
**Method:** source review (`packages/widget/public/index.html`, `packages/widget/src/loader-core.ts`, `loader-entry.ts`, `packages/widget/public/storefront/app.css`, `app.js`, `home.html`, `cart.html`, `product.html`, `packages/widget-backend/src/widget-theme.ts`) + the captured screenshots + Lighthouse JSON in `ux-review-findings/EVIDENCE.md`. Contrast ratios below are **calculated by hand from the hex tokens in source** (WCAG relative-luminance formula), not read off a tool.

**Methodology caveat (say this plainly):** no live screen-reader session (VoiceOver/NVDA/JAWS) was run for this file — the browser had already been driven before this review started, and I was told to work from evidence + source. Everything below that describes *actual announced behavior* (nested live regions, focus loss, sandboxed popups) is a **source-derived inference from documented browser/ARIA/AT behavior**, not something I heard a screen reader say. I've flagged confidence per item. Before shipping any fix, re-verify with a real screen reader — Lighthouse a11y=100 already proves that automated-only sign-off is not sufficient here.

---

## Issues, ranked by severity

### 1. Closing the assistant panel never returns focus to the launcher — focus is silently dropped
**Severity:** Major
**Where:** `packages/widget/src/loader-core.ts:208-211` (`close()`); `packages/widget/public/index.html:842` (`setOpen`, the `else { launcher.focus(); }` branch) and `:1411-1415` (the `PANEL_MODE` override that calls `sendToLoader("palup:close")`)
**Evidence:** Confirmed by reading the code paths, not a screenshot. `close()` in the loader is:
```ts
function close(): void {
  if (iframe) iframe.style.display = "none";
  launcher.setAttribute("aria-expanded", "false");
}
```
No `launcher.focus()` call. The panel's own `setOpen(false)` branch (`index.html:842`) calls `launcher.focus()`, but that targets the *panel's own internal* `#launcher` button, which is CSS-hidden in panel mode (`display:none`) and lives inside the iframe — it is never the real, visible pill in the host page's shadow root. That real pill is a completely separate DOM node the iframe cannot reach (cross-origin, closed shadow root). When the iframe is set to `display:none`, any focus that was inside it is dropped to `<body>` of the host page with no indicator.
**Why it hurts the user:** every close path — the "—" minimize button, Escape, and the loader's own `close()` — leaves a keyboard or screen-reader user's focus at the top of the document with no visible focus ring anywhere. They have to re-discover where they are and re-Tab (potentially through the whole product grid, see #3) to get back to the launcher. This is exactly the "focus goes missing when a disclosure/dialog-like widget closes" pattern the ARIA APG explicitly warns against.
**Fix:** in `loader-core.ts`'s `close()`, add `launcher.focus()` after hiding the iframe (loader owns the real, visible button, so it's the only place that *can* fix this). Also have the panel confirm to the loader when the shopper's own Escape/minimize triggered the close (it already does, via `palup:close`) so the loader always restores focus regardless of which side initiated the close.
**What good looks like:** clicking "—" or pressing Escape inside the panel visibly returns keyboard focus to the "💬 Ask the expert" pill, with its `:focus-visible` ring shown.

---

### 2. Every cart quantity change / item removal destroys and rebuilds the whole list — focus is lost on every interaction
**Severity:** Major
**Where:** `packages/widget/public/storefront/app.js:356-411` (`renderCart`); the `+`/`−`/`Remove` buttons at `:380-408`
**Evidence:** source-confirmed, not visually apparent in a screenshot. `renderCart()` starts with `mount.textContent = "";` (line 359) and rebuilds the entire `<ul class="cart-list">` from scratch on every call. `setQty()` and `removeItem()` (called from the `+`/`−`/Remove `onclick` handlers) both call `renderCart()` synchronously afterward.
**Why it hurts the user:** clicking any quantity button or "Remove" destroys the very button that has focus and replaces it with a brand-new element. The browser drops focus to `<body>`. A keyboard-only or screen-reader shopper adjusting quantities on a 3-item cart has to re-Tab from the top of the page after **every single click** — there is no way to, say, decrease quantity twice in a row without losing your place each time. `#cart` is `aria-live="polite"` (`cart.html:22`) so the *content* change is announced, but the *focus* is not preserved, which is the more disruptive part for a keyboard user completing a task.
**Fix:** after `renderCart()` rebuilds the list, restore focus to the equivalent control on the still-existing item (e.g., the "+" button for the same `productId`, or the next remove button if the row was deleted), or diff/patch existing rows instead of nuking the container. At minimum, focus the cart heading (`<h1>Your cart</h1>`) after a destructive rebuild so focus isn't lost to `<body>`.
**What good looks like:** after clicking "−" on an item, focus lands back on that item's (possibly re-rendered) "−" button; after "Remove", focus moves to the next item's "Remove" button or to the cart heading if the list is now empty.

---

### 3. Sign-in likely doesn't work at all inside the real embed — the iframe's sandbox has no `allow-popups`/`allow-top-navigation`
**Severity:** Major (confidence: source-derived, **not verified live** — flag for a real click-test before treating as confirmed)
**Where:** `packages/widget/src/loader-core.ts:147` — `el.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms");`; the sign-in flow at `packages/widget/public/index.html:795-819` (`startShopperSignIn`, `promptSignIn`)
**Evidence:** Not shown in any screenshot (sign-in wasn't exercised in this evidence set) — this is a source-code deduction: `startShopperSignIn()` calls `window.open(url, "palup_signin", …)`, with a documented fallback for when the popup is blocked: `if (!w) { … a.onclick = () => { (window.top || window).location.href = url; } }`. Per the HTML spec, a sandboxed iframe **without `allow-popups`** cannot call `window.open()` at all (it returns `null`/no-ops, gesture or not), and **without `allow-top-navigation`/`allow-top-navigation-by-user-activation`** it also cannot navigate the top frame. The real embed's iframe (`loader-core.ts:147`) has neither flag. So both the primary path (popup) and its own documented fallback (top-frame redirect) are blocked by the same sandbox attribute in the actual production embed. (The code comment about the `/auth/customer/login` route itself 404ing "unless the backend has CAA enabled" is a separate, independent gate — even with CAA enabled, the sandbox issue above would still block it.)
**Why it hurts the user:** "Sign in to view your orders" (`#signin`, `index.html:265`) is a labeled, focusable, keyboard-operable button — it looks fully accessible. But if the deduction above is right, activating it produces **no perceivable result for any user, keyboard or not** — worse, if the "Popup blocked" fallback UI *does* render (since `window.open` returning null is exactly what that branch is for) but then its own "Click to sign in" button *also* silently fails, a screen-reader user gets a status message telling them what to click, clicks it, and nothing happens — a status-message contradiction (SC 4.1.3 territory) as well as a plain functional dead end.
**Fix:** add `allow-popups allow-popups-to-escape-sandbox` to the iframe's `sandbox` attribute in `loader-core.ts:147` (and/or `allow-top-navigation-by-user-activation` if the top-frame-redirect fallback is meant to be a real path), then manually click through sign-in in the real embed to confirm.
**What good looks like:** clicking "Sign in to view your orders" inside the actual embedded widget (not the standalone `/widget` page) opens a real popup or performs a real top-frame redirect, and if genuinely blocked by the *browser's* popup blocker (not the sandbox), the fallback link visibly works.

---

### 4. Product grid: 24+ product names are plain `<span>`s, not headings — no way to jump between products by heading
**Severity:** Minor
**Where:** `packages/widget/public/storefront/app.js:161-174` (`productCard`) — `body.appendChild(el("span", "title", p.title));`
**Evidence:** confirmed in source; visually consistent with `desktop-1440-light.png` (28 product cards on one page, each with a bold title but no semantic heading level).
**Why it hurts the user:** screen-reader users routinely navigate long e-commerce grids by jumping heading-to-heading (VoiceOver rotor / NVDA "H" key). With every product name rendered as a `<span>`, that navigation shortcut doesn't exist here — a screen-reader shopper has to move item-by-item (or link-by-link) through all ~28+ cards to survey the catalog. Not a numbered-SC failure on its own (WCAG doesn't mandate headings), but it's the single most common real-world card-grid a11y complaint automated tools never catch.
**Fix:** render each product's title as `<h3>` (or `<h2>` if the page has no other h2) inside the card link, keeping the `.title` class/styling. Card grids elsewhere in the app (cart rows) can stay as-is since they're a short list, not a browse surface.
**What good looks like:** pressing "H" in NVDA/VoiceOver's rotor cycles through product names on `/` the way it cycles through headings on any well-structured content page.

---

### 5. Consent/status cards nest a second live region (`role="status"`) inside the already-live chat log — possible double/garbled announcements
**Severity:** Minor (confidence: source-derived, **not verified live** — nested live-region behavior is genuinely AT/browser-dependent)
**Where:** `packages/widget/public/index.html:253` (`#messages` — `role="log" aria-live="polite"`) with children carrying their own `role="status"` appended into it: `:555` (memory-consent card), `:587` (special-consent card), `:770` (carry-over prompt), `:801`/`:814` (sign-in status lines), `:1007` (resume offer), `:1033` (handoff notice), `:1040` (offline/retry)
**Evidence:** confirmed by reading the markup; not something I heard read aloud.
**Why it hurts the user:** `role="log"` already carries an implicit "announce what gets appended" live-region semantic — that's the entire point of using it for a chat transcript. Appending a *second*, independently-live `role="status"` subtree (with its own implicit `aria-live="polite" aria-atomic="true"`) into an already-live container is a known trap for double-announcing or inconsistently-ordered announcements across NVDA/JAWS/VoiceOver + Chrome/Firefox combinations.
**Fix:** drop the redundant `role="status"` from elements appended into `#messages` (the parent `role="log"` already announces new children) — reserve `role="status"` for status text that's *not* already inside a live region.
**What good looks like:** each consent card, resume offer, and system line is announced exactly once when it appears, verified with an actual NVDA/VoiceOver pass over each flow.

---

### 6. Mobile full-screen panel doesn't hide the storefront behind it from assistive tech
**Severity:** Minor
**Where:** `packages/widget/src/loader-core.ts:46-55` (`panelStyleSheet` — the `@media (max-width:480px)` rule that makes `.palup-panel-iframe` cover `inset:0; width:100vw; height:100dvh`)
**Evidence:** confirmed by reading the file end-to-end — there is no `inert`, `aria-hidden`, or scroll-lock applied to the host document anywhere in `loader-core.ts` or `loader-entry.ts` when the panel opens.
**Why it hurts the user:** on a phone, the panel is deliberately made to look and behave like a full-screen modal (the code's own comment: "small-viewport ⇒ full-screen"). But nothing marks the storefront behind it as hidden from assistive tech. A keyboard user can still Tab into the (visually covered) storefront links/buttons behind the "full-screen" chat, landing on controls they cannot see, which is disorienting and inconsistent with how a full-screen overlay is supposed to behave.
**Fix:** when the panel opens on a small viewport, set `inert` (or `aria-hidden="true"` + a real focus trap) on the host page's other top-level content, and release it on close.
**What good looks like:** with the mobile panel open, Tab cycles only within the chat panel; nothing behind it is reachable until it closes.

---

### 7. Skip link's focus indicator is the unstyled browser default
**Severity:** Polish
**Where:** `packages/widget/public/storefront/app.css:66-67` (`.skip`, `.skip:focus { left: 0; }` — no `outline` rule)
**Evidence:** `review-screenshots/keyboard-focus-skiplink.png` — a thin dark box around "Skip to content", consistent with an unstyled browser default rather than a designed ring.
**Why it hurts the user:** it *is* visible, so this passes SC 2.4.7 (Focus Visible, AA) as written — WCAG 2.2's stronger focus-appearance requirement (2.4.13) is AAA only, so this is not a compliance failure. But it's the one interactive element on the page whose focus ring the design system didn't touch, while every other control (`.cart-link:focus-visible`, `.card:focus-visible`, `.btn:focus-visible`, etc. — `app.css:73,77,93,117,122,138,142`) gets a deliberate 2px `--accent`/`--ink` ring. It reads like an oversight, not a choice.
**Fix:** add `.skip:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }` to match the rest of the page's focus language.
**What good looks like:** the skip link's focus ring looks like it belongs to the same design system as the cart link and buttons.

---

### 8. Document `<title>` briefly renders the literal placeholder `{brand}`
**Severity:** Minor
**Where:** `packages/widget/public/storefront/home.html:6`, `cart.html:6`, `product.html:6` (`<title>{brand} — Clean, effective skincare</title>` etc.), fixed post-load by `app.js:152` (`setBrand`)
**Evidence:** listed in `EVIDENCE.md` item 6; not separately screenshotted, but directly confirmed in the HTML source and the JS that patches it.
**Why it hurts the user:** a sighted user sees this for a flash in the tab title. A screen-reader user who has the page read to them right after load (many jump straight to the document title on navigation) can have the literal string "brace brand brace" (or similar) announced before the JS patch lands — a small but real moment of confusion specific to AT users that a sighted user mostly just glimpses and ignores.
**Fix:** server-render the real brand name into `<title>` for the initial HTML response instead of shipping a client-patched placeholder (the brand name is already known server-side, per `setBrand`/`data.brandName`).
**What good looks like:** `document.title` is correct on the very first paint, with no placeholder state ever exposed.

---

### 9. Shipping/returns policy text is truncated mid-word — an understandability problem, not just a visual one
**Severity:** Minor
**Where:** rendered via `packages/widget/public/storefront/app.js:154-159` (`setPolicy`, plain `textContent` assignment — no client-side truncation/clamping exists in `app.css` for `.assistant-note`/footer text); the truncated strings themselves ("…it's basical", "…look 22 agai") are server-supplied content, not client markup
**Evidence:** `desktop-1440-light.png` bottom footer; `EVIDENCE.md` item 4.
**Why it hurts the user:** this isn't CSS overflow clipping — `setPolicy` writes the string directly with `textContent`, so the source text itself is already cut off mid-word before it reaches the browser. A sighted user can at least *see* the sentence trail off and guess something's missing; a screen-reader user hears a grammatically broken sentence read verbatim, with nothing to signal that content — specifically the store's returns/refund terms — is incomplete. There's no single numbered WCAG SC for "don't ship truncated legal text," but it directly undermines the Understandable principle, and the harm lands disproportionately on users who can't visually infer "this was cut off."
**Fix:** fix at the source (whatever generates/bounds this merchant's policy string) to truncate on a sentence/word boundary, or don't truncate policy text at all.
**What good looks like:** the shipping and returns paragraphs read as complete sentences for every merchant, always.

---

### 10. Two identically-purposed, identically-worded, differently-styled "Ask the expert" controls on one page
**Severity:** Polish
**Where:** hero CTA — `packages/widget/public/storefront/home.html:28` (`<button … >💬 Ask the expert</button>`, terracotta `.btn`); floating launcher — `packages/widget/src/loader-core.ts:82,95` (`aria-label="Ask the expert"`, evergreen fill)
**Evidence:** `mobile-390-viewport.png` shows both simultaneously.
**Why it hurts the user:** primarily a visual-consistency issue (already flagged elsewhere in this review set), but there's a small accessibility angle too: a screen-reader user tabbing through "button, Ask the expert" twice, in two different visual styles, with no distinguishing accessible context (no "in page content" vs. "floating" landmark difference exposed to AT), has no way to tell — by name alone — that these are two paths to the exact same action rather than two different features.
**Fix:** covered by the visual-consistency fix already recommended elsewhere (pick one brand color); no separate accessibility-specific fix needed beyond that.
**What good looks like:** one clearly primary "Ask the expert" affordance, or two that are visually and semantically distinguishable if both are intentional.

---

## Tap target sizes — clarifying the WCAG bar (not a new issue)
`EVIDENCE.md` flags the cart link at 63×42 and asks whether that's a problem. For WCAG 2.2 **AA**, the relevant success criterion is **2.5.8 Target Size (Minimum)**, whose floor is **24×24 CSS px**. At 42px tall, the cart link clears that with room to spare — **this is not an AA violation**. 44×44 is the **AAA**-level guideline (2.5.5, and separately Apple/Google's own HIG-style recommendations) — worth moving toward as polish, but not a compliance gap. Same conclusion for the hero CTA (173×52) and the floating launcher (48px tall, `loader-core.ts:89`): both comfortably clear 24px.

## Color contrast — measured from the hex tokens in source
All computed with the standard WCAG relative-luminance formula from the literal hex values in source (not eyeballed):

| Pair | Tokens | Where | Computed ratio | AA floor | Result |
|---|---|---|---|---|---|
| Terracotta text/link on white | `#a6482f` on `#ffffff` | `storefront/app.css:18` | **5.86:1** | 4.5:1 | Pass |
| White text on terracotta fill (hero CTA) | `#ffffff` on `#a6482f` | `app.css:18,120` | **5.86:1** (same pair, reversed) | 4.5:1 (normal-size text) | Pass |
| White label on evergreen launcher fill | `#ffffff` on `#0c4a3c` | `loader-core.ts:93` | **~10.2:1** (source comment claims ~9.4:1 — both far clear AA) | 4.5:1 | Pass, comfortably — clears AAA too |
| Widget muted/secondary text on panel | `#475569` on `#ffffff` | `index.html:18` | **7.58:1** | 4.5:1 | Pass |
| Storefront muted text on white | `#6f6b64` on `#ffffff` | `app.css:15` | **5.30:1** | 4.5:1 | Pass |
| Storefront muted text on footer tint | `#6f6b64` on `#f7f6f4` | `app.css:15,148` | **4.90:1** | 4.5:1 | Pass, narrow margin |
| Storefront body copy (`--ink-2`) on white | `#4b4843` on `#ffffff` | `app.css:14` | **9.10:1** | 4.5:1 | Pass |
| "current price needs confirming" card text | `#0f172a` (`--fg`) on `#ffffff` (`--panel`) | `index.html:18`, rendered via `.rec-p` at `:204` | near-black on white, well over 15:1 | 4.5:1 | Pass, not a contrast problem — its only problem is credibility/wording, already flagged elsewhere in this review set |

None of the requested pairs actually fail AA contrast. That tracks with Lighthouse's 100 — contrast specifically **is** something automated tools measure reliably; it's the structural/behavioral issues above (#1–#6) that Lighthouse cannot see.

## What's working well — preserve these patterns
- **Merchant-brand theming is contrast-safe by construction.** `packages/widget-backend/src/widget-theme.ts:94-117` algorithmically adjusts a merchant's arbitrary brand color (and its ink/text variants against both the light and dark panel) until every derived value clears 4.5:1, before it's ever applied. This is the right way to let merchants customize color without an accessibility regression, and should be the model for any future themable surface.
- **`prefers-reduced-motion` is genuinely wired up**, and wired up *last* in the stylesheet on purpose (`index.html:210-222`, `storefront/app.css:152-156`) — the file even documents, in a comment, the earlier bug where source order made it dead code. Good instinct, good regression-proofing.
- **The "What I remember" memory panel uses a native `<details>`/`<summary>` disclosure** (`index.html:621-651`), not a JS-rebuilt div. That's free keyboard operability and free expand/collapse semantics with zero ARIA to get wrong.
- **Product images get real, meaningful alt text** (`storefront/app.js:131-143,168` — `alt` is the product title, not empty, not a filename), and a missing image degrades to a visible "No image" text label rather than a silent gap.
- **Cart quantity controls have specific, disambiguating labels** — `aria-label="Decrease quantity of " + i.title` etc. (`app.js:383,391,403`) — better than a bare "+"/"−"/"Remove" would be, even though the focus-loss issue above (#2) undercuts the benefit today.
- **The launcher's accessible name is a real subset of its visible text** (`"Ask the expert"` inside `"💬 Ask the expert"`, `loader-core.ts:82,95`) — satisfies SC 2.5.3 Label in Name correctly, and matches the pattern used throughout the panel (`#in`, `#send`, `#checkoutbtn`, etc.).
- **Escape closes the panel** (`index.html:845`) and the scrollable message log is a real keyboard tab stop (`tabindex="0"` + `aria-label` at `:253`, with the reasoning left in a comment) — someone already thought about SC 2.1.1 here.
- Focus-visible styling is applied deliberately and consistently across both the widget (`index.html:64,92,101,133,137,145,148,162,169,178`) and the storefront (`app.css:73,77,93,117,122,138,142`) — the skip link (#7 above) is the one visible exception.

---

## Is anything here a true Blocker?
No. Nothing found rises to "blocks access entirely, no workaround" for a *sighted, mouse-using* shopper — that's why Lighthouse reads 100. For a **keyboard-only or screen-reader shopper**, though, #1 and #2 are close to it in practical terms: closing the assistant or editing a cart quantity repeatedly strands their focus at the top of the document, which is exactly the kind of thing that makes a keyboard user give up on a task without ever hitting a hard technical wall. #3 (sign-in) would be a functional Blocker for account access **if** the sandbox deduction is confirmed live — that one specifically needs a real click-test before anyone treats it as settled.
