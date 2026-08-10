// @vitest-environment jsdom
//
// Per-file environment override: the ROOT vitest.config.ts (repo root) sets the default
// environment to "node" (no DOM globals) because most packages are server-side. This test
// needs `document`/`window`/shadow DOM/iframe, so it opts into jsdom just for this file via
// the Vitest per-file pragma (must be the very first line of the file). This lets
// `pnpm test` (root runner, which globs packages/**/*.test.ts) exercise this file in jsdom
// without a separate packages/widget/vitest.config.ts or a workspace split.
import { describe, it, expect, beforeEach } from "vitest";
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
});
