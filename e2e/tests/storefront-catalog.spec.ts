import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "@playwright/test";

// Runs under playwright.storefront-catalog.config.ts, which maps the storefront shop -> the "demo" tenant
// so /storefront/catalog serves the static AURIA fixture catalog. This gives the coverage the default
// (tenant-less, EMPTY) storefront config cannot: a populated grid, a DIRECT-URL PDP that resolves a real
// product with no home->click stash (the GAP-3 fix, #359, end to end), and PDP-with-product a11y.
const WCAG22AA = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

test.describe("sample storefront — populated catalog (demo-tenant fixtures)", () => {
  test("home renders the live product grid and the shell brand", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#grid")).toHaveAttribute("data-ready", "1");
    const cards = page.locator("#grid a.card");
    await expect(cards.first()).toBeVisible();
    expect(await cards.count(), "the demo catalog has many products").toBeGreaterThan(3);
    await expect(page.locator("[data-brand]").first()).toHaveText("Auria"); // from getShell, not the placeholder
  });

  // Workstream B (SSR first page) — the server now injects the first catalog page as a
  // `<script id="palup-ssr">` hydration island on GET / (Tasks 1+2). These assert the CLIENT actually
  // consumes it (Task 3): no `{brand}` FOUC in the served HTML, no redundant page-1 network fetch, and
  // — the real acceptance bar — no meaningful layout shift on load.
  test("GET / server-renders the first page: #palup-ssr present, no {brand} FOUC", async ({ page }) => {
    const resp = await page.goto("/");
    const html = await resp!.text();
    expect(html).toContain('id="palup-ssr"');
    // Check the visible `{brand}` FOUC surface (the <title>), not the whole document — app.js's own
    // source (now inlined for the CLS fix, see storefront-ssr.ts) legitimately contains the literal
    // string `"{brand}"` as its OWN client-side fallback substitution for non-SSR pages; that text lives
    // inside a <script> tag and is never rendered, so it isn't a FOUC.
    const title = html.match(/<title>([^<]*)<\/title>/)?.[1] ?? "";
    expect(title).not.toContain("{brand}");
    expect(html).toMatch(/#grid|palup-ssr/);
  });

  test("home hydrates page 1 from #palup-ssr — no /storefront/catalog request for the first page", async ({
    page,
  }) => {
    const catalogRequests: string[] = [];
    page.on("request", (req) => {
      if (req.url().includes("/storefront/catalog")) catalogRequests.push(req.url());
    });
    await page.goto("/");
    await expect(page.locator("#grid")).toHaveAttribute("data-ready", "1");
    const cards = page.locator("#grid a.card");
    expect(await cards.count(), "the demo catalog has many products").toBeGreaterThan(3);
    expect(catalogRequests, "page 1 must render from the SSR island, not a client fetch").toHaveLength(0);
  });

  test("CLS is near zero on load (no async page-1 render shifting the layout)", async ({ page }) => {
    await page.goto("/", { waitUntil: "load" });
    const cls = await page.evaluate(
      () =>
        new Promise<number>((res) => {
          let v = 0;
          new PerformanceObserver((l) => {
            for (const e of l.getEntries() as any[]) if (!e.hadRecentInput) v += e.value;
          }).observe({ type: "layout-shift", buffered: true });
          setTimeout(() => res(v), 1500);
        }),
    );
    expect(cls).toBeLessThan(0.1);
  });

  test("a DIRECT-URL PDP resolves and renders a real product (GAP-3 end to end — no click-through stash)", async ({
    page,
  }) => {
    // Land straight on a product URL, the SEO / ad / typed-link path GAP-3 fixed (there is no stash here).
    await page.goto("/product/serum-vc");
    await expect(page.locator("#pdp")).toHaveAttribute("data-ready", "1");
    await expect(page.locator("#pdp h1")).toHaveText("Vitamin-C Brightening Serum");
    await expect(page.locator("#pdp .price")).toContainText("$34");
    await expect(page.getByTestId("add-to-cart")).toBeVisible();
  });

  test("a populated PDP is WCAG 2.2 AA clean", async ({ page }) => {
    await page.goto("/product/serum-vc");
    await expect(page.locator("#pdp")).toHaveAttribute("data-ready", "1");
    const results = await new AxeBuilder({ page }).withTags(WCAG22AA).analyze();
    expect(results.violations).toEqual([]);
  });
});

