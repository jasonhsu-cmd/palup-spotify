import { initWidgetLoader } from "./loader-core.js";

(function () {
  try {
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
})();
