# Frontend Developer — concrete fixes for the 10 UX-review leads

Review-only. Nothing in this file has been applied. Each section: where, current code, proposed
change (exact values), and risk/side-effects. Confidence is noted per finding: **confirmed**
(read the exact file:line) vs **inferred** (consistent with the code, not independently proven —
e.g. I have no live network trace or staging env-var dump).

---

## 1. Two "💬 Ask the expert" buttons in different colors

**Where:** hero CTA — `packages/widget/public/storefront/app.css:18,120`; launcher pill —
`packages/widget/src/loader-core.ts:87-94`. Screenshot: `mobile-390-viewport.png`.

**Confirmed, and NOT an accident.** `packages/widget-backend/src/widget-theme.ts:54-63`:

```ts
// The staging demo tenants use the PalUp merchant-console evergreen (owner directive,
// 2026-08-21) so the widget reads as PalUp-native rather than the old storefront terracotta.
const THEME_CONFIGS: Record<string, ThemeConfig> = {
  "palup-skincare-jason": { brand: "#0c4a3c" },
  demo: { brand: "#0c4a3c" },
};
```

The launcher's hardcoded default (`#0c4a3c`, loader-core.ts:93) and the `/embed/theme` response it
fetches to recolor itself (loader-core.ts:118-133) resolve to the **same** evergreen — so the
launcher is correctly evergreen by a same-day deliberate decision (also visible in git history:
`21665ac feat(widget): ... retheme merchant/default injected theme to evergreen (#415)`). The
storefront hero CTA was **not** updated to match — it's still on the old terracotta token. This is
a genuine, verifiable inconsistency, just not the one EVIDENCE.md's lead assumed (it's the
storefront that's stale, not an accidental theming bug in the widget).

**Current (`app.css`):**
```css
18:  --accent: #a6482f;       /* terracotta; ~5.2:1 on white for links/text */
...
120: .btn { ... border: 1px solid var(--accent); background: var(--accent); color: var(--accent-ink); ... }
```

**Fix — align the storefront to the same evergreen (the more recent, deliberate direction):**
```css
--accent: #0c4a3c;       /* evergreen — matches the widget launcher/panel brand */
--accent-hover: #0a3d32;
--accent-soft: #e8f0ed;
```
And in the dark-mode block (line 40-43) use the lighter evergreen already used elsewhere in this
codebase for AA-on-dark text (`#5eb99b`, used in `packages/widget/public/index.html:37`):
```css
--accent: #5eb99b;
--accent-hover: #78cbb0;
--accent-soft: #16241f;
```
This is a **CSS-variable-only change** — every other rule already references `var(--accent)`, so
no other line needs touching.

**Risk:** the terracotta was chosen (per app.css:1-7's own comment) to be "cohesive with the
brand-themed widget" and deliberately distinct from "the console evergreen system" — i.e. someone
previously decided terracotta was the storefront's own identity. Flipping it to evergreen is the
visually-consistent fix but **reverses that earlier design intent**; equally valid alternative is
to change `THEME_CONFIGS["palup-skincare-jason"].brand` back to terracotta (`#a6482f`) so the
*widget* matches the *storefront* instead — but that fights the explicit 2026-08-21 owner directive
in the comment above. **This is a product decision, not just a code change — flag to the owner
before picking a direction.**

---

## 2. Assistant won't show prices ("current price needs confirming")

**This is a backend/governance issue, not a frontend fix.** Confirmed mechanism, not confirmed live
config (see caveat below).

**Where:** `packages/widget-brain/src/brain.ts:138-146` (the hedge text + rule),
`:772-798` (`buildProductCards` — only hedges when `p.priceConfirmed === false`),
`:1226-1246` (hydration call site), `packages/widget-brain/src/hydrate-facts.ts:65-104`
(`hydrateProductFacts` / `isFactStale`), `packages/widget-backend/src/server.ts:750-767`
(the `PRODUCT_FACTS_HYDRATION` / `PRICE_REQUIRES_LIVE_CHANNEL` env-gated flags).

**What actually withholds the price**, traced through the code:
- This tenant's catalog is >1000 SKUs, so the assistant renders via the vector-retrieval path
  (`retrieveViaShell`, brain.ts:1104-1158). That path **always** builds cards with
  `price: ""` (brain.ts:1143 — `price: "", // corpus carries no description for render; price
  filled by hydrate below`) because the retrieval corpus deliberately never stores price.
- The only thing that can put a real price back is the Tier-2 hydration overlay
  (`hydrateProductFacts`), gated on `PRODUCT_FACTS_HYDRATION` (server.ts:754, env-read,
  default OFF) — turning it on in any live environment is documented in this file's own
  comments as a money/NN#1 change requiring HITL-POLICY §5 human promotion.
- Even when hydration runs, a fact renders `priceConfirmed:false` (the literal hedge) if it has
  no `updatedAt`, is older than `PRODUCT_FACTS_MAX_AGE_MS` (default 15 min), **or** if
  `PRICE_REQUIRES_LIVE_CHANNEL` is on and the merchant's freshness channel (Shopify
  webhook/poll producer) isn't provably live (hydrate-facts.ts:92-104).

