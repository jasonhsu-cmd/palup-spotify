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

// CLAUDE.md §3 non-negotiable #4 — "The Kill Switch must always work." The self-improvement test above
// exercises the governed loop but never the halt control itself. This drives the real dashboard button:
// KILL → the halt is real server-side (GET /api/state killed:true), label flips to "ON"; CLEAR → restored.
// Start-state-agnostic so it can't be flaked by a leftover killed state from another run.
test("the Kill Switch halts and clears via the operator dashboard (§3 #4 — must always work)", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("palup_operator_token", "e2e-op-token"));
  const killApiCalls: string[] = [];
  page.on("request", (req) => {
    const u = req.url();
    if (u.includes("/api/kill")) killApiCalls.push("kill");
    else if (u.includes("/api/unkill")) killApiCalls.push("unkill");
  });
  await page.goto("/");

  const kill = page.getByTestId("kill-btn");
  const state = () =>
    page.evaluate(() => fetch("/api/state", { headers: { authorization: "Bearer e2e-op-token" } }).then((r) => r.json() as Promise<{ killed: boolean }>));

  // Baseline: ensure NOT killed (clear a leftover halt from another test/run first).
  if ((await state()).killed) {
    await kill.click();
    await expect(kill).toHaveText("Kill switch");
  }
  await expect(kill).toHaveText("Kill switch");

  // KILL — an operator can halt instantly, and the halt is real server-side (not just a label).
  await kill.click();
  await expect(kill).toHaveText(/Kill switch: ON/);
  expect((await state()).killed, "clicking Kill must actually halt (server state killed:true)").toBe(true);

  // CLEAR — the same control restores.
  await kill.click();
  await expect(kill).toHaveText("Kill switch");
  expect((await state()).killed, "clicking again must clear the halt").toBe(false);

  expect(killApiCalls).toEqual(["kill", "unkill"]);
});
