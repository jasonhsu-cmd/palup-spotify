import { defineConfig } from "@playwright/test";

// E2E for the self-improvement control-plane dashboard (mock mode — no creds, runs in CI).
// Overridable so two agents/worktrees can run e2e concurrently without colliding. This matters more
// than a port clash suggests: `reuseExistingServer: !process.env.CI` means a second local run does not
// fail loudly on a busy port — it SILENTLY tests against the first run's server, i.e. against the other
// agent's code, and passes. CI leaves E2E_PORT unset and gets the identical fixed port as before.
const PORT = Number(process.env.E2E_PORT ?? 8998);

export default defineConfig({
  testDir: "./tests",
  testMatch: /monitor\.spec\.ts/,
  timeout: 30_000,
  fullyParallel: false,
  use: { baseURL: `http://127.0.0.1:${PORT}` },
  webServer: {
    command: "pnpm monitor",
    cwd: "..",
    url: `http://127.0.0.1:${PORT}/health`,
    env: { PORT: String(PORT), OPERATOR_TOKEN: "e2e-op-token" },
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
