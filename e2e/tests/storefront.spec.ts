import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "@playwright/test";

/**
 * WS3/WS4 — the sample storefront now owns `/` (home / product / cart), embedding the widget via the REAL
 * loader (/embed/loader.js → closed-shadow launcher → /embed/panel iframe).
 *
 * SCOPE OF THIS FILE (deliberate): in the mock CI backend there are no Shopify creds, so /storefront/catalog
 * resolves no tenant and the storefront renders its honest EMPTY state. So this suite proves the things that
 * are DETERMINISTIC in CI: the pages render with correct page-level accessibility (full-page landmarks/heading
 * that the widget deliberately does NOT own), the real loader actually mounts, and the assistant framing is
 * truthful. The product/cart/cart-signal FLOW is exercised against the live catalog on staging (WS8) and its
 * wiring is unit-covered (storefront-routes.test.ts, loader-core.test.ts WS4). Same WCAG 2.2 AA tag set as
 * a11y.spec.ts (explicit tags, no best-practice noise). */
const WCAG22AA = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

test.describe("sample storefront", () => {
  test("home renders page-level structure and is WCAG 2.2 AA clean", async ({ page }) => {
    await page.goto("/");
    // one main, one h1, a real nav + cart link
    await expect(page.locator("main")).toHaveCount(1);
    await expect(page.locator("h1")).toHaveCount(1);
    await expect(page.locator('nav[aria-label="Primary"]')).toBeVisible();
    await expect(page.locator('a.cart-link')).toBeVisible();
    // the async catalog render settled (empty state in CI)
    await expect(page.locator("#grid")).toHaveAttribute("data-ready", "1");
    const results = await new AxeBuilder({ page }).withTags(WCAG22AA).analyze();
    expect(results.violations).toEqual([]);
  });

  test("the real PalUp loader is embedded (script + mounted host)", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator('script[src="/embed/loader.js"]')).toHaveCount(1);
    // the loader ran and mounted its host element (the launcher lives in a CLOSED shadow root within it)
    await expect(page.locator('[data-palup-mounted="true"]')).toHaveCount(1);
  });

  test("cart page renders its empty state and is WCAG 2.2 AA clean", async ({ page }) => {
    await page.goto("/cart");
    await expect(page.locator("h1")).toHaveText("Your cart");
    await expect(page.locator("#cart")).toHaveAttribute("data-ready", "empty");
    const results = await new AxeBuilder({ page }).withTags(WCAG22AA).analyze();
    expect(results.violations).toEqual([]);
  });

  test("assistant framing stays truthful (AI-generated, grounded — never 'a human')", async ({ page }) => {
    await page.goto("/");
    const note = page.locator(".assistant-note");
    await expect(note).toContainText(/AI/i);
    await expect(note).not.toContainText(/human/i);
  });
});
