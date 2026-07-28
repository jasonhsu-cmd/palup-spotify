import { test, expect } from "@playwright/test";

// Drives the governed self-improvement loop through the dashboard: propose -> evaluate -> GATE
// (blocks the bad candidate) -> human approve -> promote (champion changes) -> auto-rollback.
test("self-improvement loop is observable and governed via the dashboard", async ({ page }) => {
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

  // Human approves + promotes -> champion changes (no self-promotion path exists).
  await page.getByTestId("approve-cand-warm-concise").click();
  await page.getByTestId("promote-cand-warm-concise").click();
  await expect(page.getByTestId("champion-label")).toContainText("Warmer");

  // A simulated live regression auto-rolls back to the baseline.
  await page.getByTestId("regress-btn").click();
  await expect(page.getByTestId("champion-label")).toContainText("Baseline");
});
