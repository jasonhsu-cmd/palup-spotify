import { test, expect } from "@playwright/test";
import { STAGING_SHOP, collectChatResponses, openPanel, sendMessage } from "../lib/widget-layer2-helpers.js";

// Layer 2, first slice — a MINIMAL smoke proving headless Playwright can drive the DEPLOYED staging
// widget end to end (real loader, real closed-shadow-DOM launcher, real same-origin /embed/panel
// iframe, real /chat inference) and capture the response JSON. This hits the LIVE staging service
// (palup-widget-staging — see playwright.layer2.config.ts's baseURL): keep this file to the ONE smoke
// case below. The full case-set runner lives in `e2e/scripts/run-layer2-live.ts` (a standalone script,
// not a `test()` file — it needs 3x-repeat/structural-grading/judge control this fixture-based runner
// doesn't give), and both share the mechanics in `e2e/lib/widget-layer2-helpers.ts`.
//
// Ground truth for every non-obvious decision below comes from a prior live spike (Chrome + injected
// JS + source grep against this exact staging deployment, 2026-08-20):
//   /private/tmp/.../scratchpad/step0-spike-facts.md
// and the sibling MOCK-backend suite that already solved the same closed-shadow/same-origin-iframe
// structure against a local process:
//   e2e/tests/embed.spec.ts (see its own file-header comment for the two Playwright gotchas below)
//
// TWO THINGS THIS FILE DELIBERATELY DOES NOT DO (both re-confirmed against the LIVE staging deployment
// in the spike, not assumed from the local-backend suite):
//
//  1. It never uses `page.frameLocator(...)` to reach the panel. The panel <iframe> is appended INSIDE
//     the loader's CLOSED shadow root (packages/widget/src/loader-core.ts:64, `attachShadow({mode:
//     "closed"})`), so any DOM/CSS-based selector — including frameLocator — cannot see it. What DOES
//     find it: `page.frames()`, which walks the browser's real frame tree via CDP, independent of
//     shadow-DOM visibility. The spike confirmed this live: `page.frames().find(f =>
//     f.url().includes("/embed/panel"))` finds the staging panel iframe.
//
//  2. It never patches `window.fetch` on the top-level page to capture `/chat`. The widget's actual
//     network calls happen inside the panel IFRAME's own window/document — a separate JS realm — so a
//     top-level fetch patch silently catches nothing (this cost real time in the spike before the
//     iframe was found). `page.on("response")` intercepts at the CDP/browser-network level and is
//     unaffected by which frame or realm issued the request — that is what this file uses.
//
// HOW open() GETS TRIGGERED AT ALL: the floating launcher button lives directly in the closed shadow
// root (not inside the iframe), so it cannot be `.click()`-ed via any Playwright locator either. The
// loader ships a sanctioned test seam for exactly this — a non-enumerable `host.__palupRoot` property
// stashing the live ShadowRoot (loader-core.ts:65-69, "Never read by app code"). This reaches through
// THAT seam, in-page, to find the real launcher (`button[aria-label="Ask the expert"]`) and dispatch a
// real `.click()` on it, running the real open() handler — confirmed live in the spike, and identical
// to the seam embed.spec.ts already uses against the mock backend.

test("layer2 smoke: headless Playwright drives the deployed staging widget and captures a real /chat response", async ({
  page,
}) => {
  const chatResponses = collectChatResponses(page);
  const frame = await openPanel(page, chatResponses);
  expect(frame.url()).toContain(`shop=${STAGING_SHOP}`);

  const chat = await sendMessage(
    page,
    frame,
    chatResponses,
    "what do you recommend for oily skin?",
    "layer2-smoke",
  );

  // (a) an agent reply rendered in the panel
  const replyBubble = frame.getByTestId("agent-msg").last();
  await expect(replyBubble).toBeVisible();
  await expect(replyBubble).not.toHaveText("");

  // (b) the captured /chat response has a string reply + a valid mode (widget-brain/src/types.ts's
  // `Mode` union: "safety" | "support" | "sales" | "smalltalk")
  expect(typeof chat.reply).toBe("string");
  expect((chat.reply ?? "").length).toBeGreaterThan(0);
  expect(["safety", "support", "sales", "smalltalk"]).toContain(chat.mode);
});
