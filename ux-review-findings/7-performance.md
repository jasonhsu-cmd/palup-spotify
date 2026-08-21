# Performance Review — palup-widget-staging storefront (mobile Lighthouse)

**Bar:** consumer product used by hundreds of millions. **Measured:** Lighthouse mobile, `review-screenshots/lighthouse-mobile.json` (moto g power emulation, 412×823, 4x CPU slowdown, throttled network — a lab run, not field/CrUX data). Perf score **82**. FCP 1.2s · **LCP 2.2s** · TBT 0ms · **CLS 0.345 (POOR, target <0.1)** · Speed Index 2.1s · TTI 2.2s.

---

## 1. CLS 0.345 — POOR (Blocker)

**Where:** `packages/widget/public/storefront/home.html:32` (`<div id="grid" ... aria-busy="true">`, no fallback height), styled by `packages/widget/public/storefront/app.css:89` (`.grid { ...margin-top:32px }` — no `min-height`), populated asynchronously by `renderHome()`/`appendPage()` in `packages/widget/public/storefront/app.js:177-222`. Shift lands on the footer: `packages/widget/public/storefront/home.html:36-43` (`<footer class="site-footer">`).

**Evidence:** `layout-shifts` audit in `lighthouse-mobile.json` reports exactly **one** shift, `"1 layout shift found"`, and attributes the **entire** 0.345 CLS score to it: `node.selector: "body > footer.site-footer"`, `boundingRect {top: 4497, bottom: 5134, height: 638}` (viewport is 412px wide in this mobile run). `cumulative-layout-shift` numericValue 0.3450789793438639 matches EVIDENCE.md's 0.345.

**Root cause:** `#grid` starts empty on first paint (`aria-busy="true"`, no children, no reserved height beyond `margin-top:32px`). `app.js`'s `fetchPage(null)` (line 208) hits `/storefront/catalog`, and only once that network round trip resolves does `appendPage()` (line 184) synchronously insert ~22-24 product-card `<a>` elements into `#grid`. On the mobile 2-column layout (`app.css:90`) that's roughly a dozen rows of ~173px-square cards — the grid balloons from ~0px to ~3000+px tall in a single reflow, and everything below it, most consequentially the 638px-tall footer, gets shoved down by that whole delta. That one reflow is the entire CLS budget.