**Caveat (inferred, not confirmed):** I can't read the staging Cloud Run service's actual
environment variables from this checkout, so I can't confirm whether `PRODUCT_FACTS_HYDRATION`
is on for `palup-skincare-jason` right now. But the *only* code path that can produce the literal
string `"current price needs confirming"` is `priceConfirmed === false`, and the widget panel
(`packages/widget/public/index.html:949-950`) just prints whatever `price` string the server sent
— it does no client-side "empty price → hedge" substitution. So the hedge is server-decided, and
given every product on this storefront hedges, the most likely explanation is that hydration is on
but either (a) no Tier-2 facts have been ingested yet for this tenant (A3 producer not wired), or
(b) `PRICE_REQUIRES_LIVE_CHANNEL` is on and the freshness channel isn't provably live for this
tenant yet — both are ops/infra states, not something in this repo's code that's wrong.

**There is no frontend fix here.** The frontend already does the right thing (shows exactly the
string the server sends, degrades gracefully). Fixing "prices don't show" means either (a) an
operator populating/verifying the Tier-2 facts pipeline and freshness channel for this tenant, or
(b) a human promotion decision to relax the hedge for a demo tenant — both governance/ops actions
outside frontend scope, and both require going through HITL-POLICY §5, not a code PR.

---

## 3. Price format `$35.0` (one decimal)

**Confirmed.** `packages/widget-backend/src/shopify-grounding.ts:107-110`:

```ts
function formatPrice(p?: { amount?: string; currencyCode?: string }): string {
  if (!p?.amount) return "";
  return p.currencyCode && p.currencyCode !== "USD" ? `${p.amount} ${p.currencyCode}` : `$${p.amount}`;
}
```

Shopify's Storefront API returns `MoneyV2.amount` as a decimal **string** with whatever precision
the source data has (e.g. `"35.0"`), and this function concatenates it verbatim with no
normalization. This is a **backend file**, not a frontend one (`packages/widget-backend`), but it's
the direct cause of the `$35.0` the storefront and the assistant both display, so flagging it here
per the source map in EVIDENCE.md.

**Fix:**
```ts
function formatPrice(p?: { amount?: string; currencyCode?: string }): string {
  if (!p?.amount) return "";
  const n = Number(p.amount);
  const amount = Number.isFinite(n) ? n.toFixed(2) : p.amount; // fail-safe: never throw on a bad string
  return p.currencyCode && p.currencyCode !== "USD" ? `${amount} ${p.currencyCode}` : `$${amount}`;
}
```
`$35.0` → `$35.00`; `$99.0` → `$99.00`; a non-numeric amount (shouldn't happen, but the function is
defensive elsewhere) falls back to the raw string rather than throwing.

**Risk:** `formatPrice` isn't exported and I found no direct unit test asserting its exact output
string (checked `packages/widget-backend/src/*.test.ts` — grep for `formatPrice` found only the
definition site), so this looks low-risk, but I haven't run the widget-backend test suite this
session to confirm nothing snapshot-asserts a `"$35.0"`-shaped string elsewhere (e.g. grounding
fixture tests). Run `pnpm test` in `packages/widget-backend` before merging.

