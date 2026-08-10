import { initWidgetLoader } from "./loader-core.js";

// I-3 fix (spec §5.2): "no globals except one namespaced init-guard (`window.__palupWidgetLoaded`);
// single-instance." loader-core's MOUNTED_ATTR guard is HOST-scoped, but this entry creates a
// FRESH host <div> on every run — so a second <script> injection (e.g. the app-embed block
// rendering twice) bypassed it and mounted two launchers + two panel iframes. Guard at the
// document level, before the host is ever created.
declare global {
  interface Window {
    __palupWidgetLoaded?: boolean;
  }
}

// Exported (not just an anonymous IIFE) so a test can simulate a SECOND <script> execution by
// calling this directly — the real bundle still self-invokes it once below either way.
export function runLoaderEntry(): void {
  try {
    if (window.__palupWidgetLoaded) return;
    window.__palupWidgetLoaded = true;

    const s = document.currentScript as HTMLScriptElement | null;
    const shop = s?.dataset.shop || "";
    const position = s?.dataset.position === "bottom-left" ? "bottom-left" : "bottom-right";
    const origin = s ? new URL(s.src).origin : location.origin;
    const host = document.createElement("div");
    document.body.appendChild(host);
    initWidgetLoader({ host, shop, position, origin });
  } catch {
    /* fail-safe: never break the merchant page */
  }
}

runLoaderEntry();
