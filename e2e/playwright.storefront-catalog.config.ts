import { defineConfig } from "@playwright/test";

// Storefront WITH a populated catalog. The default e2e config sets no SHOPIFY_STORES, so no tenant
// resolves and /storefront/catalog is deliberately EMPTY (see storefront.spec.ts's own note). This
// dedicated process maps the sample storefront's shop → the built-in "demo" tenant, whose static
// AURIA fixture catalog (widget-brain/src/adapters/static-grounding.ts) then flows through
// /storefront/catalog + /storefront/product — so the grid, a direct-URL PDP (the GAP-3 fix, end to
// end), and PDP-with-product accessibility can be asserted deterministically in mock CI. Isolated from
// the shared config ON PURPOSE (its own port + backend process + env), same pattern as the embed/monitor
// configs, so it can't perturb storefront.spec.ts's empty-state assertions.
const PORT = Number(process.env.E2E_PORT ?? 8796);

export default defineConfig({
  testDir: "./tests",
  testMatch: /storefront-catalog\.spec\.ts/,
  timeout: 30_000,
  fullyParallel: false,
  use: { baseURL: `http://127.0.0.1:${PORT}` },
  webServer: {
    command: "pnpm backend",
    cwd: "..",
    url: `http://127.0.0.1:${PORT}/health`,
    env: {
      PORT: String(PORT),
      // tenant "demo" -> the sample storefront's shop (static-grounding maps demo -> the AURIA catalog).
      SHOPIFY_STORES: JSON.stringify({ demo: "palup-skincare-jason.myshopify.com" }),
    },
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
