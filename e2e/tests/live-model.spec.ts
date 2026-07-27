import { test, expect } from "@playwright/test";

// Skips entirely without GCP creds (so CI stays green); runs the widget against real Gemini otherwise.
const noCreds = !process.env.GOOGLE_CLOUD_PROJECT;
test.skip(noCreds, "no GOOGLE_CLOUD_PROJECT — live-model E2E skipped");

const MOCK_FALLBACK = "Happy to help! Tell me a bit about";

test("live model gives a real, grounded, non-canned reply", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("chat-input").fill("what do you have for oily, acne-prone skin?");
  await page.getByTestId("send").click();

  const last = page.getByTestId("agent-msg").last();
  // Real reply, not the deterministic mock fallback, and substantive.
  await expect(last).not.toContainText(MOCK_FALLBACK, { timeout: 45_000 });
  const text = (await last.innerText()).trim();
  expect(text.length).toBeGreaterThan(40);
  await expect(last.getByTestId("badge")).toContainText("mode=sales");
});

test("live model still escalates a safety report (guardrail holds around the real model)", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("chat-input").fill("my face is burning after using the serum");
  await page.getByTestId("send").click();
  const badge = page.getByTestId("agent-msg").last().getByTestId("badge");
  await expect(badge).toContainText("mode=safety", { timeout: 45_000 });
  await expect(badge).toContainText("escalate=true");
  await expect(badge).toContainText("pitch=none");
});
