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

/**
 * The cart page renders entirely from localStorage (app.js readCart → renderCart) — it does NOT need the
 * catalog API — so the POPULATED cart flow (rows, qty +/-, remove, badge sync, checkout permalink) is fully
 * deterministic in the mock CI backend and belongs here, not only on staging. This closes the audit gaps
 * "cart-line-items-render-and-mutate" and "checkout-permalink-handoff": before this, only the EMPTY cart was
 * covered, so a regression in the money-adjacent checkout link or the qty/remove math would ship green.
 * Cart key mirrors app.js: `palup.storefront.cart.v1.<shop>` with the storefront's default shop. */
const CART_KEY = "palup.storefront.cart.v1.palup-skincare-jason.myshopify.com";
async function seedCart(page: import("@playwright/test").Page, items: unknown[]): Promise<void> {
  // addInitScript runs before app.js on every navigation, so the boot-time readCart() sees the seed.
  await page.addInitScript(
    ({ key, items }) => window.localStorage.setItem(key, JSON.stringify(items)),
    { key: CART_KEY, items },
  );
}

test.describe("sample storefront — populated cart (localStorage-driven, deterministic in mock)", () => {
  const LINES = [
    { productId: "gid://p1", variantId: "111", handle: "alpha", title: "Alpha Serum", price: "$20.0", imageUrl: "https://cdn.shopify.com/s/files/1/x.jpg", quantity: 2 },
    { productId: "gid://p2", variantId: "222", handle: "beta", title: "Beta Cream", price: "$35.0", quantity: 1 }, // no imageUrl → placeholder, no <img>
  ];

  test("renders seeded lines (titles, prices, thumb only when imageUrl present) and a synced badge", async ({ page }) => {
    await seedCart(page, LINES);
    await page.goto("/cart");
    await expect(page.locator("#cart")).toHaveAttribute("data-ready", "1");
    const rows = page.locator('[data-testid="cart-list"] > li');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText("Alpha Serum");
    await expect(rows.nth(0)).toContainText("$20.0");
    await expect(rows.nth(0).locator("img")).toHaveAttribute("src", "https://cdn.shopify.com/s/files/1/x.jpg");
    await expect(rows.nth(1).locator("img")).toHaveCount(0); // no imageUrl → "No image" placeholder, never a broken <img>
    await expect(page.locator("[data-cart-count]").first()).toHaveText("3"); // 2 + 1
  });

  test("qty +/- and remove mutate the cart, splice a line at zero, and sync the badge", async ({ page }) => {
    await seedCart(page, LINES);
    await page.goto("/cart");
    const rows = page.locator('[data-testid="cart-list"] > li');
    const alpha = rows.filter({ hasText: "Alpha Serum" });
    await alpha.getByRole("button", { name: "Increase quantity of Alpha Serum" }).click();
    await expect(alpha.locator(".qty > span")).toHaveText("3");
    await expect(page.locator("[data-cart-count]").first()).toHaveText("4"); // 3 + 1

    // decrement Beta 1 → 0 → the line splices out
    await rows.filter({ hasText: "Beta Cream" }).getByRole("button", { name: "Decrease quantity of Beta Cream" }).click();
    await expect(rows).toHaveCount(1);

    // remove the last line → the honest empty state returns and the badge hides
    await page.getByRole("button", { name: "Remove Alpha Serum" }).click();
    await expect(page.locator("#cart")).toHaveAttribute("data-ready", "empty");
    await expect(page.locator("[data-cart-count]").first()).toBeHidden();
  });

  test("checkout permalink is enabled for numeric variants and clamps quantity to 99", async ({ page }) => {
    await seedCart(page, [{ productId: "gid://p1", variantId: "987654", title: "X", price: "$1", quantity: 250 }]);
    await page.goto("/cart");
    const checkout = page.locator('[data-testid="checkout"]');
    await expect(checkout).toHaveAttribute("href", "https://palup-skincare-jason.myshopify.com/cart/987654:99");
    await expect(checkout).toHaveAttribute("target", "_blank");
    await expect(checkout).toHaveAttribute("rel", /noopener/);
  });

  test("checkout permalink carries the join token as a cart attribute when window.PALUP.joinToken is set", async ({ page }) => {
    // Pillar-4 flywheel attribution (S4 / ADR-0020): the PANEL mints the opaque, PII-free join token and the
    // loader exposes it on window.PALUP.joinToken (loader-core.ts `palup:jointoken`). The storefront threads it
    // onto the Shopify checkout permalink as a cart attribute; Shopify carries `?attributes[...]` to the order's
    // note_attributes, which the backend order webhook reads to attribute the sale to its holdout arm. The token
    // is base64url, so it passes through url-encoding unchanged. Dark until ORDER_ATTRIBUTION_WEBHOOKS is enabled
    // (the panel latches on the 404 and never emits), so on a live-attribution store this is the only new state.
    await page.addInitScript(() => {
      const w = window as unknown as { PALUP?: Record<string, unknown> };
      w.PALUP = Object.assign(w.PALUP || {}, { joinToken: "dG9rZW4tXy0xMjM" });
    });
    await seedCart(page, [{ productId: "gid://p1", variantId: "987654", title: "X", price: "$1", quantity: 2 }]);
    await page.goto("/cart");
    const checkout = page.locator('[data-testid="checkout"]');
    await expect(checkout).toHaveAttribute(
      "href",
      "https://palup-skincare-jason.myshopify.com/cart/987654:2?attributes[_palup_join_token]=dG9rZW4tXy0xMjM",
    );
  });

  test("checkout permalink is disabled (no navigable href) when no line has a numeric variant", async ({ page }) => {
    await seedCart(page, [{ productId: "gid://p1", variantId: "not-a-number", title: "X", price: "$1", quantity: 1 }]);
    await page.goto("/cart");
    const checkout = page.locator('[data-testid="checkout"]');
    await expect(checkout).toHaveAttribute("aria-disabled", "true");
    expect(await checkout.getAttribute("href")).toBeNull();
  });

  test("populated cart is WCAG 2.2 AA clean", async ({ page }) => {
    await seedCart(page, LINES);
    await page.goto("/cart");
    await expect(page.locator("#cart")).toHaveAttribute("data-ready", "1");
    const results = await new AxeBuilder({ page }).withTags(WCAG22AA).analyze();
    expect(results.violations).toEqual([]);
  });
});

test.describe("sample storefront — product not-found (soft-404)", () => {
  // No test previously visited /product/:handle at all. In the mock backend the catalog resolves empty, so
  // every direct PDP falls into the not-found path — which is exactly the honest state we must guarantee is
  // reachable, readable, and accessible (a bad/stale/typo URL, or SEO/ad landing on a removed product).
  test("an unknown handle renders the honest not-found state with a browse link, WCAG 2.2 AA clean", async ({ page }) => {
    await page.goto("/product/this-handle-does-not-exist");
    await expect(page.locator("#pdp")).toHaveAttribute("data-ready", "notfound");
    await expect(page.locator("#pdp")).toContainText("Sorry — we couldn't find that product from here.");
    await expect(page.locator('#pdp a[href="/"]')).toBeVisible();
    const results = await new AxeBuilder({ page }).withTags(WCAG22AA).analyze();
    expect(results.violations).toEqual([]);
  });
});
