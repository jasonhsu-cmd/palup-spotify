import { test, expect } from "@playwright/test";

// Drives the governed self-improvement loop through the dashboard: propose -> evaluate -> GATE
// (blocks the bad candidate) -> human approve -> promote (champion changes) -> auto-rollback.
test("self-improvement loop is observable and governed via the dashboard", async ({ page }) => {
  // The control-plane is default-deny (M1 operator gate): the dashboard must present the operator token
  // for its mutating actions. Inject it (matches OPERATOR_TOKEN in the webServer env) before load.
  await page.addInitScript(() => localStorage.setItem("palup_operator_token", "e2e-op-token"));
  await page.goto("/");
  await expect(page.getByTestId("champion-label")).toContainText("Baseline");

  await page.getByTestId("seed-btn").click();
  for (const id of ["cand-warm-concise", "cand-confident", "cand-aggressive"]) {
    const btn = page.getByTestId(`evaluate-${id}`);
    await btn.click();
    await page.waitForTimeout(150);
  }

  // The gate BLOCKS the aggressive candidate; the good one awaits human approval.
  await expect(page.getByTestId("status-cand-aggressive")).toContainText("blocked");
  await expect(page.getByTestId("status-cand-warm-concise")).toContainText("awaiting");

  // §3 NN#2 — shadow → canary are REQUIRED before a human promotion, and they are ordered: each button
  // only appears once the prior stage has passed, so this sequence IS the enforcement being exercised
  // through the UI. Before this, approve → promote went straight to 100% of traffic.
  await page.getByTestId("stage-cand-warm-concise").click();
  await page.getByTestId("shadow-cand-warm-concise").click();
  await page.getByTestId("canary-cand-warm-concise").click();

  // Human approves + promotes -> champion changes (no self-promotion path exists).
  await page.getByTestId("approve-cand-warm-concise").click();
  await page.getByTestId("promote-cand-warm-concise").click();
  await expect(page.getByTestId("champion-label")).toContainText("Warmer");

  // A simulated live regression auto-rolls back to the baseline.
  await page.getByTestId("regress-btn").click();
  await expect(page.getByTestId("champion-label")).toContainText("Baseline");

  // M3 slice 7 — the operator can load per-tenant cost/telemetry. The read is operator-gated (the
  // injected token authenticates it); it renders even with no traffic yet (events = 0).
  await page.getByTestId("tel-refresh").click();
  await expect(page.getByTestId("tel-events")).toBeVisible();
  await expect(page.getByTestId("tel-status")).toContainText("tenant: demo");
  await expect(page.getByTestId("telemetry")).not.toContainText("set the operator token");
});
