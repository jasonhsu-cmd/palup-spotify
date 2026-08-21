# SSR First Page (Workstream B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Kill CLS 0.345, the 1038 ms LCP resource-load-delay, and the `{brand}` title FOUC in one change — by server-rendering the storefront's first page (products + brand + policy) into the initial HTML so `#grid` and the footer are at final height on first paint.

**Architecture:** Reuse the existing marker-injection pattern (the panel already injects theme FOUC-free at `<!--PALUP_THEME-->`). Add a marker to `home.html`; a pure injector fills it with the first-page catalog JSON + resolved brand + resolved policy at serve time. `app.js` renders page 1 synchronously from that injected data (no page-1 fetch), and keeps its existing cursor-based "Load more" for later pages. If SSR data is absent (fetch failed), `app.js` falls back to its current client-fetch path unchanged.

**Tech Stack:** TypeScript (Fastify), vanilla JS/HTML, Vitest, Playwright. `env -u GOOGLE_CLOUD_PROJECT` for tests.

**Spec:** `docs/superpowers/specs/2026-08-21-ux-review-remediation-program-design.md` (Workstream B).

## Global Constraints
- **No §3 surface.** Render-path/performance only; the data shown is exactly what `/storefront/catalog` already returns (`projectStorefrontCatalog`).
- **Reuse `projectStorefrontCatalog` / `getCatalogPage` deps** — do NOT add a second catalog-fetch path; the `/` route uses the same `StorefrontCatalogDeps.getCatalogPage`, `resolveTenant`, `shopDomainFor` already wired for `/storefront/catalog`.
- **Injected JSON goes into a `<script type="application/json">` and is read by `JSON.parse`, never `innerHTML`.** Escape `<` in the JSON as `<` (the same guard `themeStyleBlock` uses) so a merchant string containing `</script>` can't break out.
- **Graceful degradation:** if the SSR fetch fails, serve the current static HTML unchanged (client fetch still works). SSR is an enhancement, not a hard dependency.
- **Default tenant:** `/` has no `?shop`; resolve the default storefront tenant (the single configured `SHOPIFY_STORES` shop / the same domain `app.js` defaults `SHOP` to: `palup-skincare-jason.myshopify.com`).

---

### Task 1: Pure SSR injector

**Files:**
- Create: `packages/widget-backend/src/storefront-ssr.ts`
- Test: `packages/widget-backend/test/storefront-ssr.test.ts`
- Modify: `packages/widget/public/storefront/home.html` (add markers)

**Interfaces:**
- Produces: `injectStorefrontFirstPage(html: string, data: { brandName: string; policy: StorePolicy; products: StorefrontProductWire[]; nextCursor?: string }): string` — replaces `{brand}` in `<title>`, the `<span data-brand>Auria</span>` placeholders, the two footer policy `<p>`s, and injects `<script id="palup-ssr" type="application/json">…</script>` at a `<!--PALUP_SSR-->` marker. `<` escaped as `<` inside the JSON.

- [ ] **Step 1** — In `home.html`: add `<!--PALUP_SSR-->` just before `<script src="/storefront/app.js" …>` (line ~47). (Keep the existing `{brand}` title + `data-brand` spans + footer `<p data-policy-*>` — the injector fills them.)

- [ ] **Step 2: Write the failing test**
```ts
import { describe, it, expect } from "vitest";
import { injectStorefrontFirstPage } from "../src/storefront-ssr.js";
const HTML = `<title>{brand} — x</title><span data-brand>Auria</span><p data-policy-shipping>old</p><p data-policy-returns>old</p><!--PALUP_SSR-->`;
describe("injectStorefrontFirstPage", () => {
  it("fills brand, policy, and an escaped JSON script", () => {
    const out = injectStorefrontFirstPage(HTML, {
      brandName: "Acme", policy: { shipping: "free ship", returns: "30 days" },
      products: [{ id: "p1", title: "T</script>", price: "$1.00", description: "" }], nextCursor: "c2",
    });
    expect(out).toContain("<title>Acme — x</title>");
    expect(out).toContain(">Acme<");
    expect(out).toContain("free ship");
    expect(out).toContain('id="palup-ssr"');
    expect(out).not.toContain("Auria");
    expect(out).not.toContain("{brand}");
    expect(out).not.toContain("</script>T"); // the product title's </script> is escaped, doesn't break out
    expect(out).toContain("\\u003c"); // < escaped
  });
});
```

- [ ] **Step 3: Run it, verify it fails.**

