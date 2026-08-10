// Loader CORE — vanilla-DOM logic for the embeddable widget launcher.
//
// Renders a launcher button in a CLOSED shadow root on the given host element, and lazily
// mounts the widget panel <iframe> the first time the shopper opens it. Brokers a
// postMessage protocol between the host page and the panel iframe (which is served from a
// different origin — `cfg.origin` — so all message traffic is origin- and source-checked).
//
// Dependency-free: no imports beyond the DOM lib. A later task injects this on merchant
// storefronts (script tag → calls initWidgetLoader with the merchant's shop + origin).

export interface LoaderConfig {
  host: HTMLElement;
  shop: string;
  position: "bottom-right" | "bottom-left";
  origin: string;
}

export interface LoaderApi {
  open(): void;
  close(): void;
  destroy(): void;
}

const MOUNTED_ATTR = "data-palup-mounted";
const HOST_ATTR = "data-palup-host";

// Test-only seam: the shadow root is `mode: "closed"`, so `host.shadowRoot` is always null
// and tests have no other way to reach into it. We stash the live ShadowRoot on the host as
// a NON-ENUMERABLE own property so `(host as any).__palupRoot` works in tests without
// exposing it via `Object.keys`/JSON/enumeration in production. Never read by app code.
declare global {
  interface HTMLElement {
    __palupRoot?: ShadowRoot;
  }
}

function positionStyle(position: LoaderConfig["position"]): string {
  const side = position === "bottom-left" ? "left:20px;" : "right:20px;";
  return `position:fixed;bottom:20px;${side}z-index:2147483000;`;
}

// I-4 fix (spec §5.2 "small-viewport ⇒ full-screen"): the panel iframe's LAYOUT lives in a
// class-based stylesheet (not inline style) so a media query can override it. Desktop/tablet
// keeps the floating 380px card; a small viewport (phone) goes full-screen instead of clipping
// off the screen edge. Scoped to this shadow root only — never leaks into the merchant page.
function panelStyleSheet(position: LoaderConfig["position"]): string {
  const side = position === "bottom-left" ? "left:20px;" : "right:20px;";
  return (
    `.palup-panel-iframe{position:fixed;bottom:88px;${side}` +
    "width:380px;height:600px;max-height:80vh;border:none;border-radius:16px;" +
    "box-shadow:0 12px 40px rgba(0,0,0,.3);z-index:2147483000;}" +
    "@media (max-width:480px){.palup-panel-iframe{inset:0;top:0;left:0;right:0;bottom:0;" +
    "width:100vw;height:100dvh;max-height:none;border-radius:0;box-shadow:none;}}"
  );
}

export function initWidgetLoader(cfg: LoaderConfig): LoaderApi | null {
  try {
    const { host, shop, position, origin } = cfg;

    if (!host || typeof host.getAttribute !== "function") return null;
    if (host.getAttribute(MOUNTED_ATTR) === "true") return null;

    const root = host.attachShadow({ mode: "closed" });
    Object.defineProperty(host, "__palupRoot", {
      value: root,
      enumerable: false,
      configurable: true,
    });

    host.setAttribute(MOUNTED_ATTR, "true");
    host.setAttribute(HOST_ATTR, "");

    const wrapper = document.createElement("div");
    wrapper.setAttribute("style", positionStyle(position));

    const launcher = document.createElement("button");
    launcher.type = "button";
    launcher.setAttribute("aria-label", "Open chat");
    launcher.setAttribute(
      "style",
      "width:56px;height:56px;border-radius:50%;border:none;cursor:pointer;" +
        "background:#4f46e5;color:#fff;font-size:20px;box-shadow:0 6px 20px rgba(0,0,0,.25);",
    );
    launcher.textContent = "\u{1F4AC}"; // 💬

    const dot = document.createElement("span");
    dot.setAttribute(
      "style",
      "position:absolute;top:-2px;right:-2px;width:12px;height:12px;border-radius:50%;" +
        "background:#ef4444;display:none;",
    );

    const launcherBox = document.createElement("div");
    launcherBox.setAttribute("style", "position:relative;display:inline-block;");
    launcherBox.appendChild(launcher);
    launcherBox.appendChild(dot);
    wrapper.appendChild(launcherBox);
    root.appendChild(wrapper);

    const style = document.createElement("style");
    style.textContent = panelStyleSheet(position);
    root.appendChild(style);

    let iframe: HTMLIFrameElement | null = null;
    let destroyed = false;

    function ensureIframe(): HTMLIFrameElement {
      if (iframe) return iframe;
      const el = document.createElement("iframe");
      el.title = "Chat";
      el.className = "palup-panel-iframe"; // layout (incl. the small-viewport media query) lives in `style` above
      el.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms");
      el.style.display = "none"; // only `display` is inline; open()/close() toggle just this property
      el.src = `${origin}/embed/panel?shop=${encodeURIComponent(shop)}`;
      root.appendChild(el);
      iframe = el;
      return el;
    }

    function open(): void {
      if (destroyed) return;
      const el = ensureIframe();
      el.style.display = "block";
      dot.style.display = "none";
      const send = () => el.contentWindow?.postMessage({ type: "palup:open" }, origin);
      if (el.contentWindow) send();
      else el.addEventListener("load", send, { once: true });
    }

    function close(): void {
      if (iframe) iframe.style.display = "none";
    }

    function onMessage(e: MessageEvent): void {
      if (destroyed) return;
      if (e.origin !== origin) return;
      if (!iframe || e.source !== iframe.contentWindow) return;

      const data = e.data as { type?: string; height?: number } | undefined;
      if (!data || typeof data.type !== "string") return;

      switch (data.type) {
        case "palup:ready":
          iframe.contentWindow?.postMessage({ type: "palup:host", shop, position }, origin);
          break;
        case "palup:resize":
          if (typeof data.height === "number") {
            iframe.style.height = `${data.height}px`;
          }
          break;
        case "palup:close":
          close();
          break;
        case "palup:unread":
          // I-2 fix: ALWAYS show the dot — the panel sends one `palup:unread` per buffered
          // agent message while minimized, so toggling on parity hid the dot again on the
          // 2nd message. `open()` above is the only place that clears it back to "none".
          dot.style.display = "block";
          break;
        default:
          break;
      }
    }

    window.addEventListener("message", onMessage);

    launcher.addEventListener("click", open);

    function destroy(): void {
      destroyed = true;
      window.removeEventListener("message", onMessage);
      launcher.removeEventListener("click", open);
      host.remove();
    }

    return { open, close, destroy };
  } catch {
    return null;
  }
}
