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
    // Labeled PILL, not a bare icon: the visible text tells shoppers what it does, which invites engagement
    // (feeding memory + the attribution flywheel) without interrupting. `aria-label` carries the same words
    // so the accessible name contains the visible text (WCAG 2.5.3 Label in Name). 💬 is decorative.
    launcher.setAttribute("aria-label", "Ask the expert");
    // a11y: the launcher toggles the panel it controls, so assistive tech needs to know whether that
    // panel is currently open. Starts "false" (panel closed at mount); open()/close() below keep it in
    // sync with the SAME state their `display` toggle tracks.
    launcher.setAttribute("aria-expanded", "false");
    launcher.setAttribute(
      "style",
      "display:inline-flex;align-items:center;gap:8px;height:48px;padding:0 18px;" +
        "border-radius:999px;border:none;cursor:pointer;white-space:nowrap;line-height:1;" +
        // Evergreen (#0c4a3c) — the merchant-console brand colour, matching the panel's default --brand
        // so the launcher pill and the panel it opens read as one identity. White label on it is ~9.4:1.
        "background:#0c4a3c;color:#fff;font-size:15px;font-weight:600;box-shadow:0 6px 20px rgba(0,0,0,.25);",
    );
    launcher.textContent = "\u{1F4AC} Ask the expert"; // 💬 Ask the expert

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

    // WS10 — recolour the launcher bubble to the merchant brand (contrast-safe values resolved server-side
    // at /embed/theme). Best-effort and fail-safe: the default indigo stays until/unless the fetch succeeds,
    // and any failure (no fetch, blocked, non-200, bad shape) leaves the default — the bubble never breaks.
    const HEX6 = /^#[0-9a-f]{6}$/i;
    (function themeLauncher(): void {
      try {
        fetch(`${origin}/embed/theme?shop=${encodeURIComponent(shop)}`)
          .then((r) => (r.ok ? r.json() : null))
          .then((t: { brand?: unknown; brandInk?: unknown } | null) => {
            if (t && typeof t.brand === "string" && HEX6.test(t.brand)) {
              launcher.style.background = t.brand;
              if (typeof t.brandInk === "string" && HEX6.test(t.brandInk)) launcher.style.color = t.brandInk;
            }
          })
          .catch(() => {});
      } catch {
        /* no fetch available / blocked — keep the default indigo */
      }
    })();

    let iframe: HTMLIFrameElement | null = null;
    let destroyed = false;
    // The panel's message handler only exists after its document loads and posts `palup:ready`.
    // `panelReady` gates every loader→panel message that the panel must actually receive (see open()).
    let panelReady = false;
    let openPending = false; // an open() that happened before the panel was ready — flushed on palup:ready

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

    interface HostContext {
      cart?: { productId: string; quantity: number }[];
      pageContext?: string;
    }
    // WS4 — read the HOST page's cart + page context (window.PALUP), whitelisted to EXACTLY what /chat
    // accepts. The loader is the trust boundary: the panel runs cross-origin and cannot read the host's
    // window.PALUP, so it depends on this. Only productId + quantity ever leave the page (privacy +
    // injection floor); the server re-derives every display string from the merchant catalog. pageContext
    // is bounded to 400 chars (the server bounds it again in signals.ts).
    function readHostContext(): HostContext {
      const out: HostContext = {};
      try {
        const p = (window as unknown as { PALUP?: { cart?: unknown; pageContext?: unknown } }).PALUP || {};
        if (Array.isArray(p.cart)) {
          const items: { productId: string; quantity: number }[] = [];
          for (const e of p.cart) {
            if (!e || typeof e !== "object") continue;
            const rec = e as { productId?: unknown; quantity?: unknown };
            const pid = typeof rec.productId === "string" ? rec.productId.trim() : "";
            const q = rec.quantity;
            if (!pid || typeof q !== "number" || !Number.isInteger(q) || q < 1) continue;
            items.push({ productId: pid, quantity: q });
          }
          if (items.length) out.cart = items;
        }
        if (typeof p.pageContext === "string" && p.pageContext) out.pageContext = p.pageContext.slice(0, 400);
      } catch {
        /* best-effort — no host context this turn */
      }
      return out;
    }
    // Post host context to the panel (loader→panel, targetOrigin=origin — NEVER "*"). No-op before the
    // iframe exists; the panel re-requests it via palup:ready the first time it mounts.
    function postContext(): void {
      if (!iframe || !iframe.contentWindow) return;
      iframe.contentWindow.postMessage(Object.assign({ type: "palup:context" }, readHostContext()), origin);
    }

    // a11y: on a small viewport the panel goes full-screen (see panelStyleSheet's media query),
    // visually covering the host page — so while it's open, every OTHER direct child of
    // document.body must be `inert` (unreachable by tab/AT) or a keyboard/screen-reader user
    // could still reach content that's hidden underneath the panel. No-op on desktop/tablet,
    // where the panel is a floating card and the host page stays fully usable.
    //
    // Mount derivation: `host` (this loader's own element, passed in via cfg.host) is what must
    // stay OUT of the inert set — but a real embed may nest `host` a few levels under <body>, so
    // walk up from it to find the ancestor that IS a direct child of document.body, and exclude
    // that ancestor (not `host` itself, which may not be a body child). Falls back to `host`
    // when it isn't under document.body at all (e.g. a detached host in a test).
    function findBodyLevelMount(): Element {
      let el: Element = host;
      while (el.parentElement && el.parentElement !== document.body) {
        el = el.parentElement;
      }
      return el;
    }
    function setHostInert(on: boolean): void {
      try {
        if (!window.matchMedia || !window.matchMedia("(max-width:480px)").matches) return;
        const mount = findBodyLevelMount();
        for (const child of Array.from(document.body.children)) {
          if (child === mount) continue;
          if (on) child.setAttribute("inert", "");
          else child.removeAttribute("inert");
        }
      } catch {
        /* best-effort */
      }
    }

    function open(): void {
      if (destroyed) return;
      const el = ensureIframe();
      el.style.display = "block";
      dot.style.display = "none";
      launcher.setAttribute("aria-expanded", "true");
      // Do NOT gate on `el.contentWindow`: a freshly-created iframe has a truthy contentWindow (its
      // initial about:blank) BEFORE the panel document loads and registers its message handler, so
      // posting palup:open now would be silently dropped — and the panel's first-touch greeting
      // (sendGreeting on palup:open) would never fire. Post only once the panel has announced
      // `palup:ready`; the ready handler flushes a pending open. Re-opens after readiness post at once.
      if (panelReady) el.contentWindow?.postMessage({ type: "palup:open" }, origin);
      else openPending = true;
      setHostInert(true);
    }

    function close(): void {
      if (iframe) iframe.style.display = "none";
      launcher.setAttribute("aria-expanded", "false");
      // a11y: closing the panel (minimize, Escape, or palup:close) must not drop focus onto
      // <body> — return it to the control that opened the panel. Best-effort: focus() can
      // throw in exotic hosts (e.g. a detached launcher), never let that break close().
      try {
        launcher.focus();
      } catch {
        /* focus is best-effort */
      }
      setHostInert(false);
    }

    function onMessage(e: MessageEvent): void {
      if (destroyed) return;
      if (e.origin !== origin) return;
      if (!iframe || e.source !== iframe.contentWindow) return;

      const data = e.data as { type?: string; height?: number } | undefined;
      if (!data || typeof data.type !== "string") return;

      switch (data.type) {
        case "palup:ready":
          panelReady = true;
          iframe.contentWindow?.postMessage({ type: "palup:host", shop, position }, origin);
          postContext(); // WS4 — send the host's cart + page context alongside the host handshake
          if (openPending) {
            // the shopper opened the panel before it finished loading — deliver the deferred open now,
            // so the panel runs setOpen(true) + its first-touch greeting on this first open
            openPending = false;
            iframe.contentWindow?.postMessage({ type: "palup:open" }, origin);
          }
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
        case "palup:jointoken": {
          // Flywheel attribution (ADR-0020, Pillar 4). The PANEL mints the join token itself — it holds the
          // widget token + sessionId and is same-origin to /checkout/join-token, which derives the tenant
          // from that token (a storefront-side mint would 401 or mis-attribute). So ONLY this opaque,
          // PII-free token (randomBytes(24), shopify-webhook-identity.ts) crosses the frame boundary; the
          // sessionId never does — keeping the "no identifying data on the '*' channel" invariant intact.
          // Already origin+source validated above (e.origin===origin && e.source===iframe.contentWindow).
          // Exposed on window.PALUP for the host storefront to append to its checkout permalink
          // (?attributes[_palup_join_token]=<token> → the order's note_attributes).
          const tok = (data as { joinToken?: unknown }).joinToken;
          if (typeof tok === "string" && tok) {
            const w = window as unknown as { PALUP?: Record<string, unknown> };
            w.PALUP = w.PALUP || {};
            w.PALUP.joinToken = tok;
          }
          break;
        }
        default:
          break;
      }
    }

    window.addEventListener("message", onMessage);
    // WS4 — the host storefront dispatches `palup:contextchange` whenever its cart/page context changes;
    // forward the updated context to the panel (no-op until the panel iframe has mounted).
    const onContextChange = (): void => postContext();
    window.addEventListener("palup:contextchange", onContextChange);
    // Host-open hook: the storefront hero "Ask the expert" CTA runs on the HOST page and cannot call open()
    // directly (the LoaderApi is not exposed as a global — I-3, single namespaced guard only). It dispatches
    // a `palup:open` window CustomEvent; the loader opens the panel here, mirroring the palup:contextchange
    // host→loader pattern. Distinct channel from the loader→panel `palup:open` postMessage in open().
    const onHostOpen = (): void => open();
    window.addEventListener("palup:open", onHostOpen);

    launcher.addEventListener("click", open);

    function destroy(): void {
      destroyed = true;
      window.removeEventListener("message", onMessage);
      window.removeEventListener("palup:contextchange", onContextChange);
      window.removeEventListener("palup:open", onHostOpen);
      launcher.removeEventListener("click", open);
      host.remove();
    }

    return { open, close, destroy };
  } catch {
    return null;
  }
}
