# Storefront Polish (Workstream A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the "looks unfinished" rough edges on the sample storefront + assistant card — currency format, footer truncation, image robustness, favicon, script defer, focus/CSS polish, the CTA color mismatch, and the panel price-hedge styling.

**Architecture:** Almost all changes are single-source and localized: money + policy formatting live in one backend function each (`shopify-grounding.ts`), image handling in one storefront helper (`app.js thumb()`), and the rest are CSS/HTML in the storefront + one presentation rule in the panel HTML. No behavior/data changes — presentation + formatting only.

**Tech Stack:** TypeScript (Fastify backend), vanilla JS/CSS/HTML (storefront + panel), Vitest (unit), Playwright (E2E). Test with `env -u GOOGLE_CLOUD_PROJECT` (never set `GOOGLE_CLOUD_PROJECT` — it routes tests to real Vertex).

**Spec:** `docs/superpowers/specs/2026-08-21-ux-review-remediation-program-design.md` (Workstream A).

## Global Constraints
- **No §3 surface.** Presentation/formatting only. Do not change what price the assistant *asserts* (the "current price needs confirming" hedge TEXT and mechanism are unchanged — A7 only restyles it), and do not touch the consent flow.
- **All merchant text renders via `textContent`, never `innerHTML`** (existing XSS control — preserve it).
- **CTA evergreen hex is exactly `#0c4a3c`** with white ink `#ffffff` (matches `loader-core.ts:91`). Leave `--accent:#a6482f` (terracotta) for every other storefront control.
- **Money format:** two-decimal currency for USD; non-USD keeps `amount currencyCode`. Never raw string concat.
- Full merge gate must pass; this PR auto-merges on green (non-§3). Run all four CI gate commands, not three (`pnpm e2e` is the widget suite only).

---

### Task 1: Currency formatting at the single source (`formatPrice`)

**Files:**
- Modify: `packages/widget-backend/src/shopify-grounding.ts:107-110`
- Test: `packages/widget-backend/test/shopify-grounding-format.test.ts` (create)

**Interfaces:**
- Produces: `formatPrice({amount, currencyCode})` returns `"$35.00"` for USD, `"35.00 EUR"` for non-USD, `""` for missing amount. Consumed unchanged by `projectStorefrontProduct` (`storefront-catalog.ts:83`) and the grounding product mapping (same file), so the fix flows to storefront grid + PDP + cart + the assistant card in one place.

- [ ] **Step 1: Write the failing test**
```ts
import { describe, it, expect } from "vitest";
import { formatPriceForTest as formatPrice } from "../src/shopify-grounding.js";

describe("formatPrice", () => {
  it("formats USD to two decimals", () => {
    expect(formatPrice({ amount: "35.0", currencyCode: "USD" })).toBe("$35.00");
    expect(formatPrice({ amount: "35", currencyCode: "USD" })).toBe("$35.00");
    expect(formatPrice({ amount: "1234.5" })).toBe("$1,234.50");
  });
  it("keeps non-USD as amount + code, two decimals", () => {
    expect(formatPrice({ amount: "35.0", currencyCode: "EUR" })).toBe("35.00 EUR");
  });
  it("returns empty string for missing amount", () => {
    expect(formatPrice({})).toBe("");
    expect(formatPrice(undefined)).toBe("");
  });
});
```

- [ ] **Step 2: Run it, verify it fails** — `env -u GOOGLE_CLOUD_PROJECT PGVECTOR_TESTCONTAINER=off pnpm exec vitest run packages/widget-backend/test/shopify-grounding-format.test.ts` → FAIL (`formatPriceForTest` not exported / `$35.0`).

- [ ] **Step 3: Implement.** Replace `shopify-grounding.ts:107-110` with:
```ts
export function formatPrice(p?: { amount?: string; currencyCode?: string }): string {
  if (!p?.amount) return "";
  const n = Number(p.amount);
  if (!Number.isFinite(n)) return ""; // never surface a raw/garbage amount
  const code = p.currencyCode && p.currencyCode !== "USD" ? p.currencyCode : "USD";
  const num = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
  return code === "USD" ? `$${num}` : `${num} ${code}`;
}
export { formatPrice as formatPriceForTest };
```
(It was already a module-local `function formatPrice`; add `export` + the aliased test export. Keep the single call sites unchanged.)

- [ ] **Step 4: Run it, verify it passes.**

- [ ] **Step 5: Commit** — `git add -A && git commit -m "fix(storefront): format prices as two-decimal currency (\$35.0 → \$35.00)"`

