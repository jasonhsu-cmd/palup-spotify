import { expect, type BrowserContext, type Frame, type Page } from "@playwright/test";

// Shared Layer-2 live-staging helpers — extracted from `widget-behavioral-live.spec.ts` (the working
// smoke, commit 0091a9a) so the full case-set runner (`e2e/scripts/run-layer2-live.ts`) and the smoke
// test share one implementation of the closed-shadow-DOM / same-origin-iframe mechanics instead of two
// copies drifting apart. See that spec file's header comment for the full "why" on each gotcha below;
// this file keeps only the "how".

export const STAGING_SHOP = "palup-skincare-jason.myshopify.com";

/** The `/chat` response shape (loose — index signature — since callers only need a few known fields). */
export type ChatResponse = {
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

/** Poll `page.frames()` for the panel iframe (lives inside a CLOSED shadow root — no CSS/frameLocator
 *  selector can see it, but the CDP-backed frame tree is unaffected) and return its `Frame` handle. */
export async function panelFrame(page: Page): Promise<Frame> {
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

/** Attach a CDP-level response collector for `POST /chat`. Must be called BEFORE `page.goto` so no
 *  early request is missed. Returns the array it appends to (grows in place). */
export function collectChatResponses(page: Page): ChatResponse[] {
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

/** Navigate to the staging storefront root, open the widget panel through the loader's own closed-
 *  shadow-root test seam (`host.__palupRoot`, non-enumerable, "never read by app code"), and return the
 *  real panel iframe's Frame handle. Waits for the automatic first-touch GREETING `/chat` turn to land
 *  before returning, so a caller's own `sendMessage` calls can safely track "new response = mine" by
 *  array-length growth without racing the greeting (see the smoke's file-header comment for the bug this
 *  fixed). Callers should use a fresh `Page`/context per case for session isolation. */
export async function openPanel(page: Page, chatResponses: ChatResponse[]): Promise<Frame> {
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
  await expect
    .poll(() => chatResponses.length, {
      message: "the automatic first-touch greeting /chat turn never landed after opening the panel",
      timeout: 20_000,
    })
    .toBeGreaterThanOrEqual(1);
  return frame;
}

/**
 * Type `text` into the panel's chat input, send it, wait for a new `agent-msg` bubble to render AND for
 * the matching `/chat` response to land, then return that response JSON.
 *
 * `/chat` responses carry no request echo, so the only way to associate "the response I just got" with
 * "the message I just sent" is call ORDER — callers must invoke this sequentially on one frame/session,
 * never concurrently (see the smoke's known-limitations section).
 *
 * Tags the outgoing request with `X-Palup-E2E-Test: <tag>` (additive; does not alter the widget's own
 * headers or the message text) so staging traffic from this run is identifiable in logs/metrics.
 */
export async function sendMessage(
  page: Page,
  frame: Frame,
  chatResponses: ChatResponse[],
  text: string,
  tag: string,
): Promise<ChatResponse> {
  const priorAgentMsgCount = await frame.getByTestId("agent-msg").count();
  const priorResponseCount = chatResponses.length;

  await page.route("**/chat", async (route) => {
    const headers = { ...route.request().headers(), "x-palup-e2e-test": tag };
    await route.continue({ headers });
  });

  await frame.getByTestId("chat-input").fill(text);
  await frame.getByTestId("send").click();

  await expect
    .poll(() => frame.getByTestId("agent-msg").count(), {
      message: "no new agent-msg bubble rendered after sending a message",
      timeout: 45_000,
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

/** Convenience for standalone (non-`test()`) scripts: open a fresh page in `context`, wire response
 *  capture, open the panel (consuming the greeting turn), and return everything a case run needs. */
export async function openFreshSession(
  context: BrowserContext,
): Promise<{ page: Page; frame: Frame; chatResponses: ChatResponse[] }> {
  const page = await context.newPage();
  const chatResponses = collectChatResponses(page);
  const frame = await openPanel(page, chatResponses);
  return { page, frame, chatResponses };
}
