import { test, expect, type Frame, type Page } from "@playwright/test";

// Layer 2, first slice — a MINIMAL smoke proving headless Playwright can drive the DEPLOYED staging
// widget end to end (real loader, real closed-shadow-DOM launcher, real same-origin /embed/panel
// iframe, real /chat inference) and capture the response JSON. This hits the LIVE staging service
// (palup-widget-staging — see playwright.layer2.config.ts's baseURL): keep this file to the ONE smoke
// case below. Do not add more turns/tests here without weighing the extra real-inference cost against
// scaling this into the full Layer-2 case set separately.
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

const STAGING_SHOP = "palup-skincare-jason.myshopify.com";

/** Poll `page.frames()` for the panel iframe and return its `Frame` handle. */
async function panelFrame(page: Page): Promise<Frame> {
  await expect
    .poll(() => page.frames().some((f) => f.url().includes("/embed/panel")), {
      message: "panel iframe (/embed/panel) never appeared in page.frames()",
      timeout: 20_000,
    })
    .toBe(true);
  const frame = page.frames().find((f) => f.url().includes("/embed/panel"));
  if (!frame) throw new Error("panel frame vanished between poll and lookup");
  return frame;
}

/** Navigate to the staging storefront root, open the widget panel through the loader's own closed-
 *  shadow-root test seam, and return the real panel iframe's Frame handle. Every Playwright `test()`
 *  gets a brand-new, isolated browser context by default (fresh storage, fresh cookies), so this alone
 *  is enough for a clean session — no prior sessionId/guest-token survives from another test.
 *
 *  IMPORTANT (a real race this file hit and fixed): opening the panel fires the panel's own first-touch
 *  `signals.proactiveTrigger === "greeting"` `/chat` turn automatically (confirmed live — see the
 *  report), exactly like `embed.spec.ts`'s "#347 race" guard describes for the local mock backend. That
 *  greeting turn is its OWN `/chat` request/response, indistinguishable from a real shopper turn by URL
 *  alone. `openPanel` therefore waits for that greeting response to land in `chatResponses` (index 0)
 *  BEFORE returning, so a caller's own `sendMessage(...)` calls can safely track "new response = mine"
 *  by array-length growth without racing the greeting. Without this wait, a `sendMessage` call issued
 *  right after `openPanel` can capture the GREETING's response instead of the reply to its own message
 *  (observed directly while building this file: the smoke's first captured JSON was
 *  `{"flags":["proactive:greeting","opener"],...}`, not a reply to the sent question). */
async function openPanel(page: Page, chatResponses: ChatResponse[]): Promise<Frame> {
  await page.goto("/");
  await expect(page.locator("[data-palup-host]")).toHaveAttribute("data-palup-mounted", "true", {
    timeout: 20_000,
  });
  await page.evaluate(() => {
    type HostWithRoot = HTMLElement & { __palupRoot?: ShadowRoot };
    const hostEl = document.querySelector("[data-palup-host]") as HostWithRoot | null;
    const launcher = hostEl?.__palupRoot?.querySelector(
      'button[aria-label="Ask the expert"]',
    ) as HTMLButtonElement | null;
    if (!launcher) throw new Error("launcher button not found inside the closed shadow root");
    launcher.click();
  });
  const frame = await panelFrame(page);
  // Let the automatic greeting turn's /chat round trip land before this returns (see doc comment above).
  await expect
    .poll(() => chatResponses.length, {
      message: "the automatic first-touch greeting /chat turn never landed after opening the panel",
      timeout: 20_000,
    })
    .toBeGreaterThanOrEqual(1);
  return frame;
}

/** The `/chat` response shape, per the live spike's captured samples + widget-brain/src/types.ts's
 *  `Mode` union. Kept loose (index signature) since this smoke only asserts a couple of fields. */
type ChatResponse = {
  reply?: string;
  mode?: string;
  pitch?: string;
  escalate?: boolean;
  flags?: string[];
  servedBy?: string;
  memoryEnabled?: boolean;
  consentMode?: string;
  consentPrompt?: string;
  recommendedProducts?: string[];
  recommendedProductCards?: unknown[];
  checkoutEnabled?: boolean;
  [key: string]: unknown;
};

/** Attach a CDP-level response collector for `POST /chat`. Must be called BEFORE `page.goto` so no
 *  early request is missed. Returns the array it appends to (grows in place). */
function collectChatResponses(page: Page): ChatResponse[] {
  const collected: ChatResponse[] = [];
  page.on("response", (res) => {
    if (res.request().method() !== "POST" || !res.url().includes("/chat")) return;
    res
      .json()
      .then((json: ChatResponse) => collected.push(json))
      .catch(() => {
        /* non-JSON or already-consumed body (e.g. a non-200 error page) — ignore */
      });
  });
  return collected;
}

/**
 * Reusable Layer-2 helper: type `text` into the panel's chat input, send it, wait for a new
 * `agent-msg` bubble to render AND for the matching `/chat` response to land, then return that
 * response JSON. This is the shape a full case set should call per turn.
 *
 * Also tags the outgoing `/chat` request with an `X-Palup-E2E-Test` header (via `page.route`, additive
 * to whatever headers the widget itself sets) purely so this traffic is identifiable in staging
 * logs/metrics — it does not alter the shopper message the model sees or the widget's own auth headers.
 *
 * NOTE for scaling to a full case set: this repo's `/chat` response body carries no echo of the request
 * (no message/idempotencyKey field), so there is no way to match a specific response to a specific
 * `sendMessage` call other than ORDER (the `chatResponses` array grows in call order, one entry per
 * `/chat` round trip). Calling `sendMessage` sequentially on the SAME frame/session (not concurrently)
 * is what keeps that ordering assumption valid — see the report for the corollary sticky-session hazard
 * (a flagged health mention taints every later turn in that same session, per the prior spike).
 */
async function sendMessage(
  page: Page,
  frame: Frame,
  chatResponses: ChatResponse[],
  text: string,
): Promise<ChatResponse> {
  const priorAgentMsgCount = await frame.getByTestId("agent-msg").count();
  const priorResponseCount = chatResponses.length;

  await page.route("**/chat", async (route) => {
    const headers = { ...route.request().headers(), "x-palup-e2e-test": "layer2-smoke" };
    await route.continue({ headers });
  });

  await frame.getByTestId("chat-input").fill(text);
  await frame.getByTestId("send").click();

  await expect
    .poll(() => frame.getByTestId("agent-msg").count(), {
      message: "no new agent-msg bubble rendered after sending a message",
      timeout: 45_000, // real inference latency observed at ~3-5s in the spike; some turns run longer
    })
    .toBeGreaterThan(priorAgentMsgCount);

  await expect
    .poll(() => chatResponses.length, {
      message: "/chat response was never captured via page.on('response')",
      timeout: 45_000,
    })
    .toBeGreaterThan(priorResponseCount);

  return chatResponses[chatResponses.length - 1];
}

test("layer2 smoke: headless Playwright drives the deployed staging widget and captures a real /chat response", async ({
  page,
}) => {
  const chatResponses = collectChatResponses(page);
  const frame = await openPanel(page, chatResponses);
  expect(frame.url()).toContain(`shop=${STAGING_SHOP}`);

  const chat = await sendMessage(page, frame, chatResponses, "what do you recommend for oily skin?");

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
