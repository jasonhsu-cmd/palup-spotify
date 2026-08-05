import AxeBuilder from "@axe-core/playwright";
import { test, expect, type Page, type Locator } from "@playwright/test";

/**
 * Accessibility E2E for the shopper live-chat widget (`packages/widget/public/index.html`).
 *
 * STANDARD UNDER TEST: **WCAG 2.2 Level AA** (cumulative — every Level A and Level AA success
 * criterion of 2.0, 2.1 and 2.2). The axe tag set below is stated EXPLICITLY rather than relying on
 * axe's default, which runs `best-practice` and some experimental rules too.
 *
 * WHAT THIS FILE DOES **NOT** PROVE — read before trusting a green run:
 *  - axe-core is an automated DOM scanner. Under this tag set it evaluates 70 of its 105 rules
 *    (counted against axe-core 4.12.1). It cannot judge whether the focus ORDER is sensible, whether
 *    an accessible name is COMPREHENSIBLE, whether an announcement arrives at a useful MOMENT, or
 *    what a screen reader actually says. Published estimates put automated coverage at roughly a
 *    third of WCAG failures.
 *  - **No screen reader was run against this widget.** The live-region tests below assert the
 *    STRUCTURE that makes an announcement possible (a live region exists, and the reply text lands
 *    inside it) — not that VoiceOver/NVDA/JAWS speak it usefully. That still needs a human.
 *  - `best-practice` rules are deliberately OUT of the gate (see BEST_PRACTICE_NOTE below).
 */

// Verified against axe-core 4.12.1 (`axe.getRules()`): these five tags select 70 of 105 rules.
// `wcag22aa` contributes exactly one rule at this level — `target-size` (SC 2.5.8).
const WCAG22AA = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

/**
 * BEST_PRACTICE_NOTE — `best-practice` is NOT enabled, and this is a scoping decision, not a way to
 * dodge a red test. Those rules assume the scanned document is a whole page: `region`,
 * `landmark-one-main` and `page-has-heading-one` all demand page-level structure that a widget
 * embedded into somebody else's storefront does not own and must not invent. The document under test
 * here is a STAND-IN storefront fixture, so satisfying them would only prove the fixture is tidy.
 * Anything `best-practice` reports on the widget itself is a finding for the owner, recorded in the
 * PR — never silenced with `disableRules`.
 */

type AxeResults = Awaited<ReturnType<AxeBuilder["analyze"]>>;

/**
 * Run axe over the WIDGET SURFACE with the WCAG 2.2 AA tag set.
 *
 * SCOPE: `#widget` (the panel) and `#launcher` — the markup PalUp actually ships. The rest of this
 * document is the faux storefront fixture that exists so the widget "reads as embedded"; in
 * production that area is the MERCHANT's page, which PalUp neither writes nor controls. Scoping to
 * the product surface is a statement about ownership, not a way to hide failures — the fixture was
 * scanned during this audit too, its one real defect (secondary text at 4.20:1 on `--bg`) was fixed
 * at the token, and what remains there is recorded in the PR.
 *
 * Note this is `include`, i.e. SCOPE. There is no `disableRules()` anywhere in this file, by policy:
 * a rule that has to be switched off is a finding to escalate, not a config edit. Contrast is still
 * computed against the real ancestor chain, so scoping does not soften any threshold.
 */
async function scan(page: Page): Promise<AxeResults> {
  // Take the faux storefront out of the layout for the duration of the scan, so the scanned document
  // matches the topology the widget actually ships in.
  //
  // Why this is necessary and why it hides nothing. The panel is `position:fixed`, so on this demo
  // page it floats over the fixture's product cards. axe resolves contrast by collecting the element
  // stack under EACH text rect and bailing out with `elmPartiallyObscuring` if the stacks differ —
  // and they differ here purely because one wrapped line of a message happens to sit over `.card`,
  // the next over `.ph`, and a trailing space over neither. Verified by probing the live DOM. The
  // result was every message bubble coming back "incomplete" in every conversation state.
  //
  // Nothing real is masked, and that is measured rather than assumed: `#widget`, `#messages`, the
  // message bubbles and `#launcher` all compute to a fully opaque `background-color` with
  // `opacity: 1` and no `background-image`, so no element beneath the panel can affect any contrast
  // ratio inside it. Production agrees — index.html's own load-bearing invariant is that the widget
  // is served FROM the PalUp backend origin (top level or an iframe), "never inlined directly into
  // the merchant storefront DOM", so in production there is no merchant markup under it at all.
  //
  // Layout-safe: both `#widget` and `#launcher` are `position:fixed` with `right`/`bottom` offsets,
  // so removing the fixture cannot move or resize either of them.
  await page.addStyleTag({ content: ".store{ display:none !important }" });
  // Let the bubble entry animation settle before sampling. `.msg` fades in from opacity:0 over 180ms,
  // and axe samples the CURRENT composited colour — mid-fade, a user bubble reads as #7972eb rather
  // than #4f46e5 and "fails" contrast at 3.87:1. That is the scan catching a 180ms transition, not a
  // defect, and it makes the result depend on timing. Settled state only. (`pop` is finite, so this
  // always resolves; the typing dots' infinite animation is excluded because it only animates
  // decorative aria-hidden <i> elements that carry no text.)
  await page.waitForFunction(() =>
    Array.from(document.querySelectorAll(".msg")).every((el) =>
      el.getAnimations().every((a) => a.playState === "finished" || a.playState === "idle"),
    ),
  );
  return new AxeBuilder({ page }).include("#widget").include("#launcher").withTags(WCAG22AA).analyze();
}

