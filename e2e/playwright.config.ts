import { defineConfig } from "@playwright/test";

// Overridable so two agents/worktrees can run e2e concurrently without colliding. This matters more
// than a port clash suggests: `reuseExistingServer: !process.env.CI` means a second local run does not
// fail loudly on a busy port — it SILENTLY tests against the first run's server, i.e. against the other
// agent's code, and passes. CI leaves E2E_PORT unset and gets the identical fixed port as before.
const PORT = Number(process.env.E2E_PORT ?? 8792);

export default defineConfig({
  testDir: "./tests",
  testMatch: /widget\.spec\.ts/, // mock-mode app E2E only; live-model runs via playwright.live.config.ts
  timeout: 30_000,
  fullyParallel: false,
  use: { baseURL: `http://127.0.0.1:${PORT}` },
  webServer: {
    command: "pnpm backend",
    cwd: "..",
    url: `http://127.0.0.1:${PORT}/health`,
    env: { PORT: String(PORT) },
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