// The demo-tenant AURIA fixture (static-grounding.ts) carries no `imageUrl` on any product, so image
// behavior can't be exercised against the live route. These tests mock `/storefront/catalog` directly
// (page.route) with a synthetic product that DOES carry a `cdn.shopify.com` image, giving deterministic,
// real (non-vacuous) coverage of the `thumb()` onerror fallback and display-sized CDN request.
//
// Workstream B (SSR first page): GET / now server-renders page 1 into a `<script id="palup-ssr">`
// island, and the client hydrates from it instead of fetching `/storefront/catalog` for page 1 (Task
// 3) — so mocking that fetch alone no longer reaches the grid; the REAL (imageless) demo catalog from
// the SSR island would render instead, making these assertions vacuously true for the wrong reason.
// Strip the island from the served `/` document so the client falls through to the mocked fetch,
// exercising the exact `withImage` fixture below.
async function stripSsrIsland(page: import("@playwright/test").Page) {
  await page.route(
    (url) => url.pathname === "/",
    async (route) => {
      const response = await route.fetch();
      const html = await response.text();
      const stripped = html.replace(/<script id="palup-ssr"[^>]*>[\s\S]*?<\/script>/, "");
      await route.fulfill({ response, body: stripped });
    },
  );
}

test.describe("sample storefront — image robustness (mocked catalog)", () => {
  const withImage = {
    brandName: "Auria",
    policy: {},
    products: [
      {
        id: "gid://p1",
        title: "Mock Serum",
        price: "$20.00",
        imageUrl: "https://cdn.shopify.com/s/files/1/0000/0001/products/mock-serum.jpg",
        handle: "mock-serum",
      },
    ],
    nextCursor: null,
  };

  test("the product grid requests CDN images at display size (?width=)", async ({ page }) => {
    await stripSsrIsland(page);
    await page.route("**/storefront/catalog**", (route) => route.fulfill({ json: withImage }));
    await page.goto("/");
    await expect(page.locator("#grid")).toHaveAttribute("data-ready", "1");
    await expect(page.locator("#grid .card .thumb img").first()).toHaveAttribute("src", /[?&]width=\d+/);
  });

  test("a product image that fails to load falls back to the No-image placeholder", async ({ page }) => {
    await stripSsrIsland(page);
    await page.route("**/storefront/catalog**", (route) => route.fulfill({ json: withImage }));
    await page.route("**cdn.shopify.com/**", (route) => route.abort()); // force the thumb's <img> to fail
    await page.goto("/");
    await expect(page.locator("#grid")).toHaveAttribute("data-ready", "1");
    // the card that would have had an image now shows the placeholder, never a broken <img>
    await expect(page.locator("#grid .card .thumb .ph")).not.toHaveCount(0);
    await expect(page.locator("#grid .card .thumb img")).toHaveCount(0);
  });
});

test.describe("sample storefront — head hygiene", () => {
  test("no favicon 404, and app.js is deferred on pages that don't SSR", async ({ page }) => {
    const resp404: string[] = [];
    page.on("response", (r) => {
      if (r.url().includes("favicon") && r.status() === 404) resp404.push(r.url());
    });
    await page.goto("/");
    await page.locator("#grid .card").first().waitFor();
    expect(resp404).toHaveLength(0);
    await expect(page.locator('head link[rel="icon"]')).toHaveCount(1);
    // Workstream B: "/" SSRs successfully under this config, so its hydration script is inlined (CLS
    // fix — see storefront-ssr.ts `inlineStorefrontScript`) rather than an external deferred `<script
    // src>`. Assert that directly, and assert the external-deferred pattern is unchanged on a page that
    // doesn't SSR (product.html).
    await expect(page.locator('script[src="/storefront/app.js"]')).toHaveCount(0);
    await page.goto("/product/serum-vc");
    await expect(page.locator('script[src="/storefront/app.js"]')).toHaveAttribute("defer", "");
  });

  test("skip link has a themed focus ring", async ({ page }) => {
    await page.goto("/");
    await page.keyboard.press("Tab"); // focuses .skip
    const outline = await page.locator(".skip").evaluate((el) => getComputedStyle(el).outlineStyle);
    expect(outline).not.toBe("auto"); // was the browser default; now a solid themed ring
  });

  test("the hero 'Ask the expert' CTA is evergreen, matching the launcher", async ({ page }) => {
    await page.goto("/");
    const bg = await page.getByTestId("hero-ask").evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).toBe("rgb(12, 74, 60)"); // #0c4a3c
    // Browse-all stays the storefront accent (terracotta), not evergreen
    const browse = await page.locator(".hero-cta a.btn-outline").evaluate((el) => getComputedStyle(el).color);
    expect(browse).not.toBe("rgb(12, 74, 60)");
  });
});
