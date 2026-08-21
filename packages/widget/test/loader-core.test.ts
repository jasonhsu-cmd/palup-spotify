// @vitest-environment jsdom
//
// Per-file environment override: the ROOT vitest.config.ts (repo root) sets the default
// environment to "node" (no DOM globals) because most packages are server-side. This test
// needs `document`/`window`/shadow DOM/iframe, so it opts into jsdom just for this file via
// the Vitest per-file pragma (must be the very first line of the file). This lets
// `pnpm test` (root runner, which globs packages/**/*.test.ts) exercise this file in jsdom
// without a separate packages/widget/vitest.config.ts or a workspace split.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { initWidgetLoader } from "../src/loader-core.js";

const ORIGIN = "https://widget.example";
function cfg(over = {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  return { host, shop: "acme.myshopify.com", position: "bottom-right" as const, origin: ORIGIN, ...over };
}
beforeEach(() => {
  document.body.innerHTML = "";
  // WS10 — the loader now fetches /embed/theme at mount. Stub it (rejecting by default) so no test makes a
  // real network call; the themed-launcher tests below override it. Fail-safe path keeps the default bubble.
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("no fetch in test"))));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

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
    expect(root.querySelector('button[aria-label="Ask the expert"]')).toBeTruthy();
    // The launcher is a LABELED PILL, not a bare icon: it shows a visible text label, and the accessible
    // name contains that visible text (WCAG 2.5.3 Label in Name).
    expect((root.querySelector('button[aria-label="Ask the expert"]') as HTMLButtonElement).textContent).toContain("Ask the expert");
  });

  // Host-open hook: the storefront hero "Ask the expert" CTA lives on the HOST page (a different frame/context
  // from the panel), so it can't call the loader's open() directly. It dispatches a `palup:open` window
  // CustomEvent; the loader listens on the host window and opens the panel — mirroring the existing
  // `palup:contextchange` host→loader event. (Distinct channel from the loader→panel `palup:open` postMessage.)
  it("opens the panel when the host dispatches a `palup:open` window event", () => {
    const c = cfg();
    const api = initWidgetLoader(c)!;
    const root = (c.host as any).__palupRoot as ShadowRoot;
    expect(root.querySelector("iframe")).toBeNull(); // closed at mount — no panel iframe yet
    window.dispatchEvent(new CustomEvent("palup:open"));
    const iframe = root.querySelector("iframe") as HTMLIFrameElement;
    expect(iframe).toBeTruthy();
    expect(iframe.style.display).toBe("block");
    const launcher = root.querySelector('button[aria-label="Ask the expert"]') as HTMLButtonElement;
    expect(launcher.getAttribute("aria-expanded")).toBe("true");
    api.destroy();
    // after destroy the host-open listener is removed — a later event is a no-op (never throws)
    expect(() => window.dispatchEvent(new CustomEvent("palup:open"))).not.toThrow();
  });

  it("is single-instance (second init on same host returns null)", () => {
    const c = cfg();
    expect(initWidgetLoader(c)).not.toBeNull();
    expect(initWidgetLoader(c)).toBeNull();
  });

  // a11y hardening — the launcher toggles the panel, so assistive tech needs `aria-expanded` to know
  // whether the panel it controls is currently open. Starts "false" (panel closed at mount), flips to
  // "true" on open() and back to "false" on close() — mirroring the dot/display-style toggles already
  // covered above, just via the accessible-state attribute instead of an inline style.
  it("launcher button reflects panel open/closed state via aria-expanded", () => {
    const c = cfg();
    const api = initWidgetLoader(c)!;
    const root = (c.host as any).__palupRoot as ShadowRoot;
    const launcher = root.querySelector('button[aria-label="Ask the expert"]') as HTMLButtonElement;
    expect(launcher.getAttribute("aria-expanded")).toBe("false");

    api.open();
    expect(launcher.getAttribute("aria-expanded")).toBe("true");

    api.close();
    expect(launcher.getAttribute("aria-expanded")).toBe("false");
  });

  // a11y hardening — closing the panel (minimize, Escape via palup:close, or the loader's own
  // close path) must return keyboard/AT focus to the control that opened it, so focus never
  // drops onto <body> and gets lost.
  it("returns focus to the launcher when the panel closes", () => {
    const c = cfg();
    const api = initWidgetLoader(c);
    const root = (c.host as any).__palupRoot as ShadowRoot;
    const launcher = root.querySelector('button[aria-label="Ask the expert"]') as HTMLButtonElement;
    const focusSpy = vi.spyOn(launcher, "focus");
    api!.open();
    api!.close();
    expect(focusSpy).toHaveBeenCalled();
    expect(launcher.getAttribute("aria-expanded")).toBe("false");
  });

  // a11y hardening — on a small viewport the panel goes full-screen (see the media-query test
  // below), so it visually covers the host page; the host content behind it must be `inert`
  // while open so a screen-reader/keyboard user can't tab into content hidden under the panel.
  it("inerts host content while the mobile panel is open", () => {
    (window as any).matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
    const sibling = document.createElement("div");
    document.body.appendChild(sibling);
    const c = cfg();
    const api = initWidgetLoader(c)!;
    api.open();
    expect(sibling.hasAttribute("inert")).toBe(true);
    api.close();
    expect(sibling.hasAttribute("inert")).toBe(false);
  });

  // Regression: the viewport can cross the 480px boundary WHILE the panel is open (resize,
  // orientation change). If close() re-checked matchMedia and it now reports desktop, the
  // guard would short-circuit BEFORE clearing `inert` — stranding every body-level sibling
  // `inert` (and therefore un-clickable) until a page reload. close() must always clear
  // whatever open() actually set, regardless of the CURRENT media query.
  it("clears inert on close even if the viewport crossed above 480px while the panel was open", () => {
    (window as any).matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
    const sibling = document.createElement("div");
    document.body.appendChild(sibling);
    const c = cfg();
    const api = initWidgetLoader(c)!;
    api.open();
    expect(sibling.hasAttribute("inert")).toBe(true);

    // simulate a resize/orientation-change to desktop width while the panel stays open
    (window as any).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    api.close();

    expect(sibling.hasAttribute("inert")).toBe(false);
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

    // Regression: the first open() races the panel's document load. A freshly-created iframe already has
    // a truthy `contentWindow` (its initial about:blank) BEFORE the panel script runs and registers its
    // message handler, so posting palup:open at open() time drops it silently — and the panel's
    // first-touch greeting (sendGreeting on palup:open) never fires. The loader must defer palup:open
    // until the panel announces palup:ready, then flush it.
    it("defers palup:open until the panel signals palup:ready, then flushes it (first-open greeting race)", () => {
      const c = cfg();
      const api = initWidgetLoader(c)!;
      api.open(); // panel document not loaded yet — palup:open must NOT be posted to it now
      const iframe = (c.host as any).__palupRoot.querySelector("iframe") as HTMLIFrameElement;
      const fakeWindow = stubContentWindow(iframe);
      expect(fakeWindow.postMessage).not.toHaveBeenCalled(); // nothing posted before the panel is ready

      window.dispatchEvent(
        new MessageEvent("message", { origin: ORIGIN, source: fakeWindow as any, data: { type: "palup:ready" } }),
      );

      // ready flushes BOTH the host handshake and the pending open, so the panel greets on first open
      expect(fakeWindow.postMessage).toHaveBeenCalledWith({ type: "palup:host", shop: c.shop, position: c.position }, ORIGIN);
      expect(fakeWindow.postMessage).toHaveBeenCalledWith({ type: "palup:open" }, ORIGIN);
    });

    it("posts palup:open immediately on a re-open once the panel is already ready", () => {
      const c = cfg();
      const api = initWidgetLoader(c)!;
      api.open();
      const iframe = (c.host as any).__palupRoot.querySelector("iframe") as HTMLIFrameElement;
      const fakeWindow = stubContentWindow(iframe);
      window.dispatchEvent(
        new MessageEvent("message", { origin: ORIGIN, source: fakeWindow as any, data: { type: "palup:ready" } }),
      );
      fakeWindow.postMessage.mockClear();

      api.close();
      api.open(); // panel already ready → no need to wait, post at once

      expect(fakeWindow.postMessage).toHaveBeenCalledWith({ type: "palup:open" }, ORIGIN);
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

  // WS4 — the loader forwards the HOST storefront's cart + page context to the panel over a new
  // `palup:context` message (loader→panel, targetOrigin=origin). The loader is the trust boundary: it
  // whitelists to {productId, quantity} + a bounded pageContext, because the cross-origin panel cannot read
  // the host's window.PALUP itself.
  describe("WS4 — host cart/pageContext bridge (palup:context)", () => {
    beforeEach(() => {
      delete (window as any).PALUP;
    });

    it("palup:ready → posts palup:host AND palup:context with the host's cart + pageContext", () => {
      (window as any).PALUP = { cart: [{ productId: "p1", quantity: 2 }], pageContext: "product:serum" };
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
      expect(fakeWindow.postMessage).toHaveBeenCalledWith(
        { type: "palup:context", cart: [{ productId: "p1", quantity: 2 }], pageContext: "product:serum" },
        ORIGIN,
      );
    });

    it("strips non-whitelisted cart fields — only productId + quantity leave the page", () => {
      (window as any).PALUP = { cart: [{ productId: "p1", quantity: 1, title: "secret", price: "$99" }] };
      const c = cfg();
      const api = initWidgetLoader(c)!;
      api.open();
      const iframe = (c.host as any).__palupRoot.querySelector("iframe") as HTMLIFrameElement;
      const fakeWindow = stubContentWindow(iframe);
      window.dispatchEvent(
        new MessageEvent("message", { origin: ORIGIN, source: fakeWindow as any, data: { type: "palup:ready" } }),
      );
      const ctxCall = fakeWindow.postMessage.mock.calls.find((call: any[]) => call[0]?.type === "palup:context");
      expect(ctxCall).toBeTruthy();
      expect(ctxCall![0]).toEqual({ type: "palup:context", cart: [{ productId: "p1", quantity: 1 }] });
    });

    it("palup:contextchange re-posts palup:context once the panel iframe exists", () => {
      const c = cfg();
      const api = initWidgetLoader(c)!;
      api.open();
      const iframe = (c.host as any).__palupRoot.querySelector("iframe") as HTMLIFrameElement;
      const fakeWindow = stubContentWindow(iframe);
      (window as any).PALUP = { cart: [{ productId: "p2", quantity: 3 }], pageContext: "cart" };
      window.dispatchEvent(new CustomEvent("palup:contextchange"));
      expect(fakeWindow.postMessage).toHaveBeenCalledWith(
        { type: "palup:context", cart: [{ productId: "p2", quantity: 3 }], pageContext: "cart" },
        ORIGIN,
      );
    });

    it("palup:contextchange before the panel opens is a no-op (no iframe yet, never throws)", () => {
      const c = cfg();
      initWidgetLoader(c);
      (window as any).PALUP = { cart: [{ productId: "p3", quantity: 1 }] };
      expect(() => window.dispatchEvent(new CustomEvent("palup:contextchange"))).not.toThrow();
    });
  });

  // WS10 — the launcher bubble recolours to the merchant brand via GET /embed/theme (contrast-safe values
  // resolved server-side). Best-effort: any failure leaves the default indigo.
  describe("WS10 — themed launcher", () => {
    const flush = () => new Promise((r) => setTimeout(r, 0));

    it("recolours the launcher bubble from GET /embed/theme (brand + ink)", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({ ok: true, json: async () => ({ brand: "#a44a34", brandInk: "#000000" }) })),
      );
      const c = cfg();
      initWidgetLoader(c);
      expect(fetch).toHaveBeenCalledWith(`${ORIGIN}/embed/theme?shop=acme.myshopify.com`);
      const root = (c.host as any).__palupRoot as ShadowRoot;
      const launcher = root.querySelector('button[aria-label="Ask the expert"]') as HTMLButtonElement;
      await flush();
      // jsdom serialises to rgb(); accept either the hex or the rgb form of the terracotta brand.
      expect(launcher.style.background).toMatch(/164|a44a34/i);
    });

    it("keeps the default evergreen bubble when the theme fetch fails (fail-safe)", async () => {
      // beforeEach already stubbed a rejecting fetch.
      const c = cfg();
      initWidgetLoader(c);
      const root = (c.host as any).__palupRoot as ShadowRoot;
      const launcher = root.querySelector('button[aria-label="Ask the expert"]') as HTMLButtonElement;
      await flush();
      expect(launcher.style.background).toMatch(/0c4a3c|12,\s*74,\s*60/i); // #0c4a3c / rgb(12,74,60) — console evergreen, unchanged
    });

    it("ignores a non-hex brand from the theme endpoint (never a broken/injected colour)", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({ ok: true, json: async () => ({ brand: "red; content:url(evil)", brandInk: "#fff" }) })),
      );
      const c = cfg();
      initWidgetLoader(c);
      const root = (c.host as any).__palupRoot as ShadowRoot;
      const launcher = root.querySelector('button[aria-label="Ask the expert"]') as HTMLButtonElement;
      await flush();
      expect(launcher.style.background).toMatch(/0c4a3c|12,\s*74,\s*60/i); // rejected → default evergreen kept
    });
  });

  // Pillar 4 (flywheel attribution): the PANEL mints the opaque join token and hands it out via
  // palup:jointoken; the loader exposes it on window.PALUP.joinToken for the host storefront to append to
  // its checkout permalink. The sessionId never crosses. These pin the loader half — a valid write, the
  // foreign-origin reject (same guard as every other inbound message), and junk-token rejection.
  describe("palup:jointoken → window.PALUP.joinToken (Pillar 4 attribution bridge)", () => {
    afterEach(() => { delete (window as unknown as { PALUP?: unknown }).PALUP; });

    it("writes a valid same-origin palup:jointoken onto window.PALUP.joinToken", () => {
      const c = cfg();
      const api = initWidgetLoader(c)!;
      api.open();
      const iframe = (c.host as any).__palupRoot.querySelector("iframe") as HTMLIFrameElement;
      const fakeWindow = stubContentWindow(iframe);
      window.dispatchEvent(
        new MessageEvent("message", { origin: ORIGIN, source: fakeWindow as any, data: { type: "palup:jointoken", joinToken: "jt_opaque_123" } }),
      );
      expect((window as unknown as { PALUP?: { joinToken?: string } }).PALUP?.joinToken).toBe("jt_opaque_123");
    });

    it("ignores a palup:jointoken from a FOREIGN origin (never writes window.PALUP.joinToken)", () => {
      const c = cfg();
      const api = initWidgetLoader(c)!;
      api.open();
      const iframe = (c.host as any).__palupRoot.querySelector("iframe") as HTMLIFrameElement;
      stubContentWindow(iframe);
      window.dispatchEvent(
        new MessageEvent("message", { origin: "https://evil.example", source: {} as any, data: { type: "palup:jointoken", joinToken: "jt_evil" } }),
      );
      expect((window as unknown as { PALUP?: { joinToken?: string } }).PALUP?.joinToken).toBeUndefined();
    });

    it("ignores a palup:jointoken with a non-string or empty token", () => {
      const c = cfg();
      const api = initWidgetLoader(c)!;
      api.open();
      const iframe = (c.host as any).__palupRoot.querySelector("iframe") as HTMLIFrameElement;
      const fakeWindow = stubContentWindow(iframe);
      window.dispatchEvent(
        new MessageEvent("message", { origin: ORIGIN, source: fakeWindow as any, data: { type: "palup:jointoken", joinToken: 12345 } }),
      );
      window.dispatchEvent(
        new MessageEvent("message", { origin: ORIGIN, source: fakeWindow as any, data: { type: "palup:jointoken", joinToken: "" } }),
      );
      expect((window as unknown as { PALUP?: { joinToken?: string } }).PALUP?.joinToken).toBeUndefined();
    });
  });
});