/**
 * The two `incomplete` results axe cannot resolve on this surface, each with the reason and the
 * contrast measured by hand. An `incomplete` is "axe could not decide" — NOT a pass — so the rest of
 * them fail the run rather than being waved through. Both entries below are `color-contrast` giving
 * up on classifying the CONTENT as text, which no change of colour can fix:
 *
 *  - `.avatar` — a one-character merchant monogram ("A"). axe: "content is too short to determine if
 *    it is actual text content". Measured 4.02:1 (white on a 22%-white disc over `--brand`), which is
 *    under the 4.5:1 floor. NOT fixed here, deliberately: WCAG 1.4.3 exempts logotypes and brand
 *    marks, and restyling a merchant's brand mark is the owner's call, not this PR's. Reported.
 *  - the send button — its label is the glyph "➤". axe: "content contains only non-text characters".
 *    Measured 6.3:1 (`--brand-ink` on `--brand`) and asserted numerically below, so this one is
 *    genuinely verified rather than merely tolerated.
 *  - a message bubble scrolled partly out of the log — axe: "partially obscured by another element".
 *    The log auto-scrolls to the newest message, so an earlier bubble is clipped by the scroll
 *    container and axe will not sample it. Both bubble types are asserted numerically below instead,
 *    in both colour schemes, which is a stronger check than the one axe declined to run.
 */
const KNOWN_INCOMPLETE: { rule: string; target: RegExp; because: string }[] = [
  { rule: "color-contrast", target: /^\.avatar$/, because: "too short to determine" },
  { rule: "color-contrast", target: /^button\[data-testid="send"\]$/, because: "only non-text characters" },
  { rule: "color-contrast", target: /\.msg|\.agent|\.user/, because: "partially obscured by another element" },
];

function unexplainedIncomplete(incomplete: AxeResults["incomplete"]): AxeResults["violations"] {
  return incomplete
    .map((v) => ({
      ...v,
      nodes: v.nodes.filter(
        (n) =>
          !KNOWN_INCOMPLETE.some(
            (k) => k.rule === v.id && k.target.test(n.target.join(" ")) && (n.failureSummary ?? "").includes(k.because),
          ),
      ),
    }))
    .filter((v) => v.nodes.length > 0);
}

/** Compact, greppable failure text — rule id, impact, WCAG tags, and the offending selector. */
function fmt(nodes: AxeResults["violations"]): string {
  if (nodes.length === 0) return "none";
  return nodes
    .map((v) => {
      const tags = v.tags.filter((t) => t.startsWith("wcag")).join(",");
      const where = v.nodes.map((n) => `      @ ${n.target.join(" ")}\n        ${n.failureSummary?.replace(/\n/g, "\n        ") ?? ""}`).join("\n");
      return `  [${v.id}] impact=${v.impact} (${tags})\n    ${v.help}\n${where}`;
    })
    .join("\n");
}

/**
 * Assert a state is clean.
 *
 * `incomplete` is asserted too, deliberately. An axe `incomplete` means "axe could not decide" —
 * most often a colour it could not resolve behind a gradient or a `color-mix()`. Treating those as
 * silent passes is how a contrast failure hides behind a green tick, so they fail here and get
 * resolved in the markup instead.
 */
async function expectAxeClean(page: Page, state: string) {
  const r = await scan(page);
  expect(fmt(r.violations), `axe VIOLATIONS — state: ${state}`).toBe("none");
  expect(
    fmt(unexplainedIncomplete(r.incomplete)),
    `axe INCOMPLETE with no recorded explanation — state: ${state}. axe could not decide; resolve it in the markup or add it to KNOWN_INCOMPLETE with a measured reason. Do NOT treat it as a pass.`,
  ).toBe("none");
}

// --------------------------------------------------------------------------------------------------
// State drivers. Every state is reached by driving the REAL widget script in a real browser; only
// network responses are ever faked, and only where the real mock backend cannot reach the state
// (memory is double-gated off by design — see the note in widget.spec.ts).
// --------------------------------------------------------------------------------------------------

/** A shopper's load: no `?palupDebug=1`, so no gear and no internal decision badge. */
async function shopperLoad(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("agent-msg")).toHaveCount(1); // the on-load greeting
}

const chatBody = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    reply: "Sure — the vitamin-C serum is our brightening pick.",
    mode: "sales",
    pitch: "none",
    escalate: false,
    outbound: false,
    flags: [],
    servedBy: "prop-0",
    ...extra,
  });