**Ruled out (don't chase these):** the grid's own product `<img>`s are NOT the cause — `.card .thumb` (`app.css:94`) already reserves `aspect-ratio: 1 / 1` before the image loads, and the `unsized-images` / `image-aspect-ratio` Lighthouse audits both score **1** with empty `items` (no unsized or wrong-ratio images found). The floating widget launcher and panel iframe (`packages/widget/src/loader-core.ts:37-55`) are also not responsible — both are `position:fixed` inside a closed shadow root, so neither ever participates in document flow and can't shift page content.

**Why it hurts the user:** a hundred-million-user-bar product does not let its footer (and, on slower connections/devices, potentially still-scrolling content) visibly jump ~3000px down mid-load. On a real device with iOS/Android momentum scrolling, a shopper who starts reading the footer copy or has scrolled partway down loses their place entirely when the grid finishes loading under them. It also tanks the Lighthouse score component that is the most visible, single-number proxy for "does this feel broken."

**Fix:** reserve the grid's footprint before the async data lands, so the DOM's total height doesn't change when the real cards swap in. Two options, in order of quality:
1. Render the first page of products server-side into the initial HTML (or embed the first-page JSON in an inline `<script>` tag `home.html` reads synchronously) instead of a pure client-side `fetch` — eliminates the shift and also fixes the LCP discoverability problem in Finding 2.
2. If keeping the client fetch, render skeleton placeholder `<div class="card">` blocks (same `.thumb` `aspect-ratio:1/1` + `.body` padding as the real cards) into `#grid` synchronously on page load, sized to the same grid the real data will produce, so `#grid`'s height is stable across the swap.

**What good looks like:** CLS < 0.1; the footer (and everything else) is in its final position by first paint, and swapping skeleton→real cards causes zero visible movement.

---

## 2. LCP 2.2s (Major)

**Where:** LCP element per Lighthouse = `div#grid > a.card > div.thumb > img` (first product card, "The Art of Shaving Pre-Shave Oil"), built by `thumb()` in `packages/widget/public/storefront/app.js:131-143`, which unconditionally sets `img.loading = "lazy"` (line 137) on every thumbnail including this one.

**Evidence:** `lcp-breakdown-insight` in `lighthouse-mobile.json` gives the exact subpart timings that sum to the reported 2200.792ms LCP: Time to first byte **255ms**, **Resource load delay 1038ms**, Resource load duration 66ms, Element render delay 474ms. `lcp-discovery-insight` (score 0) flags all three checks failing on that same `<img>`: `priorityHinted: false`, `requestDiscoverable: false`, `eagerlyLoaded: false` — i.e., Lighthouse itself identifies "LCP resources should not use `loading=lazy`" and "not discoverable in initial document" as the specific problems.

**Root cause:** the resource-load-delay term (1038ms, ~47% of total LCP) is dominated by the same async-render issue as Finding 1: the LCP `<img>` doesn't exist in the DOM at all until `fetchPage(null)` → `appendPage()` (app.js:184-194) run, so the browser can't even discover/queue that image request until after the catalog network round trip completes — and once it does exist, `loading="lazy"` (set for all thumbnails, not just off-screen ones) delays it further behind the browser's lazy-load heuristics.

**Fix:**
- In `thumb()` (`app.js:131-143`), don't set `loading="lazy"` on the first card's image (or the first row); set `fetchpriority="high"` on it instead — `productCard()`/`appendPage()` know the index, so this is a one-line conditional.
- Bigger win, same fix as Finding 1 option 1: server-render the first page of products into `home.html` so the LCP image is present and discoverable in the initial HTML response, removing the ~1038ms discovery delay entirely rather than just reordering priority.

**What good looks like:** LCP < 2.5s with resource-load-delay near-zero (image request starts within the first RTT, not gated behind a second fetch-then-render round trip).

---

## 3. Grid images shipped far larger than displayed (Major)

**Where:** `thumb()` in `packages/widget/public/storefront/app.js:131-143` sets `img.src = imageUrl` directly from the catalog API's `p.imageUrl` with no size parameter, no `srcset`/`sizes`. Images are served from `cdn.shopify.com` at their originally-uploaded resolution.

**Evidence:** `image-delivery-insight` (score 0, `displayValue: "Est savings of 406 KiB"`) lists 22 grid images downloaded at native resolution but displayed at 173×173 or 173×260 CSS px on this mobile viewport, e.g.:
- `Transcendence.jpg` — 46,337 bytes actual (670×1005 natural) vs 173×260 displayed → **43,248 bytes wasted**
- `CLEANSING-VOLUMIZING-RASSOUL.jpg` — 33,320 bytes (750×750) → **31,547 wasted**
- `rose-gold-retro.jpg` — 29,661 bytes (670×1005) → **27,683 wasted**
- (19 more entries, same pattern; sum of `wastedBytes` across all listed items = **416,254 bytes**, matching the ~406 KiB `displayValue`.)

**Why it hurts the user:** these 22 requests share the same connection/bandwidth budget as the LCP image immediately after the catalog fetch resolves — shipping ~400KB of pixels nobody sees slows that whole burst down on real mobile networks (this Lighthouse run already throttles to ~1.6 Mbps), compounding Finding 2's LCP delay, and is pure wasted data cost for the shopper.

**Fix:** request Shopify CDN images at the size actually needed. Shopify's CDN accepts on-the-fly resizing via a `width` query param (e.g. `...jpg?v=...&width=350` for a ~2x-retina 173px display box) — append it in `thumb()`/wherever `imageUrl` is built, or build a `srcset` with 173w/346w variants and let the browser pick.

**What good looks like:** grid thumbnails downloaded at ≤2x their CSS display size; `image-delivery-insight` savings ≈ 0.

---

## 4. `app.js` is render-blocking (Minor)

**Where:** `packages/widget/public/storefront/home.html:47` — `<script src="/storefront/app.js"></script>`, no `defer`/`async`.

**Evidence:** `render-blocking-insight` (score 0, `displayValue: "Est savings of 110 ms"`) lists `/storefront/app.js` (17,835 bytes transfer, 150ms wasted) among render-blocking requests, alongside `/storefront/app.css` (10,343 bytes, an ordinary blocking stylesheet in `<head>` which is expected and not itself a finding).

**Why it hurts the user:** small (110ms of FCP), but it's a free fix — the script is already the last thing in `<body>` and does no synchronous work other applicable code depends on before load.

**Fix:** add `defer` to the `<script src="/storefront/app.js">` tag at `home.html:47`.

**What good looks like:** no render-blocking script-tag findings; `render-blocking-insight` savings ≈ 0.

---

## 5. Favicon 404 (Polish)

**Where:** no `favicon.ico` in `packages/widget/public/storefront/`; no `<link rel="icon">` in `home.html`.

**Evidence:** EVIDENCE.md's console capture — `GET /favicon.ico 404` — and confirmed in `network-requests`: a 97-byte `Other`-type request to `/favicon.ico` on every page load.

**Why it hurts the user:** trivial by itself, but it's a needless failed request + console error on every load of a product meant to read as polished; "no rough edges" was the explicit bar.

**Fix:** add a real `favicon.ico` (or an SVG favicon + `<link rel="icon">`) under `packages/widget/public/storefront/`.

**What good looks like:** zero console errors on page load.

---

## What did NOT show up as a problem (checked, not fabricated)

- **Interaction lag / main-thread blocking:** TBT is **0ms** and `bootup-time`/`main-thread-tasks` both score 1 with negligible values (17.8ms total JS execution). No main-thread bottleneck exists in this lab run. No CrUX/field INP data is present in this report, so field-measured interaction latency is **not verified** either way — only the lab TBT=0 signal is confirmed.
- **Third-party cost:** there is no `third-party-summary` audit entry in this Lighthouse JSON at all (i.e., nothing crossed whatever byte/CPU threshold triggers it), consistent with TBT=0. Not verified beyond that — I did not independently trace every request's initiator.
- **Unused JS/CSS:** `unused-javascript` and `unused-css-rules` both score 1 with `numericValue: 0` — nothing flagged.
- **Font blocking/CLS:** `font-display-insight` scores 1 with empty items — no font-related shift or block found.

---

## Ranked summary

| # | Finding | Severity | Metric impact |
|---|---|---|---|
| 1 | Unreserved `#grid` height → footer shift | **Blocker** | CLS 0.345 (100% of the metric) |
| 2 | LCP image lazy-loaded + not discoverable until catalog fetch resolves | **Major** | LCP 2.2s (1038ms of it is resource-load-delay) |
| 3 | Grid images shipped at native res, displayed at 173px | **Major** | ~406 KiB wasted, compounds LCP |
| 4 | `app.js` missing `defer` | **Minor** | ~110ms FCP |
| 5 | Favicon 404 | **Polish** | console noise, 1 wasted request |
