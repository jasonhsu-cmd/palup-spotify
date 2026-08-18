import { test, expect, type Frame, type Page } from "@playwright/test";

// Task 7 — the full embed round trip, a real browser end to end, against the MOCK model (this suite's
// own isolated backend process never sets GOOGLE_CLOUD_PROJECT — see playwright.embed.config.ts):
//
//   loader on a host page -> launcher mounts -> open -> panel iframe (/embed/panel) -> mint (/widget/
//   token?shop=...) -> /chat -> a non-empty assistant reply renders.
//
// TWO THINGS THIS FILE DELIBERATELY DOES NOT DO, both verified by hand against this exact Playwright
// version (1.62.0) before writing a line of test code, not assumed from the brief:
//
//  1. It never asserts `toBeVisible()` on `[data-palup-host]`. The host <div> is appended to <body>
//     with no light-DOM content of its own — everything visible lives in its CLOSED shadow root as
//     `position:fixed` content, which does not contribute to the host's own box. Measured directly
//     (Playwright, this repo's browser): boundingBox `{width: 1264, height: 0}`, `isVisible() === false`.
//     Playwright's own visibility definition requires a non-empty box, so that assertion would be a
//     guaranteed, permanent false negative. `toBeAttached()` is what this element can honestly promise.
//
//  2. It never uses `page.frameLocator("iframe[title='Chat']")` to reach the panel. The panel <iframe>
//     is created INSIDE the same closed shadow root as the launcher (loader-core.ts: `root.appendChild
//     (el)`), and frameLocator resolves its selector via the DOM — which cannot see past a closed shadow
//     root any more than a plain locator can. Measured directly: an iframe appended into a closed shadow
//     root is invisible to both `page.locator("iframe[title='Chat']")` (count 0) and
//     `page.frameLocator(...)` (times out). What DOES find it: `page.frames()` — Playwright's frame
//     enumeration walks the browser's actual frame tree (via CDP), which is independent of DOM/shadow
//     visibility. Verified: an iframe appended into a closed shadow root shows up in `page.frames()` and
//     is fully interactive through the returned `Frame` handle.
//
// HOW OPEN() GETS TRIGGERED AT ALL, THEN. The launcher button is unreachable by any selector for the
// same closed-shadow reason, so it cannot be `.click()`-ed via Playwright. loader-core.ts ships a
// sanctioned test seam for exactly this: a non-enumerable `host.__palupRoot` property stashing the live
// ShadowRoot (see loader-core.ts's own comment on it — "Never read by app code"). This test reaches
// through THAT seam, in-page, to find the real launcher button and dispatch a real `.click()` on it —
// running the real `open()` handler, not a reimplementation of what it does.

/** Poll `page.frames()` for the panel iframe and return its `Frame` handle. */
async function panelFrame(page: Page): Promise<Frame> {
  await expect
    .poll(() => page.frames().some((f) => f.url().includes("/embed/panel")), {
      message: "panel iframe (/embed/panel) never appeared in page.frames()",
    })
    .toBe(true);
  const frame = page.frames().find((f) => f.url().includes("/embed/panel"));
  if (!frame) throw new Error("panel frame vanished between poll and lookup");
  return frame;
}

