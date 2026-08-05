import { defineConfig } from "@playwright/test";

// Live-model E2E: runs the widget against the REAL Vertex/Gemini path. Requires GCP creds (ADC +
// GOOGLE_CLOUD_PROJECT); the spec skips itself when they're absent, so CI stays green without creds.
// Run locally: `pnpm e2e:live`.
// Overridable so two agents/worktrees can run e2e concurrently without colliding. This matters more
// than a port clash suggests: `reuseExistingServer: !process.env.CI` means a second local run does not
// fail loudly on a busy port — it SILENTLY tests against the first run's server, i.e. against the other
// agent's code, and passes. CI leaves E2E_PORT unset and gets the identical fixed port as before.
const PORT = Number(process.env.E2E_PORT ?? 8793);

export default defineConfig({
  testDir: "./tests",
  testMatch: /live-model\.spec\.ts/,
  timeout: 60_000, // real model calls have latency
  fullyParallel: false,
  use: { baseURL: `http://127.0.0.1:${PORT}` },
  webServer: {
    command: "pnpm backend",
    cwd: "..",
    url: `http://127.0.0.1:${PORT}/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: {
      PORT: String(PORT),
      // Forward creds so the backend selects the Vertex adapter.
      GOOGLE_CLOUD_PROJECT: process.env.GOOGLE_CLOUD_PROJECT ?? "",
      GOOGLE_CLOUD_LOCATION: process.env.GOOGLE_CLOUD_LOCATION ?? "global",
      PALUP_MODEL: process.env.PALUP_MODEL ?? "gemini-2.5-flash",
    },
  },
});
