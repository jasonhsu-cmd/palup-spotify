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