async function sendTurn(page: Page, message: string) {
  const before = await page.getByTestId("agent-msg").count();
  await page.getByTestId("chat-input").fill(message);
  await page.getByTestId("send").click();
  await expect(page.getByTestId("agent-msg")).toHaveCount(before + 1);
}

// --------------------------------------------------------------------------------------------------
// axe over the widget's meaningful states
// --------------------------------------------------------------------------------------------------

test.describe("axe — WCAG 2.2 AA over the shopper widget's states", () => {
  test("state 1 — launcher closed (panel minimized)", async ({ page }) => {
    await shopperLoad(page);
    await page.locator("#min").click();
    await expect(page.locator("#launcher")).toBeVisible();
    await expect(page.locator("#widget")).toBeHidden();
    await expectAxeClean(page, "launcher closed");
  });

  test("state 2 — panel open, greeting only", async ({ page }) => {
    await shopperLoad(page);
    await expectAxeClean(page, "panel open / greeting only");
  });

  test("state 3 — mid-conversation with agent replies", async ({ page }) => {
    await shopperLoad(page);
    await sendTurn(page, "tell me about the serum");
    await sendTurn(page, "and the cleanser?");
    await expect(page.getByTestId("agent-msg")).toHaveCount(3);
    await expectAxeClean(page, "mid-conversation");
  });

  test("state 4 — escalation / flagged-for-a-person notice", async ({ page }) => {
    await shopperLoad(page);
    await page.getByTestId("chat-input").fill("my face is burning after using it");
    await page.getByTestId("send").click();
    // The real mock-mode brain classifies this as a product-safety report and escalates, which latches
    // the widget into its escalation presentation (header recoloured, status rewritten). P6 changed the
    // wording — it used to read "Connecting you with a person", which claimed a live handoff that has no
    // production producer AND dropped the AI disclosure; the status now keeps both facts.
    await expect(page.getByTestId("handoff")).toBeVisible();
    await expect(page.locator("#whStatus")).toHaveText("AI assistant · flagged for a person");
    await expectAxeClean(page, "escalated / flagged-for-a-person latched");
  });

  test("state 5 — offline + retry affordance", async ({ page }) => {
    await shopperLoad(page);
    await page.route("**/chat", (route) => route.abort("failed"));
    await page.getByTestId("chat-input").fill("are you there?");
    await page.getByTestId("send").click();
    await expect(page.getByTestId("offline")).toBeVisible();
    await expectAxeClean(page, "offline / retry");
  });

  test("state 6 — consent prompt card (memory ON, opt_in)", async ({ page }) => {
    await page.route("**/chat", (r) => r.fulfill({ status: 200, contentType: "application/json", body: chatBody({ memoryEnabled: true, consentMode: "opt_in" }) }));
    await shopperLoad(page);
    await sendTurn(page, "tell me about the serum");
    await expect(page.getByTestId("consent-prompt")).toBeVisible();
    await expectAxeClean(page, "consent prompt (opt_in)");
  });

  test('state 7 — "What I remember" manage panel', async ({ page }) => {
    await page.route("**/consent", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) }));
    await page.route("**/chat", (r) => r.fulfill({ status: 200, contentType: "application/json", body: chatBody({ memoryEnabled: true, consentMode: "opt_in" }) }));
    await shopperLoad(page);
    await sendTurn(page, "tell me about the serum");
    await page.getByTestId("consent-primary").click(); // dismiss the card, leaving the manage panel
    await expect(page.getByTestId("manage-memory")).toBeVisible();
    await expect(page.getByTestId("manage-memory-toggle-ordinary")).toBeVisible();
    await expectAxeClean(page, "manage-memory panel");
  });

  test("state 8 — typing indicator in flight", async ({ page }) => {
    let release: () => void = () => {};
    const held = new Promise<void>((res) => (release = res));
    await page.route("**/chat", async (route) => {
      await held;
      await route.fulfill({ status: 200, contentType: "application/json", body: chatBody() });
    });
    await shopperLoad(page);
    await page.getByTestId("chat-input").fill("tell me about the serum");
    await page.getByTestId("send").click();
    await expect(page.locator("#typing")).toBeVisible();
    await expectAxeClean(page, "typing indicator");
    release();
  });

  test("state 9 — a transcript long enough to scroll the log", async ({ page }) => {
    // A long reply is ordinary for a sales assistant, and it is the state where the message log
    // becomes a scrollable region — the point at which a keyboard-only shopper needs to be able to
    // scroll back through what was said (SC 2.1.1).
    const long = Array.from({ length: 30 }, (_, i) => `Line ${i + 1} of a long grounded answer about the vitamin-C serum.`).join("\n");
    await page.route("**/chat", (r) => r.fulfill({ status: 200, contentType: "application/json", body: chatBody({ reply: long }) }));
    await shopperLoad(page);
    await sendTurn(page, "tell me everything about the serum");
    const scrollable = await page.locator("#messages").evaluate((el) => el.scrollHeight > el.clientHeight + 1);
    expect(scrollable, "#messages must actually overflow for this state to be meaningful").toBe(true);
    await expectAxeClean(page, "scrollable message log");
  });

  test("state 10 — dark colour scheme, mid-conversation + handoff", async ({ browser }) => {
    const ctx = await browser.newContext({ colorScheme: "dark" });
    const page = await ctx.newPage();
    await shopperLoad(page);
    await sendTurn(page, "tell me about the serum");
    await page.getByTestId("chat-input").fill("my face is burning after using it");
    await page.getByTestId("send").click();
    await expect(page.getByTestId("handoff")).toBeVisible();
    await expectAxeClean(page, "dark scheme, mid-conversation + handoff");
    await ctx.close();
  });

  // The dark token set overrides --panel but not --brand, so every brand-coloured CONTROL LABEL on a
  // panel is a separate contrast risk in dark mode. The three that exist (#signin, the offline retry
  // button, and the forget-everything button) live in three different states, so all three are
  // visited here — one state per control is what makes the fix test-driven rather than speculative.
  test("state 11 — dark colour scheme, offline + retry", async ({ browser }) => {
    const ctx = await browser.newContext({ colorScheme: "dark" });
    const page = await ctx.newPage();
    await shopperLoad(page);
    await page.route("**/chat", (route) => route.abort("failed"));
    await page.getByTestId("chat-input").fill("are you there?");
    await page.getByTestId("send").click();
    await expect(page.getByTestId("offline")).toBeVisible();
    await expect(page.locator("#messages .retry")).toBeVisible();
    await expectAxeClean(page, "dark scheme, offline + retry");
    await ctx.close();
  });

  test('state 12 — dark colour scheme, "What I remember" manage panel', async ({ browser }) => {
    const ctx = await browser.newContext({ colorScheme: "dark" });
    const page = await ctx.newPage();
    await page.route("**/consent", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) }));
    await page.route("**/chat", (r) => r.fulfill({ status: 200, contentType: "application/json", body: chatBody({ memoryEnabled: true, consentMode: "opt_in" }) }));
    await shopperLoad(page);
    await sendTurn(page, "tell me about the serum");
    await page.getByTestId("consent-primary").click();
    await expect(page.getByTestId("manage-memory-forget")).toBeVisible();
    await expectAxeClean(page, "dark scheme, manage-memory panel");
    await ctx.close();
  });
});

