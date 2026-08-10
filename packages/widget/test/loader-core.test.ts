// @vitest-environment jsdom
//
// Per-file environment override: the ROOT vitest.config.ts (repo root) sets the default
// environment to "node" (no DOM globals) because most packages are server-side. This test
// needs `document`/`window`/shadow DOM/iframe, so it opts into jsdom just for this file via
// the Vitest per-file pragma (must be the very first line of the file). This lets
// `pnpm test` (root runner, which globs packages/**/*.test.ts) exercise this file in jsdom
// without a separate packages/widget/vitest.config.ts or a workspace split.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { initWidgetLoader } from "../src/loader-core.js";

const ORIGIN = "https://widget.example";
function cfg(over = {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  return { host, shop: "acme.myshopify.com", position: "bottom-right" as const, origin: ORIGIN, ...over };
}
beforeEach(() => { document.body.innerHTML = ""; });

describe("initWidgetLoader", () => {
  it("runs in a real DOM (sanity check for the jsdom pragma)", () => {
    expect(typeof document).toBe("object");
    expect(document.createElement("div")).toBeInstanceOf(HTMLElement);
  });

  it("mounts exactly one launcher in a CLOSED shadow root", () => {
    const c = cfg();
    const api = initWidgetLoader(c);
    expect(api).not.toBeNull();
    // closed shadow root ⇒ c.host.shadowRoot is null (encapsulated)...
    expect(c.host.shadowRoot).toBeNull();
    // ...and per DOM spec, shadow content NEVER appears in host.childNodes (open or closed —
    // that's the whole point of encapsulation; verified directly against jsdom before writing
    // this). The brief's literal `c.host.childNodes.length` can't pass for any spec-compliant
    // implementation, so we assert the same intent via the documented test seam instead of
    // weakening the check — and we assert the ACTUAL launcher, not just "something was
    // appended": exactly one <button>, with the accessible name the launcher is required to
    // have (see the e2e seam in the impl).
    expect(c.host.childNodes.length).toBe(0);
    const root = (c.host as any).__palupRoot as ShadowRoot;
    expect(root.querySelectorAll("button").length).toBe(1);
    expect(root.querySelector('button[aria-label="Open chat"]')).toBeTruthy();
  });

  it("is single-instance (second init on same host returns null)", () => {
    const c = cfg();
    expect(initWidgetLoader(c)).not.toBeNull();
    expect(initWidgetLoader(c)).toBeNull();
  });

  it("mounts the panel iframe only on open, pointing at origin/embed/panel?shop=", () => {
    const c = cfg();
    const api = initWidgetLoader(c)!;
    // grab the shadow root via a test seam (see impl: host.__palupRoot, non-enumerable, test-only)
    api.open();
    const iframe = (c.host as any).__palupRoot.querySelector("iframe") as HTMLIFrameElement;
    expect(iframe).toBeTruthy();
    expect(iframe.src).toBe(`${ORIGIN}/embed/panel?shop=acme.myshopify.com`);
  });

  it("ignores a postMessage from a foreign origin", () => {
    const c = cfg();
    const api = initWidgetLoader(c)!;
    api.open();
    // a resize from a hostile origin must NOT resize the iframe
    const iframe = (c.host as any).__palupRoot.querySelector("iframe") as HTMLIFrameElement;
    window.dispatchEvent(new MessageEvent("message", { origin: "https://evil.example", data: { type: "palup:resize", height: 999 } }));
    expect(iframe.style.height).not.toContain("999");
  });

  it("fail-safe: returns null instead of throwing when host is missing", () => {
    expect(initWidgetLoader({ ...cfg(), host: undefined as any })).toBeNull();
  });

  // I-4 — small-viewport handling (spec §5.2: "small-viewport ⇒ full-screen"). The panel iframe's
  // layout now lives in a shadow-root <style> (so a media query can override it); assert the
  // injected rule covers both the floating desktop card AND the full-screen small-viewport override.
  it("injects a small-viewport full-screen media-query rule for the panel iframe, alongside the floating desktop layout", () => {
    const c = cfg();
    initWidgetLoader(c);
    const root = (c.host as any).__palupRoot as ShadowRoot;
    const style = root.querySelector("style");
    expect(style).toBeTruthy();
    const css = style!.textContent || "";
    // desktop/tablet: the floating 380px card is unconditional (outside any media query)
    expect(css).toContain(".palup-panel-iframe{position:fixed;");
    expect(css).toContain("width:380px");
    expect(css).toContain("height:600px");
    // small viewport: a media query overrides to full-screen
    expect(css).toMatch(/@media \(max-width:\s*480px\)/);
    expect(css).toContain("width:100vw");
    expect(css).toContain("height:100dvh");
    expect(css).toContain("border-radius:0");
  });

  // M-2 — positive-path message-handler coverage (this is where the I-2 unread-dot bug hid: every
  // existing test before this fix only exercised the NEGATIVE path — a rejected foreign-origin
  // message). Each event below sets BOTH `origin` and `source` to the values onMessage actually
  // checks (`e.origin !== origin` / `e.source !== iframe.contentWindow` in loader-core.ts) so valid
  // messages reach the switch statement.
  //
  // jsdom (v30, verified empirically) never populates `contentWindow` for an <iframe> mounted
  // inside a shadow root — a jsdom gap, not a production behavior (real browsers do populate it).
  // We stub a real, non-null window-like object as the iframe's `contentWindow` so these tests
  // exercise the SAME identity check `onMessage` runs in production, rather than the two sides
  // incidentally both being `null`.
  function stubContentWindow(iframe: HTMLIFrameElement): { postMessage: ReturnType<typeof vi.fn> } {
    const fakeWindow = { postMessage: vi.fn() };
    Object.defineProperty(iframe, "contentWindow", { value: fakeWindow, configurable: true });
    return fakeWindow;
  }

  describe("valid same-origin postMessage handling", () => {
    it("palup:ready → replies on the panel's contentWindow with palup:host {shop, position}", () => {
      const c = cfg();
      const api = initWidgetLoader(c)!;
      api.open();
      const iframe = (c.host as any).__palupRoot.querySelector("iframe") as HTMLIFrameElement;
      const fakeWindow = stubContentWindow(iframe);

      window.dispatchEvent(
        new MessageEvent("message", { origin: ORIGIN, source: fakeWindow as any, data: { type: "palup:ready" } }),
      );

      expect(fakeWindow.postMessage).toHaveBeenCalledWith(
        { type: "palup:host", shop: c.shop, position: c.position },
        ORIGIN,
      );
    });

    it("palup:close → hides the panel iframe", () => {
      const c = cfg();
      const api = initWidgetLoader(c)!;
      api.open();
      const iframe = (c.host as any).__palupRoot.querySelector("iframe") as HTMLIFrameElement;
      const fakeWindow = stubContentWindow(iframe);
      expect(iframe.style.display).toBe("block");

      window.dispatchEvent(
        new MessageEvent("message", { origin: ORIGIN, source: fakeWindow as any, data: { type: "palup:close" } }),
      );

      expect(iframe.style.display).toBe("none");
    });

    it("palup:unread → shows the dot, and it STAYS shown after a second buffered message (I-2 regression guard)", () => {
      const c = cfg();
      const api = initWidgetLoader(c)!;
      api.open(); // mounts the iframe and resets the dot to "none"
      const iframe = (c.host as any).__palupRoot.querySelector("iframe") as HTMLIFrameElement;
      const fakeWindow = stubContentWindow(iframe);
      const dot = (c.host as any).__palupRoot.querySelector("span") as HTMLElement;
      expect(dot.style.display).toBe("none");

      const postUnread = (count: number) =>
        window.dispatchEvent(
          new MessageEvent("message", {
            origin: ORIGIN,
            source: fakeWindow as any,
            data: { type: "palup:unread", count },
          }),
        );

      postUnread(1);
      expect(dot.style.display).toBe("block");

      // The BUG (I-2): toggling on parity would hide the dot again here, on the 2nd message.
      postUnread(2);
      expect(dot.style.display).toBe("block");
    });
  });
});
