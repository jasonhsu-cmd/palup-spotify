import { defineConfig } from "@playwright/test";

// Task 7 — embed round-trip E2E: loader on a host page -> launcher mounts -> open -> panel iframe
// (/embed/panel) -> mint -> /chat -> assistant reply renders, all against the MOCK model.
//
// ISOLATED from e2e/playwright.config.ts ON PURPOSE (its own config, own port, own backend process,
// own env) rather than added to the shared widget/a11y webServer's env. Reasoning: this spec needs
// SHOPIFY_STORES + WIDGET_TOKEN_SECRET set so `/widget/token?shop=...` can mint (merchant-resolver.ts's
// `tenantForShopDomain`) — but the shared config's widget.spec.ts is 1300+ lines covering embed-key
// namespacing, memory consent, and auth-token edge cases, several of which currently rely on the mint
// FAILING (WIDGET_TOKEN_SECRET unset there) so the widget falls back to the unauthenticated
// RUNTIME_TENANT path. Flipping the mint on for that whole suite risks silently changing which code path
// dozens of unrelated tests exercise. A dedicated process (mirroring the existing e2e:live / e2e:monitor
// pattern) gives this spec exactly the env it needs with ZERO risk to the shared suite: they are
// different OS processes on different ports and never share state.
//
// Overridable so two agents/worktrees can run e2e concurrently without colliding — same rationale as
// the sibling configs' own comment (a port clash would otherwise SILENTLY test against the other run's
// server and pass).
const PORT = Number(process.env.E2E_PORT ?? 8795);

export default defineConfig({
  testDir: "./tests",
  testMatch: /embed\.spec\.ts/,
  timeout: 30_000,
  fullyParallel: false,
  use: { baseURL: `http://127.0.0.1:${PORT}` },
  webServer: {
    command: "pnpm backend",
    cwd: "..",
    url: `http://127.0.0.1:${PORT}/health`,
    env: {
      PORT: String(PORT),
      // Demo shop -> tenant mapping so the mint (`/widget/token?shop=acme.myshopify.com`) resolves a
      // tenant via merchant-resolver.ts's `tenantForShopDomain` (no DATABASE_URL here, so this is the
      // resolver's "env" mode — the same posture staging's own demo tenant uses).
      SHOPIFY_STORES: JSON.stringify({ demo: "acme.myshopify.com" }),
      // Without a signing secret /widget/token always 401s (server.ts: `!WIDGET_TOKEN_SECRET` short-
      // circuits the mint) regardless of tenant resolution. Any non-empty value works — this process
      // never verifies a token minted by a different secret.
      WIDGET_TOKEN_SECRET: "e2e-embed-widget-token-secret",
      // Registers the TEST-ONLY `/embed-host` fixture route (server.ts) — see that file's comment.
      PALUP_E2E_FIXTURES: "true",
    },
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
