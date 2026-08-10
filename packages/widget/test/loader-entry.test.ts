// @vitest-environment jsdom
//
// I-3 — document-level single-instance guard (spec §5.2 / AC-4: "no globals except one
// namespaced init-guard (`window.__palupWidgetLoaded`); single-instance"). loader-core.ts's
// `MOUNTED_ATTR` guard is HOST-scoped, but loader-entry.ts creates a FRESH host <div> on every
// execution — so a second <script> injection (e.g. the app-embed block rendering twice) bypassed
// it and mounted two launchers + two panel iframes. This file proves the document-level guard
// stops that: a second entry-run mounts no second launcher.
import { describe, it, expect, beforeEach } from "vitest";
import { runLoaderEntry } from "../src/loader-entry.js";

declare global {
  interface Window {
    __palupWidgetLoaded?: boolean;
  }
}

beforeEach(() => {
  document.body.innerHTML = "";
  // Undo BOTH the module's own top-level self-invocation (which already ran once, at import
  // time, before any test/beforeEach existed) and whatever a previous test left behind.
  window.__palupWidgetLoaded = undefined;
});

describe("loader-entry / document-level single-instance guard", () => {
  it("sets window.__palupWidgetLoaded on the first run", () => {
    expect(window.__palupWidgetLoaded).toBeUndefined();
    runLoaderEntry();
    expect(window.__palupWidgetLoaded).toBe(true);
  });

  it("mounts exactly one host+launcher; a SECOND entry-run (simulating a 2nd <script> injection) mounts nothing more", () => {
    runLoaderEntry();
    const hostsAfterFirst = document.body.querySelectorAll("div[data-palup-host]");
    expect(hostsAfterFirst.length).toBe(1);
    const rootAfterFirst = (hostsAfterFirst[0] as any).__palupRoot as ShadowRoot;
    expect(rootAfterFirst.querySelectorAll("button").length).toBe(1);

    runLoaderEntry(); // the bug: this used to create a second host <div> + a second launcher

    const hostsAfterSecond = document.body.querySelectorAll("div[data-palup-host]");
    expect(hostsAfterSecond.length).toBe(1);
    expect(hostsAfterSecond[0]).toBe(hostsAfterFirst[0]); // same host, not a new one
  });
});