test("embed: loader on a host page -> launcher mounts -> open -> panel iframe -> mint -> /chat -> assistant reply renders", async ({
  page,
}) => {
  // Capture the two network calls that make this a genuine round trip rather than a lucky pass through
  // the anonymous fallback. WIDGET_AUTH_REQUIRED is off by default (server.ts) — /chat still returns a
  // normal reply on the RUNTIME_TENANT="demo" fallback even with NO Authorization header, so "a reply
  // rendered" alone would not prove the mint (hard problem 1) actually worked.
  let mintStatus: number | null = null;
  page.on("response", (res) => {
    if (res.url().includes("/widget/token")) mintStatus = res.status();
  });
  let chatAuthHeader: string | undefined;
  await page.route("**/chat", async (route) => {
    chatAuthHeader = route.request().headers()["authorization"];
    await route.continue();
  });

  await page.goto("/embed-host");

  // --- "loader on a host page -> launcher mounts" -------------------------------------------------
  // The host <div> itself (light DOM) is queryable and carries both attributes loader-core.ts sets on
  // every successful mount. Its launcher/iframe contents are not queryable — see the file header.
  const host = page.locator("[data-palup-host]");
  await expect(host).toBeAttached();
  await expect(host).toHaveAttribute("data-palup-mounted", "true");

  // --- "open" ---------------------------------------------------------------------------------------
  // Reach into the CLOSED shadow root via loader-core.ts's own `__palupRoot` test seam and click the
  // REAL launcher button (aria-label "Open chat"), running the REAL open() handler.
  await page.evaluate(() => {
    type HostWithRoot = HTMLElement & { __palupRoot?: ShadowRoot };
    const hostEl = document.querySelector("[data-palup-host]") as HostWithRoot | null;
    const root = hostEl?.__palupRoot;
    const launcher = root?.querySelector('button[aria-label="Open chat"]') as HTMLButtonElement | null;
    if (!launcher) throw new Error("launcher button not found inside the closed shadow root");
    launcher.click();
  });

  // --- "panel iframe (/embed/panel)" -----------------------------------------------------------------
  const frame = await panelFrame(page);
  expect(frame.url()).toContain("/embed/panel");
  expect(frame.url()).toContain("shop=acme.myshopify.com");

  // --- "mint -> /chat" --------------------------------------------------------------------------------
  const input = frame.getByTestId("chat-input");
  await input.fill("do you sell sunscreen?");
  await frame.getByTestId("send").click();

  await expect.poll(() => mintStatus, { message: "GET /widget/token?shop=... never returned (or did not 200)" }).toBe(200);
  await expect
    .poll(() => chatAuthHeader, { message: "/chat never carried the minted widget token as an Authorization header" })
    .toMatch(/^Bearer .+/);

  // --- "an assistant reply renders" -------------------------------------------------------------------
  // The mock model's reply text for an unmatched query like this is generic and not worth pinning down
  // to specific words (per the task's own instruction) — assert presence + non-empty text only.
  const reply = frame.getByTestId("agent-msg").last();
  await expect(reply).toBeVisible();
  await expect(reply).not.toHaveText("");
});

// Custom-domain CSP support — playwright.embed.config.ts sets SHOPIFY_PRIMARY_DOMAINS mapping the demo
// shop to a (fictitious, non-resolving) custom domain. This asserts the ACTUAL `content-security-policy`
// response header this real running backend process serves, over a real socket, to a real browser — a
// genuinely different check than the unit suite's `app.inject()` (no socket, no browser, no real HTTP
// response object). It does NOT navigate to the custom domain itself (nothing resolves it): proving
// cross-origin frame permission would need a second real origin, which this single-process harness does
// not have — the unit suite (embed-routes.test.ts) already covers the composed CSP string exhaustively;
// this is the "does the real server actually emit it over the wire" check.
test("embed: /embed/panel's real, on-the-wire CSP response header includes the shop's custom domain", async ({
  page,
}) => {
  let panelCsp: string | undefined;
  page.on("response", (res) => {
    if (res.url().includes("/embed/panel")) panelCsp = res.headers()["content-security-policy"];
  });

  await page.goto("/embed-host");
  await page.evaluate(() => {
    type HostWithRoot = HTMLElement & { __palupRoot?: ShadowRoot };
    const hostEl = document.querySelector("[data-palup-host]") as HostWithRoot | null;
    const root = hostEl?.__palupRoot;
    const launcher = root?.querySelector('button[aria-label="Open chat"]') as HTMLButtonElement | null;
    if (!launcher) throw new Error("launcher button not found inside the closed shadow root");
    launcher.click();
  });
  await panelFrame(page);

  await expect.poll(() => panelCsp, { message: "/embed/panel never returned a content-security-policy header" }).toBeTruthy();
  expect(panelCsp).toContain("frame-ancestors");
  expect(panelCsp).toContain("https://acme.myshopify.com");
  expect(panelCsp).toContain("https://shop.acme-brand.example"); // the SHOPIFY_PRIMARY_DOMAINS entry
});