- [ ] **Step 4: Implement** `storefront-ssr.ts`:
```ts
import type { StorePolicy } from "@palup/platform-ports";
import type { StorefrontProductWire } from "./routes/storefront-catalog.js";
export interface StorefrontFirstPage { brandName: string; policy: StorePolicy; products: StorefrontProductWire[]; nextCursor?: string; }
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
export function injectStorefrontFirstPage(html: string, data: StorefrontFirstPage): string {
  const brand = data.brandName || "this store";
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  return html
    .replace(/\{brand\}/g, esc(brand))
    .replace(/<span data-brand>[^<]*<\/span>/g, `<span data-brand>${esc(brand)}</span>`)
    .replace(/<p data-policy-shipping>[^<]*<\/p>/, `<p data-policy-shipping>${esc(data.policy.shipping || "")}</p>`)
    .replace(/<p data-policy-returns>[^<]*<\/p>/, `<p data-policy-returns>${esc(data.policy.returns || "")}</p>`)
    .replace("<!--PALUP_SSR-->", `<script id="palup-ssr" type="application/json">${json}</script>`);
}
```

- [ ] **Step 5: Run it, verify it passes. Commit** — `git commit -am "feat(storefront): pure SSR first-page injector"`

---

### Task 2: Wire the `/` route to SSR

**Files:**
- Modify: `packages/widget-backend/src/server.ts:1757-1759` (the `/` route) — it needs the storefront-catalog deps already built for `registerStorefrontCatalogRoutes`. Hoist those deps (or the default tenantId + `getCatalogPage`/`shopDomainFor`) so `/` can call them.
- Test: `packages/widget-backend/test/storefront-home-ssr.test.ts` (route-level, `app.inject`)

**Interfaces:**
- Consumes: `injectStorefrontFirstPage` (Task 1); the existing `StorefrontCatalogDeps.getCatalogPage(tenantId, STOREFRONT_PAGE_LIMIT)`, `resolveTenant`, `shopDomainFor`; `projectStorefrontCatalog` (`storefront-catalog.ts`).
- Produces: `GET /` returns HTML with a `#palup-ssr` JSON script + real brand in `<title>` when the default tenant resolves; falls back to the raw `storefrontHome` string on any failure.

- [ ] **Step 1: Write the failing test** (`app.inject GET /` → body contains `id="palup-ssr"` and the resolved brand; a fetch failure → body === raw home, still 200).
```ts
it("SSRs the first page into GET /", async () => {
  const app = await server(/* deps with a getCatalogPage returning 2 products + brand "Acme" */);
  const res = await app.inject({ method: "GET", url: "/" });
  expect(res.statusCode).toBe(200);
  expect(res.body).toContain('id="palup-ssr"');
  expect(res.body).toContain("<title>Acme");
  expect(res.body).not.toContain("{brand}");
});
it("falls back to the static shell if the first-page fetch fails", async () => {
  const app = await server(/* getCatalogPage throws */);
  const res = await app.inject({ method: "GET", url: "/" });
  expect(res.statusCode).toBe(200);
  expect(res.body).toContain("<!doctype html>");
});
```

- [ ] **Step 2: Run it, verify it fails.**

- [ ] **Step 3: Implement** the `/` handler:
```ts
app.get("/", async (_req, reply) => {
  try {
    const resolved = await storefrontDeps.resolveTenant(DEFAULT_STOREFRONT_SHOP);
    if (resolved.ok && resolved.tenantId) {
      const page = await storefrontDeps.getCatalogPage(resolved.tenantId, STOREFRONT_PAGE_LIMIT);
      const shopDomain = await storefrontDeps.shopDomainFor(resolved.tenantId).catch(() => undefined);
      const wire = projectStorefrontCatalog(page.context, shopDomain, page.nextCursor);
      return reply.type("text/html").send(injectStorefrontFirstPage(storefrontHome, wire));
    }
  } catch { /* fall through to the static shell */ }
  reply.type("text/html").send(storefrontHome);
});
```
`DEFAULT_STOREFRONT_SHOP` = the single configured storefront domain (derive from `SHOPIFY_STORES` keys / the same value `app.js` defaults `SHOP` to). Ensure `storefrontDeps` (the object passed to `registerStorefrontCatalogRoutes`) is in scope here — hoist its construction above both registrations if needed.

- [ ] **Step 4: Run it, verify it passes. Commit** — `git commit -am "feat(storefront): server-render the first page into GET /"`