---

## 4. Footer policy text truncated mid-word

**Confirmed.** `packages/widget-backend/src/shopify-grounding.ts:70`:

```ts
const bound = (s: string | undefined, max: number): string => (s ?? "").slice(0, max);
```

Called at lines 156-157 / 175-176 with `MAX_DESC = 600` (line 66) on the raw
`shop.refundPolicy.body` / `shop.shippingPolicy.body` HTML. A hard `.slice(0, 600)` with no
ellipsis and no word-boundary awareness is exactly what produces "…it's basical" and "…look 22
agai" — it can land anywhere, including mid-word, and gives the reader no signal that text is
missing. (The storefront route's `toPlainText()` in
`packages/widget-backend/src/routes/storefront-catalog.ts:46-58` strips HTML tags *after* this
slice already happened, so the 600-char budget is spent partly on markup, making the visible
cutoff even earlier than 600 plain-text characters.)

**Fix (word-boundary truncation + visible ellipsis):**
```ts
const bound = (s: string | undefined, max: number): string => {
  const t = s ?? "";
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut) + "…";
};
```
Output is still bounded to ≤ `max + 1` chars, so it doesn't blow any downstream size budget (the
brain.ts CATALOG-block size comments rely on `MAX_TITLE`/`MAX_DESC` as an upper bound, which this
preserves).

**Risk:** `bound()` is shared by product `title`/`description` (lines 141-142) as well as policy —
this fix improves all of them (word-boundary + ellipsis is strictly better than a mid-word silent
cut for any of these), but it does touch text the LLM prompt also sees, not just the storefront
display, so re-run the grounding/prompt-fixture tests in `packages/widget-backend` before merging.
Residual edge case: because this still truncates before HTML-tag-stripping for policy text, the cut
can still occasionally land inside a tag (rare, and no worse than today).

**A second, purely-frontend mitigation** worth considering independently: the footer text itself is
long "jokey" merchant copy (see #10 below) — even at the full, untruncated length it's a wall of
text. A collapsible `<details>`/"Read full policy" affordance in
`packages/widget/public/storefront/home.html:36-43` would let the footer show 2-3 lines by default
with an expand control, which is a frontend-only change independent of the backend truncation fix.

---

## 5. Blank product image tiles

**Where:** `packages/widget/public/storefront/app.js:131-143` (`thumb()`).

```js
function thumb(imageUrl, alt, cls) {
  var box = el("div", cls || "thumb");
  if (typeof imageUrl === "string" && imageUrl) {
    var img = document.createElement("img");
    img.src = imageUrl;
    img.alt = alt || "";
    img.loading = "lazy";
    box.appendChild(img);
  } else {
    box.appendChild(el("span", "ph", "No image"));
  }
  return box;
}
```

**Evidence check:** I cropped the blank tiles in `desktop-1440-light.png` (bottom row —
"CHRISTOPHE ROBIN color fixator wheat germ mask" etc.) and they show **no visible "No image" text
at all** — just a flat `--surface-2` grey box. That rules out the `imageUrl` falsy/missing branch
(which would render the "No image" placeholder text, clearly legible per app.css:96 contrast).
**Inferred** (I did not capture a network trace, so this is consistent-with-evidence, not proven):
these products have a truthy `imageUrl` string that 404s or fails to load (e.g. a stale/deleted
Shopify CDN asset), and the `<img>` has no `onerror` handler — a broken `<img>` with
`width:100%;height:100%` and no intrinsic dimensions can paint as an empty box rather than showing
the browser's broken-image icon, which is consistent with what the screenshot shows.

**Fix — fall back to the placeholder on a load failure:**
```js
function thumb(imageUrl, alt, cls) {
  var box = el("div", cls || "thumb");
  if (typeof imageUrl === "string" && imageUrl) {
    var img = document.createElement("img");
    img.src = imageUrl;
    img.alt = alt || "";
    img.loading = "lazy";
    img.addEventListener("error", function () {
      img.remove();
      box.appendChild(el("span", "ph", "No image"));
    });
    box.appendChild(img);
  } else {
    box.appendChild(el("span", "ph", "No image"));
  }
  return box;
}
```
Same pattern applies to the PDP media thumb (same function, reused at `app.js:249` via
`thumb(p.imageUrl, p.title, "media")`) and the cart row thumb (`app.js:376`) — one shared fix
covers all three.

**Risk:** none functionally; purely additive (only fires on an already-broken image). Verify visually
against the real 404ing URLs before merging, since I haven't confirmed the exact failure mode with
a network trace.

---

## 6. `{brand}` title FOUC

**Confirmed.** `packages/widget/public/storefront/home.html:6`:
```html
<title>{brand} — Clean, effective skincare</title>
```
(Same pattern in `product.html:6` — `<title>Product — {brand}</title>` — and `cart.html:6` —
`<title>Your cart — {brand}</title>`.) `packages/widget/public/storefront/app.js:147-153`:
```js
function setBrand(brandName) {
  var name = brandName || "this store";
  document.querySelectorAll("[data-brand]").forEach(function (n) { n.textContent = name; });
  if (document.title.indexOf("{brand}") >= 0) document.title = document.title.replace("{brand}", name);
}
```
`setBrand` only runs after `fetchPage(null)` resolves (a network round-trip to
`/storefront/catalog`), so the literal placeholder `{brand}` is what a shopper's browser tab and
any pre-fetch-resolution paint actually shows.

**Fix — don't ship a placeholder token as the default; ship a real fallback and let JS override it:**
```html
<title>PalUp Skincare Jason — Clean, effective skincare</title>
```
Since the tenant's real brand name is already known server-side at request time (the same
`server.ts:290` `readFileSync` of `home.html` happens once at boot — the shop-specific value isn't
templated in per-request today), the more correct fix is to make the server template the real
`brandName` into the title server-side before serving the HTML (the same brand-name resolver the
server already has: `brandNameFor`, `server.ts:525-528`), the same way it already avoids a
placeholder for anything security-relevant. That eliminates the FOUC entirely rather than papering
over it with a nicer-looking fallback.