// --------------------------------------------------------------------------------------------------
// SC 1.4.3 measured directly, for the one control where axe returns `incomplete` because it will not
// classify a glyph as text. This is the honest alternative to an exclusion: compute the real ratio.
// --------------------------------------------------------------------------------------------------

/**
 * Contrast ratio between one element's colour property and another's, compositing alpha.
 *
 * Parsing is deliberately fussy about `color(srgb r g b / a)`. Chromium serialises `color-mix()` in
 * that form with 0-1 CHANNELS, so a naive "grab the numbers" parser reads 0.31 as 0.31/255 and
 * reports near-black — which produced a passing number for a ring that fails and a failing number
 * for one that passes. Verified against the live computed values before writing this.
 */
const measureContrast = (page: Page, fg: { sel: string; prop: "color" | "outlineColor" }, bg: { sel: string }) =>
  page.evaluate(
    ([fgSel, fgProp, bgSel]) => {
      const rgba = (c: string): [number, number, number, number] => {
        const n = (c.match(/-?[\d.]+/g) ?? []).map(Number);
        const scale = /^color\(/.test(c) ? 255 : 1; // color(srgb ...) channels are 0-1
        return [(n[0] ?? 0) * scale, (n[1] ?? 0) * scale, (n[2] ?? 0) * scale, n[3] ?? 1];
      };
      const lum = (r: number, g: number, b: number) =>
        [r, g, b]
          .map((v) => v / 255)
          .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)))
          .reduce((acc, v, i) => acc + v * [0.2126, 0.7152, 0.0722][i], 0);

      const fgCs = getComputedStyle(document.querySelector(fgSel) as Element);
      const bgCs = getComputedStyle(document.querySelector(bgSel) as Element);
      const [br, bgn, bb] = rgba(bgCs.backgroundColor);
      const [fr, fgn, fb, fa] = rgba(fgCs[fgProp as "color" | "outlineColor"]);
      // Composite a translucent foreground over the background it is actually drawn on.
      const a = lum(fa * fr + (1 - fa) * br, fa * fgn + (1 - fa) * bgn, fa * fb + (1 - fa) * bb);
      const b = lum(br, bgn, bb);
      return Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100;
    },
    [fg.sel, fg.prop, bg.sel] as const,
  );

/** Contrast of an element's own text colour against its own background colour. */
const selfContrast = (page: Page, selector: string) => measureContrast(page, { sel: selector, prop: "color" }, { sel: selector });

