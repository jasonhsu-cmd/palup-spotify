import { defineConfig } from "@playwright/test";

const PORT = 8792;

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