// WS4 bridge, END TO END through the REAL loader. The host page publishes its cart on `window.PALUP.cart`
// exactly as the storefront's app.js does; the loader must read it (readHostContext), forward it over the
// `palup:context` postMessage (loader→panel), the panel must cache it (readPanelContext) and cartSignal()
// must put it on the /chat wire as `signals.cartItems` — WHITELISTED to productId + quantity only. Existing
// coverage stops short of this exact path: widget.spec E4 injects window.PALUP.cart on the /widget harness
// and reads cartSignal() DIRECTLY, bypassing the loader→panel postMessage hop that only exists in the embed.
test("embed: the host cart (window.PALUP.cart) reaches /chat as signals.cartItems through the real loader→panel bridge, stripped to ids + quantities", async ({
  page,
}) => {
  // Seed the host's cart BEFORE the loader mounts, with extra merchant fields that MUST NOT cross the bridge.
  await page.addInitScript(() => {
    (window as unknown as { PALUP?: unknown }).PALUP = {
      cart: [
        { productId: "gid://shopify/Product/1", variantId: "111", title: "Secret Serum", price: "$99", quantity: 2 },
        { productId: "gid://shopify/Product/2", quantity: 1 },
      ],
      pageContext: "product:secret-serum",
    };
  });

  // Capture every /chat body; we pick the USER turn by its message so a proactive greeting turn (which
  // also carries cartSignal) can't make this assert the wrong request.
  const chatBodies: Array<{ message?: string; signals?: { cartItems?: unknown } }> = [];
  await page.route("**/chat", async (route) => {
    try {
      chatBodies.push(route.request().postDataJSON() as { message?: string; signals?: { cartItems?: unknown } });
    } catch {
      /* non-JSON body — ignore */
    }
    await route.continue();
  });

  await page.goto("/embed-host");
  await expect(page.locator("[data-palup-host]")).toHaveAttribute("data-palup-mounted", "true");

  await page.evaluate(() => {
    type HostWithRoot = HTMLElement & { __palupRoot?: ShadowRoot };
    const hostEl = document.querySelector("[data-palup-host]") as HostWithRoot | null;
    const launcher = hostEl?.__palupRoot?.querySelector('button[aria-label="Open chat"]') as HTMLButtonElement | null;
    if (!launcher) throw new Error("launcher button not found inside the closed shadow root");
    launcher.click();
  });

  const frame = await panelFrame(page);
  const MESSAGE = "what goes well with what's in my cart?";
  await frame.getByTestId("chat-input").fill(MESSAGE);
  await frame.getByTestId("send").click();

  await expect
    .poll(() => chatBodies.find((b) => b.message === MESSAGE)?.signals?.cartItems, {
      message: "the user /chat turn never carried signals.cartItems forwarded from the host cart",
    })
    .toEqual([
      { productId: "gid://shopify/Product/1", quantity: 2 },
      { productId: "gid://shopify/Product/2", quantity: 1 },
    ]);

  // the whitelist dropped the merchant-authored title/price — only ids + quantities ever leave the page
  const wire = JSON.stringify(chatBodies.find((b) => b.message === MESSAGE)?.signals?.cartItems);
  expect(wire).not.toContain("Secret Serum");
  expect(wire).not.toContain("$99");
  expect(wire).not.toContain("111"); // the variantId is host-only, never forwarded over this bridge
});

// Regression guard for the #347 loader race (open() posted palup:open to the not-yet-loaded panel, so it
// was dropped and the panel's first-touch greeting never fired). The panel fires sendGreeting() ONLY on
// receiving palup:open, and that turn carries signals.proactiveTrigger:"greeting" REGARDLESS of the
// GREETING_PROACTIVE flag (the SERVER decides whether to emit any greeting text; the client turn is what
// proves palup:open arrived). So: open the real embed and assert exactly one greeting turn fires BEFORE
// any user input — not zero (the dropped-message bug) and not two (the double-fire the fix also guards).
test("embed: opening the panel delivers palup:open so the first-touch greeting turn fires exactly once (guards the #347 race)", async ({
  page,
}) => {
  const greetingTurns: unknown[] = [];
  await page.route("**/chat", async (route) => {
    try {
      const b = route.request().postDataJSON() as { signals?: { proactiveTrigger?: string } };
      if (b?.signals?.proactiveTrigger === "greeting") greetingTurns.push(b);
    } catch {
      /* non-JSON — ignore */
    }
    await route.continue();
  });

  await page.goto("/embed-host");
  await expect(page.locator("[data-palup-host]")).toHaveAttribute("data-palup-mounted", "true");

  await page.evaluate(() => {
    type HostWithRoot = HTMLElement & { __palupRoot?: ShadowRoot };
    const hostEl = document.querySelector("[data-palup-host]") as HostWithRoot | null;
    const launcher = hostEl?.__palupRoot?.querySelector('button[aria-label="Open chat"]') as HTMLButtonElement | null;
    if (!launcher) throw new Error("launcher button not found inside the closed shadow root");
    launcher.click();
  });
  await panelFrame(page);

  // WITHOUT typing anything: palup:open must have reached the panel and fired exactly one greeting turn.
  await expect
    .poll(() => greetingTurns.length, {
      message: "the panel never fired a first-touch greeting turn on open — palup:open was not delivered (the #347 race)",
    })
    .toBe(1);
  // give any erroneous double-fire a chance to show up, then confirm it stayed at one (once-per-session).
  await page.waitForTimeout(300);
  expect(greetingTurns.length).toBe(1);
});