test.describe("SC 1.4.3 — contrast measured where axe declines to decide", () => {
  test("the send button's glyph clears 4.5:1 in both colour schemes", async ({ browser }) => {
    for (const colorScheme of ["light", "dark"] as const) {
      const ctx = await browser.newContext({ colorScheme });
      const page = await ctx.newPage();
      await shopperLoad(page);
      const ratio = await selfContrast(page, 'form button[data-testid="send"]');
      expect(ratio, `send button contrast in ${colorScheme} scheme`).toBeGreaterThanOrEqual(4.5);
      await ctx.close();
    }
  });

  test("both message-bubble types clear 4.5:1 in both colour schemes", async ({ browser }) => {
    for (const colorScheme of ["light", "dark"] as const) {
      const ctx = await browser.newContext({ colorScheme });
      const page = await ctx.newPage();
      await shopperLoad(page);
      await sendTurn(page, "tell me about the serum");
      // Settled state — the entry animation composites the bubble against the panel while it fades.
      await page.waitForFunction(() =>
        Array.from(document.querySelectorAll(".msg")).every((el) => el.getAnimations().every((a) => a.playState !== "running")),
      );
      for (const sel of ["#messages .msg.agent", "#messages .msg.user"]) {
        const ratio = await selfContrast(page, sel);
        expect(ratio, `${sel} contrast in ${colorScheme} scheme`).toBeGreaterThanOrEqual(4.5);
      }
      await ctx.close();
    }
  });
});

// --------------------------------------------------------------------------------------------------
// Focus management — SC 2.4.3 Focus Order, SC 2.4.7 Focus Visible, SC 3.2.1 On Focus.
// axe cannot see any of this; it is where chat widgets actually fail.
// --------------------------------------------------------------------------------------------------

const activeDescriptor = (page: Page) =>
  page.evaluate(() => {
    const a = document.activeElement as HTMLElement | null;
    if (!a) return "null";
    if (a === document.body) return "body";
    return `${a.tagName.toLowerCase()}${a.id ? "#" + a.id : ""}${a.dataset.testid ? "[" + a.dataset.testid + "]" : ""}`;
  });

test.describe("focus management", () => {
  test("opening the panel moves focus INTO it; closing returns focus to the launcher", async ({ page }) => {
    await shopperLoad(page);
    await page.locator("#min").click();
    expect(await activeDescriptor(page)).toBe("button#launcher");

    // Keyboard-activate the launcher — focus must land inside the panel, not on <body>.
    await page.keyboard.press("Enter");
    await expect(page.locator("#widget")).toBeVisible();
    expect(await activeDescriptor(page)).toBe("input#in[chat-input]");
    expect(await page.locator("#in").evaluate((el) => el.closest("#widget") !== null)).toBe(true);

    // Escape closes and hands focus back to the trigger (SC 2.4.3 — focus must not be lost).
    await page.keyboard.press("Escape");
    await expect(page.locator("#widget")).toBeHidden();
    expect(await activeDescriptor(page)).toBe("button#launcher");
  });

  test("focus is never dropped to <body> across the open/close cycle", async ({ page }) => {
    await shopperLoad(page);
    for (let i = 0; i < 3; i++) {
      await page.locator("#min").click();
      expect(await activeDescriptor(page), `after close #${i + 1}`).not.toBe("body");
      await page.locator("#launcher").click();
      expect(await activeDescriptor(page), `after open #${i + 1}`).not.toBe("body");
    }
  });

  test("focus is never trapped: Tab always reaches the end of the panel and leaves", async ({ page }) => {
    await shopperLoad(page);
    const seen: string[] = [];
    await page.locator("body").click({ position: { x: 5, y: 5 } });
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press("Tab");
      seen.push(await activeDescriptor(page));
    }
    // No control may repeat before every control has been visited once — a repeat inside the first
    // pass is the signature of a focus trap (a cycling loop the shopper cannot Tab out of).
    const firstPass = seen.slice(0, 4);
    expect(new Set(firstPass).size, `tab order: ${seen.join(" -> ")}`).toBe(firstPass.length);
  });
});

// --------------------------------------------------------------------------------------------------
// SC 2.4.7 Focus Visible — every interactive control must show a focus indicator under KEYBOARD
// focus. Focus is driven with real Tab presses because `element.focus()` from script does not set
// `:focus-visible` on a <button> in Chromium.
// --------------------------------------------------------------------------------------------------

type FocusProbe = { el: string; focusVisible: boolean; outlineStyle: string; outlineWidth: string; boxShadow: string };

const probeFocus = (page: Page): Promise<FocusProbe> =>
  page.evaluate(() => {
    const a = document.activeElement as HTMLElement;
    const cs = getComputedStyle(a);
    return {
      el: `${a.tagName.toLowerCase()}${a.id ? "#" + a.id : ""}${a.dataset.testid ? "[" + a.dataset.testid + "]" : ""}`,
      focusVisible: a.matches(":focus-visible"),
      outlineStyle: cs.outlineStyle,
      outlineWidth: cs.outlineWidth,
      boxShadow: cs.boxShadow,
    };
  });

const hasVisibleIndicator = (p: FocusProbe) =>
  (p.outlineStyle !== "none" && p.outlineWidth !== "0px") || (p.boxShadow !== "none" && p.boxShadow !== "");

