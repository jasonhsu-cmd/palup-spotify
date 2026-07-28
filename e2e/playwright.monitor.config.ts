import { defineConfig } from "@playwright/test";

// E2E for the self-improvement control-plane dashboard (mock mode — no creds, runs in CI).
const PORT = 8998;

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
    env: { PORT: String(PORT) },
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
