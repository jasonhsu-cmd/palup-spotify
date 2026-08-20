import { defineConfig } from "@playwright/test";

// Layer 2 — the FIRST, riskiest slice of a live-browser behavioral suite: prove headless Playwright can
// drive the DEPLOYED staging widget (real loader, real closed-shadow-DOM launcher, real same-origin
// /embed/panel iframe, real /chat inference) and capture its response JSON. Unlike every sibling config
// in this directory, there is NO webServer here — the target is the ALREADY-RUNNING staging Cloud Run
// service (palup-widget-staging), because the point is to exercise the real deployment's flag posture
// (memory, safety-escalation, checkout, catalog retrieval), not a locally-spun mock-model process.
//
// This hits a live service with real inference: keep the spec file's call count minimal (see its own
// header) and do not add cases here casually — each run spends real staging traffic/COGS.
const STAGING_BASE_URL = "https://palup-widget-staging-270594351425.us-central1.run.app";

export default defineConfig({
  testDir: "./tests",
  testMatch: /widget-behavioral-live\.spec\.ts/,
  timeout: 60_000, // real /chat replies observed at ~3-5s; safety/retrieval-heavy turns can run longer
  fullyParallel: false,
  use: {
    baseURL: STAGING_BASE_URL,
  },
  // No webServer block: the target is the deployed staging service, not a process this config spawns.
});