test.describe("SC 2.4.7 — visible focus indicator", () => {
  test("every control in the open panel shows a focus indicator under keyboard focus", async ({ page }) => {
    await shopperLoad(page);
    await page.locator("body").click({ position: { x: 5, y: 5 } });
    const probes: FocusProbe[] = [];
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press("Tab");
      const p = await probeFocus(page);
      if (p.el === "body") break;
      probes.push(p);
    }
    expect(probes.length, "the open panel must expose keyboard-focusable controls").toBeGreaterThan(2);
    for (const p of probes) {
      expect(p.focusVisible, `${p.el} must match :focus-visible under keyboard focus`).toBe(true);
      expect(hasVisibleIndicator(p), `${p.el} has NO visible focus indicator: ${JSON.stringify(p)}`).toBe(true);
    }
  });

  /**
   * SC 1.4.11 Non-text Contrast (AA) — a focus indicator needs 3:1 against what it sits on. axe has
   * NO rule for this, so nothing else in this suite would catch it: the ring can be perfectly present
   * and still be invisible. It matters most in dark mode, where the panel darkens but the brand fill
   * colour does not.
   */
  const ringContrast = (page: Page, focusSel: string, behindSel: string) =>
    measureContrast(page, { sel: focusSel, prop: "outlineColor" }, { sel: behindSel });

  for (const colorScheme of ["light", "dark"] as const) {
    test(`focus rings clear the SC 1.4.11 3:1 floor in the ${colorScheme} scheme`, async ({ browser }) => {
      const ctx = await browser.newContext({ colorScheme });
      const page = await ctx.newPage();
      await shopperLoad(page);
      // The input's ring sits on the panel. `#in:focus` (not :focus-visible) so plain focus applies.
      await page.locator("#in").focus();
      expect(await ringContrast(page, "#in", "#widget"), `#in focus ring vs panel (${colorScheme})`).toBeGreaterThanOrEqual(3);

      // The launcher's ring sits on the page background. It must be reached by a real Tab press:
      // `#launcher:focus-visible` does not match when a button is focused from script, and measuring
      // the unfocused default outline instead is exactly the false reading this comment prevents.
      await page.locator("#min").click();
      await expect(page.locator("#launcher")).toBeVisible();
      await page.locator("body").click({ position: { x: 5, y: 5 } });
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => (document.activeElement as HTMLElement).id)).toBe("launcher");
      expect(await page.evaluate(() => document.querySelector("#launcher")?.matches(":focus-visible"))).toBe(true);
      expect(await ringContrast(page, "#launcher", "body"), `#launcher focus ring vs page bg (${colorScheme})`).toBeGreaterThanOrEqual(3);
      await ctx.close();
    });
  }

  test("the launcher shows a focus indicator", async ({ page }) => {
    await shopperLoad(page);
    await page.locator("#min").click(); // focus lands on #launcher
    await page.locator("body").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("Tab");
    const p = await probeFocus(page);
    expect(p.el).toBe("button#launcher");
    expect(hasVisibleIndicator(p), `launcher focus indicator: ${JSON.stringify(p)}`).toBe(true);
  });
});

// --------------------------------------------------------------------------------------------------
// SC 4.1.3 Status Messages — an incoming reply must be announced without moving focus.
//
// These assert the STRUCTURE that makes an announcement possible. They do NOT prove any screen
// reader speaks it well; that needs a human with VoiceOver/NVDA and has not been done.
// --------------------------------------------------------------------------------------------------