---

### Task 2: Word-boundary policy truncation (no mid-word cut)

**Files:**
- Modify: `packages/widget-backend/src/shopify-grounding.ts` (the policy `bound(...)` call sites — search for `refundPolicy`/`shippingPolicy` body bounding; and the `MAX_DESC = 600` / `bound` helper at `:66,70`)
- Test: `packages/widget-backend/test/shopify-grounding-policy.test.ts` (create)

**Interfaces:**
- Produces: policy `returns`/`shipping` strings are truncated on a word boundary with a trailing `…` when they exceed the cap, at a policy-specific cap `MAX_POLICY = 2000` (not the 600 prompt cap). Downstream `toPlainText` (`storefront-catalog.ts:46`) still strips tags for the footer.

- [ ] **Step 1: Write the failing test**
```ts
import { describe, it, expect } from "vitest";
import { boundWords } from "../src/shopify-grounding.js";

describe("boundWords", () => {
  it("returns the string unchanged when under the cap", () => {
    expect(boundWords("short policy", 100)).toBe("short policy");
  });
  it("truncates on a word boundary with an ellipsis, never mid-word", () => {
    const out = boundWords("free shipping over fifty dollars treat yourself basically", 30);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toMatch(/basical…$/); // no mid-word cut
    expect(out.length).toBeLessThanOrEqual(31);
    expect(out.slice(0, -1).trim().split(" ").pop()).not.toBe("basical");
  });
});
```

- [ ] **Step 2: Run it, verify it fails** (`boundWords` not exported).

- [ ] **Step 3: Implement.** Add next to `bound` (`shopify-grounding.ts:70`):
```ts
const MAX_POLICY = 2000; // policy bodies deserve a larger budget than the 600-char prompt cap
export const boundWords = (s: string | undefined, max: number): string => {
  const str = s ?? "";
  if (str.length <= max) return str;
  const cut = str.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd() + "…";
};
```
Then change the policy body bounding (the `bound(data.shop?.refundPolicy?.body, MAX_DESC)` and `shippingPolicy` calls) to `boundWords(data.shop?.refundPolicy?.body, MAX_POLICY)` / `boundWords(data.shop?.shippingPolicy?.body, MAX_POLICY)`. Leave `bound` + `MAX_DESC` for title/description (prompt-bound) unchanged.

- [ ] **Step 4: Run it, verify it passes.**

- [ ] **Step 5: Commit** — `git commit -am "fix(storefront): truncate policy text on a word boundary with ellipsis"`

---

### Task 3: Image robustness in the storefront grid (`thumb`)

**Files:**
- Modify: `packages/widget/public/storefront/app.js:131-143` (`thumb`)
- Test: `e2e/tests/storefront.spec.ts` (add cases)

**Interfaces:**
- Consumes: `thumb(imageUrl, alt, cls)` — unchanged signature. Produces: on image `error`, the `<img>` is replaced by the existing `.ph` "No image" placeholder; the CDN URL is requested at display size via `?width=`.