**Risk:** the client-side `setBrand` string-replace path (line 152) must stay as a safety net for
any tenant whose HTML wasn't (yet) server-templated; don't remove it. Server-side templating is a
bigger change (touches `server.ts`'s static-file-serving setup, not just the HTML files) — the
`<title>{fallback}</title>` swap alone is the 1-line mitigation; full server-side templating is the
real fix and is more than a one-line change.

---

## 7. Cold-state panel: big empty gap between opener chips and input

**Where:** `packages/widget/public/index.html:98`:
```css
#messages{ flex:1; overflow-y:auto; padding:16px 14px; display:flex; flex-direction:column; gap:10px; background:var(--panel); }
```
No `justify-content` is set, so the flex-column default (`flex-start`) packs the greeting + chips
at the **top** of the message log and leaves the remaining height empty at the bottom, above the
input — exactly what `panel-390-open.png` shows.

**Fix:**
```css
#messages{ flex:1; overflow-y:auto; padding:16px 14px; display:flex; flex-direction:column; justify-content:flex-end; gap:10px; background:var(--panel); }
```
Anchoring content to the bottom of the log is the common chat-UI pattern (content grows upward
from the input) and removes the dead space in the cold state.

**Risk — checked, low:** every message-append call site in this file already forces
`msgs.scrollTop = msgs.scrollHeight` after appending (12 call sites, e.g. `index.html:574, 601,
782, 805, 818, 865, 1000, 1009, 1035, 1044, 1117`), so once the log overflows, behavior is
unaffected by this change — it only changes the layout of the **non-overflowing** (cold-state)
case. One-line CSS change.

---

## 8. CLS 0.345 (root cause verified, not just guessed)

**Where:** `packages/widget/public/storefront/home.html:32` + `app.css` grid rules
(`app.css:89-96`, `#grid` has no reserved height).

**Confirmed root cause** — I pulled the Lighthouse trace's own attribution rather than relying on
EVIDENCE.md's "likely" guess:
```
"layout-shifts" audit → single shift, metricSavings.CLS = 0.345,
node: "body > footer.site-footer", boundingRect.top: 4497 (i.e. the footer jumped down ~4500px)
```
So the CLS is **not** primarily the individual product-card images — `.card .thumb` already
reserves `aspect-ratio: 1/1` (`app.css:94`), which correctly prevents per-image shift. The real
cause: `#grid` starts as an **empty div with no reserved height**
(`<div id="grid" class="grid" aria-label="Products" aria-busy="true"></div>`, home.html:32), and
`appendPage()` (`app.js:184-194`) synchronously appends up to 24 full product cards only after the
`/storefront/catalog` fetch resolves. The grid balloons from ~0px to its full multi-row height in
one paint, shoving everything below it (the footer, which is what Lighthouse measured) down the
page — and because the page is short before that fetch resolves, the footer is inside the viewport
both before and after, so the full shift counts against CLS.

**Fix — reserve grid height with skeleton placeholders before the fetch resolves:**
```js
// in renderHome(), before fetchPage(null):
var SKELETON_COUNT = 8;
for (var i = 0; i < SKELETON_COUNT; i++) {
  var sk = el("div", "card skeleton");
  sk.appendChild(el("div", "thumb"));
  var b = el("div", "body");
  b.appendChild(el("span", "title skel-line"));
  b.appendChild(el("span", "price skel-line"));
  sk.appendChild(b);
  grid.appendChild(sk);
}
```
```js
// in appendPage(), before appending real cards:
grid.querySelectorAll(".skeleton").forEach(function (n) { n.remove(); });
```
```css
/* app.css */
.card.skeleton .thumb, .skel-line { background: var(--surface-2); }
.skel-line { display: inline-block; height: 12px; border-radius: 6px; width: 70%; }
```
8 skeleton cards at the real `.card`/`.thumb` box model (same `aspect-ratio: 1/1`) reserve
approximately the right amount of vertical space for the first 1-2 rows immediately at paint time,
so the real content's arrival causes at most a small, bounded shift instead of a near-full-page
jump. It won't perfectly match every catalog page's exact row count, but it collapses the shift by
roughly the fraction of the page the skeleton correctly anticipates (2 rows out of ~6 shown in the
screenshot ≈ a large reduction, not a full fix to <0.1 — measure after implementing).

**Risk:** low — this only affects the loading state visual, no behavior change to the real cards or
the "Load more" flow. `aria-busy="true"` on `#grid` should stay set until `appendPage` runs so
assistive tech isn't told the skeletons are the final content.

---

## 9. Favicon 404

**Confirmed.** No `favicon.ico`/`favicon.svg` file anywhere under
`packages/widget/public` (checked: `find ... -iname "*favicon*"` → no results), and no
`<link rel="icon">` in `home.html`, `product.html`, or `cart.html`'s `<head>` — so every browser
request for the implicit `/favicon.ico` 404s (matches the one console error in `EVIDENCE.md`).

**Fix — smallest possible: an inline data-URI SVG, no new binary asset or backend route needed.**
Add to `home.html` (and `product.html`, `cart.html`) `<head>`, after line 8:
```html
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%230c4a3c'/%3E%3Ctext x='16' y='22' font-family='system-ui,sans-serif' font-size='17' font-weight='700' fill='white' text-anchor='middle'%3EP%3C/text%3E%3C/svg%3E" />
```
(Fill color `#0c4a3c` matches the evergreen brand token used elsewhere; swap to whatever accent
color #1's decision lands on.)

**Risk:** none — this only adds a response for a request the browser already makes; it can't break
anything else. Needs the same 3-line addition on all three storefront pages (`home.html`,
`product.html`, `cart.html`).

---

## 10. Verbose AI reply + verbose footer copy

Two different things, one frontend-fixable, one not.

**Footer copy (frontend-adjacent, fixable):** the jokey wall of text in the footer
(`"Your glow is on its way. Here's the deal on how it gets to you..."`, visible in
`desktop-1440-light.png`) is the merchant's own Shopify shop policy text
(`shop.refundPolicy.body` / `shop.shippingPolicy.body`, surfaced via
`packages/widget-backend/src/shopify-grounding.ts:155-159`) — the frontend can't rewrite a
merchant's actual policy copy, but it **can** stop dumping the whole thing inline. See the
"Read full policy" `<details>` suggestion in finding #4 above — genuine frontend UI change,
independent of the backend truncation fix.

**AI reply verbosity (not a frontend fix at all — I could not verify this claim against a real
transcript):** EVIDENCE.md's `panel-390-card.png` and `panel-390-open.png` don't show a
particularly long AI reply in the screenshots I reviewed, so I can't independently confirm "verbose
AI reply" beyond EVIDENCE.md's assertion. What I *can* confirm from source: reply length is already
governed at the prompt layer, not left unconstrained —
`packages/widget-brain/src/brain.ts:47`:
```ts
styleDirective: "Be concise: 2-4 sentences, warm, plain language.",
```
plus multiple "ONE short/brief sentence" constraints on specific reply kinds (lines 400, 435, 677,
683, 690). If replies are still coming out long in practice, that's a prompt/model-behavior tuning
question — a **run-time agent behavior change** per this repo's CLAUDE.md §2/§4, which routes
through `agent-evolution-steward` + the eval gate, not a frontend PR.

---

## Bonus — issues I spotted directly, not in the original 10

**B1. Cart-link tap target below the 44px minimum.** `app.css:75`:
```css
.cart-link { ... padding: 9px 16px; ... font-size: 14px; ... }
```
Computed height ≈ 42px (matches EVIDENCE.md's own measurement: "cart link 63×42"). WCAG 2.5.5 /
mobile-tap-target guidance wants ≥44px.
**Fix:** `padding: 11px 16px;` (raises computed height to ~44-46px with the existing 1px border +
line-height) — one-line change, no layout side-effects since `.nav` already has enough vertical
room (`padding: 16px 24px`, `app.css:71`).

**B2. Skip-link focus style falls back to the browser default outline, inconsistent with every
other focusable element on the page.** `app.css:66-67`:
```css
.skip { position: absolute; left: -999px; top: 0; background: var(--ink); color: var(--bg); padding: 10px 16px; border-radius: 0 0 10px 0; z-index: 100; }
.skip:focus { left: 0; }
```
Every other interactive element on this page defines an explicit `:focus-visible` outline in the
site's own accent color (`.brand:focus-visible`, `.cart-link:focus-visible`, `.card:focus-visible`,
`.btn:focus-visible`, etc. — all `outline: 2px solid var(--accent)` or `var(--ink)`), but `.skip`
doesn't, so it's stuck on the browser's thin 1px auto outline (exactly what EVIDENCE.md's
`keyboard-focus-skiplink.png` measurement notes). **Fix:**
```css
.skip:focus-visible { outline: 2px solid var(--bg); outline-offset: -4px; }
```
(offset negative + `--bg` color so the ring stays visible against the skip link's own dark
background, rather than the page's light background).

---

## Summary: fix effort

**Genuinely 1-line-ish (single value/selector change, no new logic):**
- #1 color unification (once a direction is picked) — swap `--accent` value(s) in `app.css`
- #3 price format — one function body, 2 lines
- #7 panel cold-state gap — one CSS property
- #9 favicon — one `<link>` tag × 3 files
- B1 tap target — one padding value
- B2 skip-link focus — one CSS rule

**Real work (new logic, multiple call sites, or a design/product decision first):**
- #1 requires an **owner decision** before any line is safely changed (reverses a same-day
  deliberate theming choice either way)
- #2 is **not a frontend fix at all** — ops/infra (Tier-2 facts pipeline + freshness-channel
  liveness) + a HITL-POLICY §5 human promotion
- #4 truncation fix touches a shared helper used by product text too (re-test prompt fixtures);
  the "Read full policy" collapse is a small but real new UI component
- #5 needs an `onerror` handler added at 3 call sites + visual confirmation against the real
  (unconfirmed) failure mode
- #6 the durable fix is server-side title templating (not just the HTML fallback string) — touches
  `server.ts`'s static-serving path
- #8 CLS needs a real skeleton-loading implementation (new markup + CSS + JS wiring, not a single
  property), and its effectiveness should be re-measured with Lighthouse after
- #10 the footer-copy half is a small new `<details>` component; the AI-reply-verbosity half is
  out of frontend scope entirely (governed prompt/model change)