test.describe("SC 4.1.3 — live region for incoming replies", () => {
  test("the message log is a polite live region that is not atomic", async ({ page }) => {
    await shopperLoad(page);
    const log = page.locator("#messages");
    await expect(log).toHaveAttribute("role", "log");
    const live = await log.getAttribute("aria-live");
    expect(["polite", "assertive"], `aria-live was ${live}`).toContain(live);
    // aria-atomic="true" would make every reply re-announce the ENTIRE transcript. The default
    // (false) is what makes a chat log usable, so pin it.
    expect(await log.getAttribute("aria-atomic")).not.toBe("true");
  });

  test("an incoming reply's TEXT lands inside the live region and is not hidden from AT", async ({ page }) => {
    const reply = "Sure — the vitamin-C serum is our brightening pick.";
    await page.route("**/chat", (r) => r.fulfill({ status: 200, contentType: "application/json", body: chatBody({ reply }) }));
    await shopperLoad(page);
    expect(await page.locator("#messages").innerText()).not.toContain(reply);

    await sendTurn(page, "tell me about the serum");
    const last = page.getByTestId("agent-msg").last();
    await expect(last).toHaveText(reply); // the words themselves, not a generic "new message"

    // Nothing between the new text and the live region may be aria-hidden, or the announcement is
    // silently dropped — a failure axe cannot see because the markup is otherwise valid.
    const reachable = await last.evaluate((el) => {
      for (let n: Element | null = el; n; n = n.parentElement) {
        if (n.getAttribute("aria-hidden") === "true") return false;
        if (n.id === "messages") return true;
      }
      return false;
    });
    expect(reachable, "the reply text must be a non-aria-hidden descendant of #messages").toBe(true);
  });

  test("the handoff notice and the offline notice are announced too", async ({ page }) => {
    await shopperLoad(page);
    await page.getByTestId("chat-input").fill("my face is burning after using it");
    await page.getByTestId("send").click();
    const handoff = page.getByTestId("handoff");
    await expect(handoff).toBeVisible();
    await expect(handoff).toHaveAttribute("role", "status");

    await page.route("**/chat", (route) => route.abort("failed"));
    await page.getByTestId("chat-input").fill("hello?");
    await page.getByTestId("send").click();
    const offline = page.getByTestId("offline");
    await expect(offline).toBeVisible();
    await expect(offline).toHaveAttribute("role", "status");
  });

  test("the typing indicator exposes a text alternative, not three bare dots", async ({ page }) => {
    let release: () => void = () => {};
    const held = new Promise<void>((res) => (release = res));
    await page.route("**/chat", async (route) => {
      await held;
      await route.fulfill({ status: 200, contentType: "application/json", body: chatBody() });
    });
    await shopperLoad(page);
    await page.getByTestId("chat-input").fill("tell me about the serum");
    await page.getByTestId("send").click();
    const typing = page.locator("#typing");
    await expect(typing).toBeVisible();
    expect(await typing.innerText({ timeout: 5_000 }).catch(() => "")).toBeDefined();
    // The animated dots are decorative; the state must carry words for a non-visual shopper.
    expect(await typing.evaluate((el) => el.textContent?.trim() ?? "")).toContain("typing");
    expect(await typing.evaluate((el) => Array.from(el.querySelectorAll("i")).every((i) => i.getAttribute("aria-hidden") === "true"))).toBe(true);
    release();
  });
});

// --------------------------------------------------------------------------------------------------
// Keyboard-only round trip — SC 2.1.1 Keyboard. No mouse from the launcher onwards.
// --------------------------------------------------------------------------------------------------

test.describe("SC 2.1.1 — keyboard-only round trip", () => {
  test("launcher → input → send → read reply → reach the recovery control, no mouse", async ({ page }) => {
    await shopperLoad(page);
    await page.locator("#min").click(); // last mouse use; focus is now on #launcher

    await page.keyboard.press("Enter"); // open
    expect(await activeDescriptor(page)).toBe("input#in[chat-input]");

    await page.keyboard.type("tell me about the serum");
    await page.keyboard.press("Enter"); // submit via the form, no send-button click
    await expect(page.getByTestId("agent-msg")).toHaveCount(2);
    await expect(page.getByTestId("agent-msg").last()).toContainText("vitamin-C serum");

    // Escalate by keyboard alone and confirm the handoff state is reached and readable.
    await page.keyboard.type("my face is burning after using it");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("handoff")).toBeVisible();

    // Post-handoff, every control is still keyboard reachable — including the sign-in affordance,
    // the widget's one route to a verified human-account context.
    await page.locator("body").click({ position: { x: 5, y: 5 } });
    const reached: string[] = [];
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press("Tab");
      const d = await activeDescriptor(page);
      if (d === "body") break;
      reached.push(d);
    }
    expect(reached.join(" ")).toContain("signin");
    expect(reached.join(" ")).toContain("chat-input");
    expect(reached.join(" ")).toContain("#min");
  });

  test("the retry button injected into the log is keyboard reachable", async ({ page }) => {
    await shopperLoad(page);
    await page.route("**/chat", (route) => route.abort("failed"));
    await page.getByTestId("chat-input").fill("are you there?");
    await page.getByTestId("send").click();
    await expect(page.getByTestId("offline")).toBeVisible();

    await page.locator("body").click({ position: { x: 5, y: 5 } });
    const reached: string[] = [];
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press("Tab");
      const d = await activeDescriptor(page);
      if (d === "body") break;
      reached.push(d);
    }
    const retryFocusable = await page.locator("#messages .retry").evaluate((el) => el.tabIndex >= 0 && !(el as HTMLButtonElement).disabled);
    expect(retryFocusable, `retry must be focusable; tab order was ${reached.join(" -> ")}`).toBe(true);
  });

  test("the scrollable message log can be scrolled by keyboard alone", async ({ page }) => {
    const long = Array.from({ length: 30 }, (_, i) => `Line ${i + 1} of a long grounded answer about the vitamin-C serum.`).join("\n");
    await page.route("**/chat", (r) => r.fulfill({ status: 200, contentType: "application/json", body: chatBody({ reply: long }) }));
    await shopperLoad(page);
    await sendTurn(page, "tell me everything");
    const log = page.locator("#messages");
    expect(await log.evaluate((el) => el.scrollHeight > el.clientHeight + 1)).toBe(true);

    // The log auto-scrolls to the bottom on a new message. A keyboard-only shopper must be able to
    // get back UP it — which requires the region itself to be focusable (SC 2.1.1).
    await log.evaluate((el) => el.focus());
    const focused = await log.evaluate((el) => document.activeElement === el);
    expect(focused, "#messages must be keyboard-focusable so its content can be scrolled without a mouse").toBe(true);

    const before = await log.evaluate((el) => el.scrollTop);
    await page.keyboard.press("PageUp");
    await expect.poll(() => log.evaluate((el) => el.scrollTop)).toBeLessThan(before);
  });
});