---

### Task 3: `app.js` consumes the SSR data (+ eager first image)

**Files:**
- Modify: `packages/widget/public/storefront/app.js` (`renderHome` `:177-223`; `thumb` `:131` for the first-image priority)
- Test: covered by the E2E in Task 4.

**Interfaces:** `renderHome` reads `#palup-ssr` JSON if present and renders page 1 from it synchronously (setting brand/policy from it too), skipping the page-1 fetch; the "Load more" cursor comes from the SSR `nextCursor`. Absent ⇒ current fetch path unchanged.

- [ ] **Step 1** — In `renderHome`, before the `fetchPage(null)` call, add:
```js
var ssrEl = document.getElementById("palup-ssr");
var ssr = null;
try { ssr = ssrEl ? JSON.parse(ssrEl.textContent) : null; } catch (e) { ssr = null; }
if (ssr && Array.isArray(ssr.products) && ssr.products.length) {
  setBrand(ssr.brandName); setPolicy(ssr.policy);
  var wrap = document.getElementById("grid-more");
  if (wrap) { moreBtn = el("button", "btn btn-outline", "Load more"); moreBtn.type = "button";
    moreBtn.setAttribute("data-testid", "load-more"); moreBtn.hidden = true;
    moreBtn.addEventListener("click", loadMore); wrap.appendChild(moreBtn); }
  appendPage(ssr); // sets cursor from ssr.nextCursor, ready flags, More visibility
  return; // page 1 already on screen from HTML — no fetch, no shift
}
fetchPage(null).then(function (data) { /* existing fallback path, unchanged */ });
```
(`appendPage` already reads `data.products` + `data.nextCursor` — reuse it as-is.)

- [ ] **Step 2** — In `thumb`, make the FIRST image eager: add an optional 4th arg `eager` → when true set `img.loading = "eager"; img.fetchPriority = "high";` instead of lazy. In `productCard`, pass `eager=true` only for the first card of the first page (thread an index; or set it in `appendPage` for `grid.children.length === 0`). Simplest: in `productCard(p, eager)`, and in `appendPage` call `productCard(p, idx === 0 && grid.children.length === 0)`.

- [ ] **Step 3: Commit** — `git commit -am "feat(storefront): render SSR first page client-side + eager LCP image"`

---

### Task 4: E2E — CLS gone, LCP discoverable, no FOUC

**Files:** `e2e/tests/storefront.spec.ts`

- [ ] **Step 1: Write the tests**
```ts
test("first page is server-rendered: grid has cards in the initial HTML, no {brand}", async ({ page }) => {
  const resp = await page.goto("/");
  const html = await resp!.text();
  expect(html).toContain('id="palup-ssr"');
  expect(html).not.toContain("{brand}");
  expect(html).toMatch(/#grid|palup-ssr/); // first-page data present in the document
});
test("CLS is near zero on load", async ({ page }) => {
  await page.goto("/", { waitUntil: "load" });
  const cls = await page.evaluate(() => new Promise<number>((res) => {
    let v = 0; new PerformanceObserver((l) => { for (const e of l.getEntries() as any[]) if (!e.hadRecentInput) v += e.value; }).observe({ type: "layout-shift", buffered: true });
    setTimeout(() => res(v), 1500);
  }));
  expect(cls).toBeLessThan(0.1);
});
```

- [ ] **Step 2: Run `pnpm e2e:storefront-catalog` (+ `pnpm e2e`), verify green.**

- [ ] **Step 3: Commit** — `git commit -am "test(storefront): SSR first-page + CLS<0.1 e2e"`

---

## Final: gate + PR
- [ ] Full gate (typecheck, unit, `pnpm e2e`, `e2e:storefront-catalog`, `e2e:embed`) green; open PR; `merge-gate.sh`; auto-merge on green.

## Self-review notes
- Coverage: CLS (T1–T4), LCP eager image (T3), `{brand}`/`Auria` FOUC (T1 injector + T2 route + T4 assertion). Skeleton fallback from the spec is the *degradation* path (Task 2 fall-through) — full SSR is the chosen approach.
- Interface consistency: `injectStorefrontFirstPage` input shape === `StorefrontCatalogWire` (`storefront-catalog.ts:60`) — reuse that type, don't redeclare fields.
- Confirm `storefrontDeps` construction can be hoisted above the `/` route without reordering a dependency it needs (check where `registerStorefrontCatalogRoutes` is called relative to `:1757`).