- [ ] **Step 1: Write the failing E2E** in `storefront.spec.ts` (route a product's image to a 404 and assert the placeholder shows; assert the `src` carries a width param):
```ts
test("a product image that fails to load falls back to the No-image placeholder", async ({ page }) => {
  await page.route("**/cdn.shopify.com/**", (r) => r.abort()); // force every thumb to fail
  await page.goto("/");
  await page.getByTestId("load-more").or(page.locator("#grid .card").first()).first().waitFor();
  // every card that would have had an image now shows the placeholder, none shows a broken <img>
  await expect(page.locator("#grid .card .thumb .ph")).not.toHaveCount(0);
  await expect(page.locator("#grid .card .thumb img")).toHaveCount(0);
});
```
(Also add, in an existing "grid renders" test, `await expect(page.locator('#grid .card .thumb img').first()).toHaveAttribute('src', /[?&]width=\d+/);`)

- [ ] **Step 2: Run it, verify it fails** — `env -u GOOGLE_CLOUD_PROJECT pnpm e2e:storefront-catalog` (the storefront E2E config) → FAIL (broken imgs remain; no width param).

- [ ] **Step 3: Implement** `thumb` (`app.js:131-143`):
```js
function thumb(imageUrl, alt, cls) {
  var box = el("div", cls || "thumb");
  if (typeof imageUrl === "string" && imageUrl) {
    var img = document.createElement("img");
    // request the CDN image at ~2x the ~175px display box; Shopify CDN honours ?width=
    img.src = imageUrl.indexOf("cdn.shopify.com") >= 0 && imageUrl.indexOf("width=") < 0
      ? imageUrl + (imageUrl.indexOf("?") >= 0 ? "&" : "?") + "width=350"
      : imageUrl;
    img.alt = alt || "";
    img.loading = "lazy";
    img.decoding = "async";
    img.addEventListener("error", function () {
      if (img.parentNode === box) { box.removeChild(img); box.appendChild(el("span", "ph", "No image")); }
    });
    box.appendChild(img);
  } else {
    box.appendChild(el("span", "ph", "No image"));
  }
  return box;
}
```

- [ ] **Step 4: Run it, verify it passes.**

- [ ] **Step 5: Commit** — `git commit -am "fix(storefront): onerror image fallback + display-sized CDN thumbnails"`

---

### Task 4: Favicon + non-blocking script + head hygiene

**Files:**
- Create: `packages/widget/public/storefront/favicon.svg`
- Modify: `packages/widget/public/storefront/{home,product,cart}.html` (`<link rel="icon">`, `defer`)
- Modify: `packages/widget-backend/src/server.ts` (serve `/storefront/favicon.svg` next to the existing `/storefront/app.css` / `app.js` routes, ~`:1766-1772`)
- Test: `e2e/tests/storefront.spec.ts`

- [ ] **Step 1: Write the failing E2E:**
```ts
test("no favicon 404 and app.js is deferred", async ({ page }) => {
  const failed: string[] = [];
  page.on("requestfailed", (r) => failed.push(r.url()));
  const resp404: number[] = [];
  page.on("response", (r) => { if (r.url().includes("favicon") && r.status() === 404) resp404.push(r.status()); });
  await page.goto("/");
  await page.locator("#grid .card").first().waitFor();
  expect(resp404).toHaveLength(0);
  await expect(page.locator('head link[rel="icon"]')).toHavecount?.(1) ?? await expect(page.locator('head link[rel="icon"]')).toHaveCount(1);
  await expect(page.locator('script[src="/storefront/app.js"]')).toHaveAttribute("defer", "");
});
```
(Fix the `toHaveCount` typo when writing — assert exactly one `link[rel=icon]`.)

- [ ] **Step 2: Run it, verify it fails.**

- [ ] **Step 3: Implement.**
  - `favicon.svg`: a minimal evergreen mark, e.g. `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#0c4a3c"/><text x="16" y="22" font-family="system-ui" font-size="18" fill="#fff" text-anchor="middle">P</text></svg>`.
  - In each storefront HTML `<head>`: `<link rel="icon" href="/storefront/favicon.svg" type="image/svg+xml" />`.
  - `home.html:47`: `<script src="/storefront/app.js" defer></script>` (add `defer`; do the same in product.html/cart.html if they load app.js).
  - `server.ts`: add a route `app.get("/storefront/favicon.svg", …)` mirroring the existing `/storefront/app.css` handler (read the file, `content-type: image/svg+xml`).

- [ ] **Step 4: Run it, verify it passes.**

- [ ] **Step 5: Commit** — `git commit -am "fix(storefront): add favicon + defer app.js"`

---

### Task 5: CSS polish — skip-link focus + footer measure

**Files:**
- Modify: `packages/widget/public/storefront/app.css` (the `.skip` block ~`:66`; the `.site-footer .inner` block ~`:148`)

- [ ] **Step 1: Write the failing E2E** in `storefront.spec.ts`:
```ts
test("skip link has a themed focus ring", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("Tab"); // focuses .skip
  const outline = await page.locator(".skip").evaluate((el) => getComputedStyle(el).outlineStyle);
  expect(outline).not.toBe("auto"); // was the browser default; now a solid themed ring
});
```

- [ ] **Step 2: Run it, verify it fails.**

- [ ] **Step 3: Implement** — add to `app.css`:
```css
.skip:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; border-radius: 6px; }
.site-footer .inner p { max-width: 70ch; }
```

- [ ] **Step 4: Run it, verify it passes.**

- [ ] **Step 5: Commit** — `git commit -am "style(storefront): themed skip-link focus + footer line-length cap"`

---

### Task 6: Reconcile the "Ask the expert" CTA color (evergreen)

**Files:**
- Modify: `packages/widget/public/storefront/app.css` (add a scoped rule)
- Test: `e2e/tests/storefront.spec.ts`

**Interfaces:** The hero button `[data-testid="hero-ask"]` (`home.html:28`) renders evergreen `#0c4a3c`, matching the floating launcher (`loader-core.ts:91`). Everything else keeps `--accent` terracotta.

- [ ] **Step 1: Write the failing E2E:**
```ts
test("the hero 'Ask the expert' CTA is evergreen, matching the launcher", async ({ page }) => {
  await page.goto("/");
  const bg = await page.getByTestId("hero-ask").evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg).toBe("rgb(12, 74, 60)"); // #0c4a3c
  // Browse-all stays the storefront accent (terracotta), not evergreen
  const browse = await page.locator('.hero-cta a.btn-outline').evaluate((el) => getComputedStyle(el).color);
  expect(browse).not.toBe("rgb(12, 74, 60)");
});
```

- [ ] **Step 2: Run it, verify it fails** (currently terracotta `rgb(166, 72, 47)`).

- [ ] **Step 3: Implement** — add to `app.css`:
```css
/* The "Ask the expert" affordance is PalUp's, not the merchant's terracotta accent — match the launcher. */
.btn[data-testid="hero-ask"] { background: #0c4a3c; border-color: #0c4a3c; color: #ffffff; }
.btn[data-testid="hero-ask"]:hover { background: #0a3d32; border-color: #0a3d32; }
```

- [ ] **Step 4: Run it, verify it passes.**

- [ ] **Step 5: Commit** — `git commit -am "fix(storefront): recolor hero 'Ask the expert' to match the launcher (evergreen)"`

---

### Task 7: Panel price-hedge styling (presentation only)

**Files:**
- Modify: `packages/widget/public/index.html` (the `.rec-p` style ~`:204`, the `.rec` style ~`:196`, and the card render where `c.price` is written — search `rec-p`)
- Test: `e2e/tests/widget.spec.ts` (E3 product-cards section)

**Interfaces:** When a card's price equals the hedge sentinel (`priceConfirmed === false`, or the price text is the "needs confirming" sentinel), the price line renders muted + italic (`.rec-p--unconfirmed`) so it's visually distinct from a real price. Thumbnail centers vertically against the text block.

- [ ] **Step 1: Write the failing E2E** in `widget.spec.ts` (the E3 mocked `/chat` seam already exists — add a card with `priceConfirmed:false`):
```ts
test("an unconfirmed price is styled distinctly from a real price", async ({ page }) => {
  await chatWith(page, {
    recommendedProducts: ["x"],
    recommendedProductCards: [{ productId: "x", title: "Serum", price: "current price needs confirming", priceConfirmed: false }],
  });
  await send(page);
  const p = page.getByTestId("product-card").first().locator(".rec-p");
  await expect(p).toHaveClass(/rec-p--unconfirmed/);
  await expect(p).toHaveCSS("font-style", "italic");
});
```

- [ ] **Step 2: Run it, verify it fails.**

- [ ] **Step 3: Implement.**
  - CSS: add `.rec-p--unconfirmed{ color:var(--muted); font-style:italic; }` near `.rec-p` (`index.html:204`); change `.rec{ align-items:flex-start … }` (`:196`) to `align-items:center`.
  - JS (the card render, `addProductCards`): when building the price span, if `c.priceConfirmed === false` add the class: `p.className = "rec-p" + (c.priceConfirmed === false ? " rec-p--unconfirmed" : "");`

- [ ] **Step 4: Run it, verify it passes.**

- [ ] **Step 5: Commit** — `git commit -am "style(widget): distinguish unconfirmed price from a real price on cards"`

---

## Final: run the full gate + open the PR
- [ ] Run the four CI gate steps locally (typecheck, unit, `pnpm e2e`, `pnpm e2e:storefront-catalog`, `pnpm e2e:embed`) via `env -u GOOGLE_CLOUD_PROJECT`; ensure green.
- [ ] Open PR, run `.claude/scripts/merge-gate.sh`; auto-merge on green (non-§3, non-governance).

## Self-review notes (author)
- Spec coverage: A1 (T1), A2 (T2), A3+A4 (T3), A5+A6 (T4), A7 (T5), A8 (T6), A9 (T7). All Workstream-A items covered.
- The `formatPrice` export rename: verify the two existing call sites in `shopify-grounding.ts` still compile (they call `formatPrice(...)` locally — adding `export` doesn't break them).
- `boundWords` only replaces the POLICY bound calls, not the title/description ones (those stay prompt-bounded at `MAX_DESC`).