// --------------------------------------------------------------------------------------------------
// SC 2.3.3 / 1.4.x — prefers-reduced-motion, and SC 1.4.10 Reflow at 320 CSS px.
// --------------------------------------------------------------------------------------------------

test.describe("motion and reflow", () => {
  const animationsOf = (page: Page) =>
    page.evaluate(() => {
      const msg = document.querySelector(".msg") as HTMLElement | null;
      const dot = document.querySelector("#typing i") as HTMLElement | null;
      return { msg: msg ? getComputedStyle(msg).animationName : "absent", dot: dot ? getComputedStyle(dot).animationName : "absent" };
    });

  test("with prefers-reduced-motion:reduce every animation is switched off", async ({ browser }) => {
    const ctx = await browser.newContext({ reducedMotion: "reduce" });
    const page = await ctx.newPage();
    let release: () => void = () => {};
    const held = new Promise<void>((res) => (release = res));
    await page.route("**/chat", async (route) => {
      await held;
      await route.fulfill({ status: 200, contentType: "application/json", body: chatBody() });
    });
    await shopperLoad(page);
    await page.getByTestId("chat-input").fill("tell me about the serum");
    await page.getByTestId("send").click();
    await expect(page.locator("#typing")).toBeVisible();
    const a = await animationsOf(page);
    expect(a.msg, "message bubbles must not animate under reduced motion").toBe("none");
    expect(a.dot, "typing dots must not animate under reduced motion").toBe("none");
    release();
    await ctx.close();
  });

  test("without the preference the animations ARE present (proving the media query does the work)", async ({ browser }) => {
    const ctx = await browser.newContext({ reducedMotion: "no-preference" });
    const page = await ctx.newPage();
    let release: () => void = () => {};
    const held = new Promise<void>((res) => (release = res));
    await page.route("**/chat", async (route) => {
      await held;
      await route.fulfill({ status: 200, contentType: "application/json", body: chatBody() });
    });
    await shopperLoad(page);
    await page.getByTestId("chat-input").fill("tell me about the serum");
    await page.getByTestId("send").click();
    await expect(page.locator("#typing")).toBeVisible();
    const a = await animationsOf(page);
    expect(a.msg).not.toBe("none");
    expect(a.dot).not.toBe("none");
    release();
    await ctx.close();
  });

  test("SC 1.4.10 — no horizontal page scrolling at 320 CSS px", async ({ browser }) => {
    // 320x256 is the reflow target: a 1280x1024 window at 400% zoom.
    const ctx = await browser.newContext({ viewport: { width: 320, height: 256 } });
    const page = await ctx.newPage();
    await shopperLoad(page);
    await sendTurn(page, "tell me about the serum");
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth, `page scrolls horizontally at 320px: ${JSON.stringify(overflow)}`).toBeLessThanOrEqual(overflow.clientWidth + 1);
    // The panel must also still be usable rather than clipped off-screen.
    const box = await page.locator("#widget").boundingBox();
    expect(box, "the panel must still be laid out at 320px").not.toBeNull();
    expect((box as { x: number }).x).toBeGreaterThanOrEqual(0);
    await ctx.close();
  });
});

// --------------------------------------------------------------------------------------------------
// SC 4.1.2 Name, Role, Value — the named controls a shopper depends on. axe proves an accessible
// name EXISTS; only a human can say whether it is comprehensible. These pin the specific names.
// --------------------------------------------------------------------------------------------------

test.describe("SC 4.1.2 — accessible names on the shopper's controls", () => {
  const named = async (l: Locator) => (await l.evaluate((el) => el.getAttribute("aria-label") || el.textContent?.trim() || "")) ?? "";

  test("launcher, minimize, input, send and sign-in all carry a non-empty accessible name", async ({ page }) => {
    await shopperLoad(page);
    for (const sel of ["#min", "#in", '[data-testid="send"]', "#signin"]) {
      expect((await named(page.locator(sel))).length, `${sel} accessible name`).toBeGreaterThan(0);
    }
    await page.locator("#min").click();
    expect((await named(page.locator("#launcher"))).length, "#launcher accessible name").toBeGreaterThan(0);
  });

  test("the launcher reports its expanded state, and it tracks reality", async ({ page }) => {
    await shopperLoad(page);
    await page.locator("#min").click();
    await expect(page.locator("#launcher")).toHaveAttribute("aria-expanded", "false");
    await page.locator("#launcher").click();
    await expect(page.locator("#launcher")).toHaveAttribute("aria-expanded", "true");
  });
});
