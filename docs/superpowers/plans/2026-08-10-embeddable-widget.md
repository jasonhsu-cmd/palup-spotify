# Embeddable Shopper Widget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a Shopify merchant install the app, toggle it on in their theme editor, and have the AI sales widget appear on their storefront answering their shoppers — with the shopper's token/conversation isolated in an iframe from our origin.

**Architecture:** A theme app extension (app-embed block) injects a small `loader.js` on every storefront page. The loader renders a launcher in a **closed shadow root** and, on open, lazily mounts a **panel `<iframe>`** served from our origin (`/embed/panel`) — the existing widget UI, which does the unchanged mint→`/chat` flow. Tenant is resolved by shop domain (reusing `merchants.tenantForShopDomain`), not an embed key.

**Tech Stack:** TypeScript, Fastify (widget-backend), vanilla-DOM loader bundled with esbuild (IIFE), vitest + jsdom (unit), Playwright (e2e), Shopify theme app extension (Liquid).

**Spec:** `docs/superpowers/specs/2026-08-10-embeddable-widget-design.md`

## Global Constraints

- **Portability (NN#3):** no provider SDK in feature code; cloud access via ports. (Embed routes use only Fastify + the existing `merchants`/`store` ports.)
- **Isolation:** the panel token/conversation must stay in our origin; the loader must never throw into the merchant page (fail-safe).
- **Reuse, don't fork:** reuse the mint→`/chat` pipeline and `packages/widget/public/index.html` unchanged except the documented panel-mode additions. One panel file serves both `/` (standalone demo, embed-key path) and `/embed/panel` (panel mode, shop path).
- **Tenant routing = public trust model:** the widget token is a short-TTL, tenant-scoped, rate-limited public shopper credential; client-claimed `shop` is acceptable (same as the embed key).
- **CI gate:** every task ends green under `env -u GOOGLE_CLOUD_PROJECT pnpm typecheck` + the relevant `pnpm vitest run <file>`; the full `merge-gate.sh` runs before the PR merges. Never set `GOOGLE_CLOUD_PROJECT` for tests.
- **Commit style:** Conventional Commits; end with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Branch off `main`; the merge-gate script is the merge path.
- **security-reviewer must pass** before merge (new internet-reachable `/embed/*` routes, `frame-ancestors` CSP, client-claimed `?shop=` tenant routing).

## File Structure

**Create:**
- `packages/widget/src/loader-core.ts` — testable loader functions (launcher, panel mount, postMessage broker, fail-safe).
- `packages/widget/src/loader-entry.ts` — IIFE entry: reads the `<script>` tag config → `initWidgetLoader`.
- `packages/widget/test/loader-core.test.ts` — jsdom unit tests.
- `packages/widget/test/app-embed-liquid.test.ts` — Liquid source-shape test.
- `packages/widget/vitest.config.ts` — jsdom environment for this package's tests.
- `packages/widget-backend/src/routes/embed.ts` — `registerEmbedRoutes` + `bundleLoader()` (esbuild) + panel CSP.
- `packages/widget-backend/test/embed-routes.test.ts` — route + `?shop=` mint tests.
- `extensions/palup-widget/shopify.extension.toml` + `extensions/palup-widget/blocks/app-embed.liquid`.
- `e2e/tests/embed.spec.ts` + `e2e/fixtures/embed-host.html` — Playwright round-trip.

**Modify:**
- `packages/widget-backend/src/server.ts` — mint `?shop=` branch; call `registerEmbedRoutes`.
- `packages/widget/public/index.html` — panel mode (shop-param mint + hide launcher + postMessage).
- `packages/widget-backend/package.json` — add `esbuild`.

---

## Task 1: `?shop=` tenant resolution on the mint route

**Files:**
- Modify: `packages/widget-backend/src/server.ts` (the `/widget/token` handler, ~`:1090-1098`)
- Test: `packages/widget-backend/test/embed-routes.test.ts`

**Interfaces:**
- Consumes: `merchants.tenantForShopDomain(shopDomain: unknown): Promise<TenantResolution>` (`merchant-resolver.ts:254`); `merchants.resolveEmbedKey(key, surface)` (existing); `mintWidgetToken(secret, tenantId, ttl)` (existing import).
- Produces: `/widget/token` accepts `?shop=` (resolved by domain) OR `?key=` (existing); same 401 on any non-`ok`.

- [ ] **Step 1: Write the failing test**

Mirror the harness in `packages/widget-backend/test/shopify-webhook-routes.test.ts` (it builds the server with `buildServer` + `PALUP_SECRETS`/`SHOPIFY_STORES`/registry). Add:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { InMemoryRuntimeStore, createInMemoryMerchantRegistry, createInMemoryVectorStore } from "@palup/platform-ports";
import { buildServer } from "../src/server.js";

const ENV = ["WIDGET_EMBED_KEYS", "SHOPIFY_STORES", "GUEST_TOKEN_SECRET"];
afterEach(() => ENV.forEach((k) => delete process.env[k]));

async function server(over: Record<string, string> = {}) {
  process.env.WIDGET_EMBED_KEYS = '{"demo-embed-key":"demo"}';
  process.env.SHOPIFY_STORES = '{"demo":"acme.myshopify.com"}';
  for (const [k, v] of Object.entries(over)) process.env[k] = v;
  return buildServer({ store: new InMemoryRuntimeStore(), merchantRegistry: createInMemoryMerchantRegistry(), vectorPort: createInMemoryVectorStore() });
}

describe("mint by shop domain", () => {
  it("mints a token for a known shop domain (?shop=)", async () => {
    const app = await server();
    const res = await app.inject({ method: "GET", url: "/widget/token?shop=acme.myshopify.com" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).token).toBeTruthy();
    await app.close();
  });
  it("401s an unknown shop domain", async () => {
    const app = await server();
    const res = await app.inject({ method: "GET", url: "/widget/token?shop=stranger.myshopify.com" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
  it("still mints via ?key= (unchanged)", async () => {
    const app = await server();
    const res = await app.inject({ method: "GET", url: "/widget/token?key=demo-embed-key" });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});
```

> Note: confirm `SHOPIFY_STORES`/`WIDGET_TOKEN_SECRET` wiring in the harness by reading how `deploy-staging.yml` + `server.ts` set the demo tenant; adjust the env map keys to whatever `tenantForShopDomain` matches against (read `merchant-resolver.ts:567`). If `WIDGET_TOKEN_SECRET` must be set for a non-401 mint, add it to `over`.

- [ ] **Step 2: Run it, verify the `?shop=` cases FAIL**

Run: `env -u GOOGLE_CLOUD_PROJECT pnpm vitest run packages/widget-backend/test/embed-routes.test.ts`
Expected: the two `?shop=` tests fail (currently the route ignores `shop`), `?key=` passes.

- [ ] **Step 3: Add the `?shop=` branch to the mint handler**

In the `/widget/token` handler, before the `key` resolution, add:

```ts
const q = req.query as { key?: string; shop?: string };
const resolved = q.shop
  ? await merchants.tenantForShopDomain(q.shop)
  : await merchants.resolveEmbedKey(q.key, "embed-key-mint");
```
(Keep the existing `if (resolved.kind !== "ok" || !WIDGET_TOKEN_SECRET) { 401 }` + mint line unchanged.)

- [ ] **Step 4: Run tests, verify all pass**

Run: `env -u GOOGLE_CLOUD_PROJECT pnpm vitest run packages/widget-backend/test/embed-routes.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
env -u GOOGLE_CLOUD_PROJECT pnpm typecheck
git add packages/widget-backend/src/server.ts packages/widget-backend/test/embed-routes.test.ts
git commit -m "feat(widget-backend): mint a widget token by shop domain (?shop=)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: loader core (shadow launcher + panel mount + postMessage), TDD

**Files:**
- Create: `packages/widget/src/loader-core.ts`, `packages/widget/vitest.config.ts`
- Test: `packages/widget/test/loader-core.test.ts`

**Interfaces:**
- Produces:
  - `interface LoaderConfig { host: HTMLElement; shop: string; position: "bottom-right" | "bottom-left"; origin: string }`
  - `initWidgetLoader(cfg: LoaderConfig): { open(): void; close(): void; destroy(): void } | null` — mounts once; returns `null` if already mounted (single-instance) or on failure (fail-safe).

- [ ] **Step 1: jsdom vitest config**

Create `packages/widget/vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { environment: "jsdom", include: ["test/**/*.test.ts"] } });
```
Confirm `jsdom` resolves (it's a common dev dep; if missing, add `jsdom` to `packages/widget/package.json` devDependencies and `pnpm install`).

- [ ] **Step 2: Write the failing tests**

`packages/widget/test/loader-core.test.ts`:
```ts
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
  it("mounts exactly one launcher in a CLOSED shadow root", () => {
    const c = cfg();
    const api = initWidgetLoader(c);
    expect(api).not.toBeNull();
    // closed shadow root ⇒ c.host.shadowRoot is null, but the host has a child
    expect(c.host.shadowRoot).toBeNull();
    expect(c.host.childNodes.length).toBeGreaterThan(0);
  });
  it("is single-instance (second init on same host returns null)", () => {
    const c = cfg();
    expect(initWidgetLoader(c)).not.toBeNull();
    expect(initWidgetLoader(c)).toBeNull();
  });
  it("mounts the panel iframe only on open, pointing at origin/embed/panel?shop=", () => {
    const c = cfg();
    const api = initWidgetLoader(c)!;
    // grab the shadow root via a test seam (see impl: cfg.host.__palupShadow in test builds) OR assert via open()
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
```

> The `(host as any).__palupRoot` is a deliberate test seam: since the shadow root is closed, the impl stashes a non-enumerable reference on the host for tests. Document it in the impl as test-only.

- [ ] **Step 3: Run, verify FAIL**

Run: `env -u GOOGLE_CLOUD_PROJECT pnpm vitest run packages/widget/test/loader-core.test.ts`
Expected: FAIL ("initWidgetLoader is not a function").

- [ ] **Step 4: Implement `loader-core.ts`**

Write `packages/widget/src/loader-core.ts` implementing:
- single-instance via a `data-palup-mounted` attr on the host (return `null` if present).
- `attachShadow({ mode: "closed" })`; stash the root on `host.__palupRoot` (non-enumerable) for tests.
- launcher button (fixed, `position`-based inline styles) + click → `open()`.
- `open()`: lazily create the iframe `\`${origin}/embed/panel?shop=${encodeURIComponent(shop)}\`` with `sandbox="allow-scripts allow-same-origin allow-forms"`, `title="Chat"`; reveal it; postMessage `{type:"palup:open"}` to `iframe.contentWindow` once loaded.
- a single `message` listener: `if (e.origin !== origin || e.source !== iframe?.contentWindow) return;` then switch on `e.data.type`: `palup:ready`→post `{type:"palup:host",shop,position}`; `palup:resize`→set iframe height; `palup:close`→`close()`; `palup:unread`→toggle dot.
- `close()` hides the iframe; `destroy()` removes host + listener.
- Wrap the whole body in try/catch → return `null` on any throw.

Keep it dependency-free vanilla DOM. ~150 lines.

- [ ] **Step 5: Run, verify PASS**

Run: `env -u GOOGLE_CLOUD_PROJECT pnpm vitest run packages/widget/test/loader-core.test.ts`
Expected: PASS. Iterate the impl until green.

- [ ] **Step 6: Typecheck + commit**

```bash
env -u GOOGLE_CLOUD_PROJECT pnpm typecheck
git add packages/widget/src/loader-core.ts packages/widget/test/loader-core.test.ts packages/widget/vitest.config.ts packages/widget/package.json
git commit -m "feat(widget): loader core — shadow launcher + iframe panel + postMessage broker

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: loader entry + `GET /embed/loader.js` (esbuild boot-bundle)

**Files:**
- Create: `packages/widget/src/loader-entry.ts`, `packages/widget-backend/src/routes/embed.ts`
- Modify: `packages/widget-backend/package.json` (add `esbuild`), `packages/widget-backend/src/server.ts` (call `registerEmbedRoutes`)
- Test: `packages/widget-backend/test/embed-routes.test.ts`

**Interfaces:**
- Produces: `registerEmbedRoutes(app: FastifyInstance, deps: { loaderJs: string; panelHtml: string; frameAncestors: (shop: string | undefined) => string }): void`; `bundleLoader(): Promise<string>`.

- [ ] **Step 1: loader entry**

`packages/widget/src/loader-entry.ts`:
```ts
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
  } catch { /* fail-safe: never break the merchant page */ }
})();
```

- [ ] **Step 2: Write the failing route test**

Append to `packages/widget-backend/test/embed-routes.test.ts`:
```ts
describe("embed routes", () => {
  it("GET /embed/loader.js serves JS", async () => {
    const app = await server();
    const res = await app.inject({ method: "GET", url: "/embed/loader.js" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("javascript");
    expect(res.body.length).toBeGreaterThan(100);
    await app.close();
  });
});
```

- [ ] **Step 3: Run, verify FAIL** — `pnpm vitest run packages/widget-backend/test/embed-routes.test.ts` → the new test 404s.

- [ ] **Step 4: `esbuild` dep + `embed.ts`**

Add `"esbuild": "^0.21.5"` to `packages/widget-backend/package.json` dependencies; `pnpm install`.

`packages/widget-backend/src/routes/embed.ts`:
```ts
import type { FastifyInstance } from "fastify";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const LOADER_ENTRY = join(here, "..", "..", "..", "widget", "src", "loader-entry.ts");

/** Bundle the loader to a self-executing IIFE once, at boot. */
export async function bundleLoader(): Promise<string> {
  const out = await build({ entryPoints: [LOADER_ENTRY], bundle: true, format: "iife", minify: true, write: false, target: "es2019", logLevel: "silent" });
  return out.outputFiles[0]!.text;
}

export interface EmbedDeps {
  loaderJs: string;
  panelHtml: string;
  frameAncestors: (shop: string | undefined) => string;
}

export function registerEmbedRoutes(app: FastifyInstance, deps: EmbedDeps): void {
  app.get("/embed/loader.js", async (_req, reply) => {
    reply.header("content-type", "application/javascript; charset=utf-8");
    reply.header("cache-control", "public, max-age=300");
    return deps.loaderJs;
  });
  app.get("/embed/panel", async (req, reply) => {
    const shop = (req.query as { shop?: string })?.shop;
    reply.header("content-type", "text/html; charset=utf-8");
    reply.header("content-security-policy", `frame-ancestors ${deps.frameAncestors(shop)}`);
    reply.removeHeader("x-frame-options");
    return deps.panelHtml;
  });
}
```

- [ ] **Step 5: Wire into `server.ts`**

Near where `widgetHtml` is read (`server.ts:212`) and routes are registered, add:
```ts
import { registerEmbedRoutes, bundleLoader } from "./routes/embed.js";
// … after widgetHtml is loaded and `merchants` exists:
const loaderJs = await bundleLoader();
registerEmbedRoutes(app, {
  loaderJs,
  panelHtml: widgetHtml,
  // v1: permit the resolved shop's myshopify domain + a permissive https fallback (public surface).
  frameAncestors: (shop) => (shop && /^[a-z0-9.-]+\.myshopify\.com$/i.test(shop) ? `https://${shop} https://*.myshopify.com` : "https:"),
});
```
(Read `buildServer` to place this where `app` + `widgetHtml` are in scope; keep it a single call.)

- [ ] **Step 6: Run, verify PASS** — `pnpm vitest run packages/widget-backend/test/embed-routes.test.ts`.

- [ ] **Step 7: Typecheck + commit**

```bash
env -u GOOGLE_CLOUD_PROJECT pnpm typecheck
git add packages/widget/src/loader-entry.ts packages/widget-backend/src/routes/embed.ts packages/widget-backend/src/server.ts packages/widget-backend/package.json pnpm-lock.yaml packages/widget-backend/test/embed-routes.test.ts
git commit -m "feat(widget-backend): GET /embed/loader.js — esbuild boot-bundle of the loader IIFE

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: `GET /embed/panel` frame-ancestors CSP

**Files:** Test: `packages/widget-backend/test/embed-routes.test.ts` (route added in Task 3; this task adds its assertions)

- [ ] **Step 1: Write the failing test**

```ts
it("GET /embed/panel serves HTML embeddable on the shop, not hostilely", async () => {
  const app = await server();
  const res = await app.inject({ method: "GET", url: "/embed/panel?shop=acme.myshopify.com" });
  expect(res.statusCode).toBe(200);
  expect(res.headers["content-type"]).toContain("text/html");
  const csp = String(res.headers["content-security-policy"] || "");
  expect(csp).toContain("frame-ancestors");
  expect(csp).toContain("acme.myshopify.com");
  expect(res.headers["x-frame-options"]).toBeUndefined();
  await app.close();
});
```

- [ ] **Step 2: Run** — should PASS if Task 3's route is correct; if the CSP shape differs, fix `frameAncestors` in `server.ts` until green.

- [ ] **Step 3: Commit**

```bash
git add packages/widget-backend/test/embed-routes.test.ts packages/widget-backend/src/server.ts
git commit -m "test(widget-backend): /embed/panel frame-ancestors CSP + no X-Frame-Options

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: adapt `index.html` to panel mode

**Files:** Modify: `packages/widget/public/index.html`

**Behavior:** When in panel mode (`window.parent !== window` OR `?shop=` present): (a) mint via `?shop=` from the query instead of `?key=`; (b) hide the built-in launcher bubble and render the panel expanded to fill the iframe; (c) postMessage protocol to the parent. Standalone mode (`/`) is unchanged.

- [ ] **Step 1: Read the file's structure**

Read `packages/widget/public/index.html` and note: the launcher/bubble element id, the panel element id, the open/close functions, and the `ensureToken`/mint block (`:253-262`). Panel-mode changes hook these.

- [ ] **Step 2: Add panel-mode detection + shop-param mint**

Near `:253`, replace the mint URL construction with:
```js
const Q = new URLSearchParams(location.search);
const SHOP = Q.get("shop");
const PANEL_MODE = SHOP != null || window.parent !== window;
const EMBED_KEY = (window.PALUP && window.PALUP.embedKey) || "demo-embed-key";
const MINT_URL = SHOP ? ("/widget/token?shop=" + encodeURIComponent(SHOP)) : ("/widget/token?key=" + encodeURIComponent(EMBED_KEY));
// … inside ensureToken: fetch(MINT_URL)
```

- [ ] **Step 3: Panel-mode UI + postMessage**

At the end of the inline script, add a guarded block:
```js
if (PANEL_MODE) {
  document.documentElement.setAttribute("data-palup-panel", "1");   // CSS: hide the bubble, expand the panel to 100vw/100vh
  const send = (type, extra) => { try { window.parent.postMessage(Object.assign({ type }, extra), "*"); } catch {} };
  window.addEventListener("message", (e) => {
    // only trust our own parent frame
    if (e.source !== window.parent) return;
    if (e.data && e.data.type === "palup:open") { /* ensure panel visible + focus input */ }
  });
  send("palup:ready");
  // on new assistant message while closed → send("palup:unread", { count });
  // on the shopper closing from inside → send("palup:close");
}
```
Add CSS under a `:root[data-palup-panel] .launcher { display:none }` + `:root[data-palup-panel] .panel { position:fixed; inset:0; width:100%; height:100% }` (match the actual class/id names from Step 1).

> Testing note: the inline-script UI is not unit-testable without refactoring the whole panel into modules (out of scope, YAGNI). Panel mode is verified by the e2e in Task 7 + the served-HTML assertion below.

- [ ] **Step 4: Add a served-HTML marker assertion**

Append to `embed-routes.test.ts`:
```ts
it("panel HTML carries the panel-mode + postMessage wiring", async () => {
  const app = await server();
  const res = await app.inject({ method: "GET", url: "/embed/panel?shop=acme.myshopify.com" });
  expect(res.body).toContain("data-palup-panel");
  expect(res.body).toContain("palup:ready");
  await app.close();
});
```

- [ ] **Step 5: Run + manual sanity**

Run: `env -u GOOGLE_CLOUD_PROJECT pnpm vitest run packages/widget-backend/test/embed-routes.test.ts` → PASS.
Sanity: `env -u GOOGLE_CLOUD_PROJECT WIDGET_EMBED_KEYS='{"demo-embed-key":"demo"}' SHOPIFY_STORES='{"demo":"acme.myshopify.com"}' pnpm backend` then open `http://localhost:<port>/embed/panel?shop=acme.myshopify.com` — the panel renders expanded, no bubble.

- [ ] **Step 6: Commit**

```bash
git add packages/widget/public/index.html packages/widget-backend/test/embed-routes.test.ts
git commit -m "feat(widget): panel mode — shop-param mint, hidden launcher, postMessage to the loader

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: theme app extension

**Files:** Create: `extensions/palup-widget/shopify.extension.toml`, `extensions/palup-widget/blocks/app-embed.liquid`; Test: `packages/widget/test/app-embed-liquid.test.ts`

- [ ] **Step 1: Write the failing source-shape test**

`packages/widget/test/app-embed-liquid.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const liquid = readFileSync(join(here, "..", "..", "..", "extensions", "palup-widget", "blocks", "app-embed.liquid"), "utf8");

describe("app-embed block", () => {
  it("renders the loader script with shop + position and a position setting", () => {
    expect(liquid).toMatch(/<script[^>]+src=.+\/embed\/loader\.js/);
    expect(liquid).toContain('data-shop="{{ shop.permanent_domain }}"');
    expect(liquid).toContain("data-position=");
    expect(liquid).toMatch(/"type"\s*:\s*"select"[\s\S]*"id"\s*:\s*"position"/);
    expect(liquid).toContain('"target": "body"');
  });
});
```

- [ ] **Step 2: Run, verify FAIL** (file missing).

- [ ] **Step 3: Create the extension files**

`extensions/palup-widget/shopify.extension.toml`:
```toml
name = "palup-widget"
type = "theme"
api_version = "2026-07"
```

`extensions/palup-widget/blocks/app-embed.liquid`:
```liquid
{% comment %} PalUp shopper widget — app-embed block. Injects the loader on every storefront page. {% endcomment %}
<script
  src="{{ 'https://REPLACE_WITH_APP_HOST' }}/embed/loader.js"
  data-shop="{{ shop.permanent_domain }}"
  data-position="{{ block.settings.position }}"
  async></script>

{% schema %}
{
  "name": "PalUp widget",
  "target": "body",
  "settings": [
    { "type": "select", "id": "position", "label": "Launcher position",
      "options": [ { "value": "bottom-right", "label": "Bottom right" }, { "value": "bottom-left", "label": "Bottom left" } ],
      "default": "bottom-right" }
  ]
}
{% endschema %}
```

> The host is a deploy-time value; `REPLACE_WITH_APP_HOST` is set by `shopify app deploy` config (like `shopify.app.toml:application_url`). Document that in the file comment.

- [ ] **Step 4: Run, verify PASS.**

- [ ] **Step 5: Commit**

```bash
git add extensions/palup-widget/ packages/widget/test/app-embed-liquid.test.ts
git commit -m "feat(extension): theme app-embed block that injects the widget loader

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: e2e round-trip (Playwright)

**Files:** Create: `e2e/fixtures/embed-host.html`, `e2e/tests/embed.spec.ts`

**Interfaces:** Consumes the running widget-backend (mock model path — no `GOOGLE_CLOUD_PROJECT`), which serves `/embed/loader.js`, `/embed/panel`, `/chat`.

- [ ] **Step 1: Read the existing e2e harness**

Read `e2e/playwright.config.ts` + an existing spec to learn how the suite boots the backend (webServer, base URL, the demo tenant env). Follow that pattern.

- [ ] **Step 2: Fixture host page**

`e2e/fixtures/embed-host.html` — a bare page that loads the loader as a storefront would:
```html
<!doctype html><meta charset="utf-8"><title>host</title>
<script src="/embed/loader.js" data-shop="acme.myshopify.com" data-position="bottom-right" async></script>
```
(Serve it via the backend or Playwright's static route; if the backend can't serve arbitrary fixtures, add a tiny test-only static route or use `page.setContent` with an absolute loader URL.)

- [ ] **Step 3: Write the failing test**

`e2e/tests/embed.spec.ts`:
```ts
import { test, expect } from "@playwright/test";
test("embed: launcher → open → panel iframe → chat reply", async ({ page }) => {
  await page.goto("/embed-host");            // however the fixture is served
  // the launcher lives in a CLOSED shadow root — locate the host, pierce is not possible, so assert via the host element + click through coordinates OR expose a data-testid on the host element
  const host = page.locator("[data-palup-host]");
  await expect(host).toBeVisible();
  await host.click();                        // opens the panel
  const panel = page.frameLocator("iframe[title='Chat']");
  await panel.getByRole("textbox").fill("do you sell sunscreen?");
  await panel.getByRole("button", { name: /send/i }).click();
  await expect(panel.locator("body")).toContainText(/sunscreen|SPF|sorry/i, { timeout: 20000 });
});
```
> Closed shadow roots are opaque to Playwright selectors — add a `data-palup-host` attribute (and `data-testid`) to the loader's host element and give the launcher button a stable role/label so the e2e can click it. Adjust the loader in Task 2 if needed (add the attribute), or set `mode:"open"` ONLY when a `data-testid` seam is required — prefer keeping closed + adding the host attribute + clicking the host.

- [ ] **Step 4: Run, iterate to green**

Run: `env -u GOOGLE_CLOUD_PROJECT pnpm e2e --grep embed` (or the suite's invocation). Fix selectors/seams until it passes against the mock model.

- [ ] **Step 5: Commit**

```bash
git add e2e/tests/embed.spec.ts e2e/fixtures/embed-host.html packages/widget/src/loader-core.ts
git commit -m "test(e2e): embed round-trip — loader → launcher → panel iframe → /chat

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: docs, security review, merge

**Files:** Modify: `docs/DEPLOY.md` (or `docs/design/shopper-widget.md`) — the embed/install instructions.

- [ ] **Step 1: Document the install path**

Add a short "Embedding the widget" section: `shopify app deploy` registers the app + the `palup-widget` app-embed extension; the merchant enables it in the theme editor; tenant resolves by shop domain (registry row from install, or `SHOPIFY_STORES`/`WIDGET_EMBED_KEYS` for the demo). Note the deploy-time host value in `app-embed.liquid` + `shopify.app.toml`.

- [ ] **Step 2: Run the full local gate**

Run: `env -u GOOGLE_CLOUD_PROJECT pnpm typecheck && env -u GOOGLE_CLOUD_PROJECT pnpm test && env -u GOOGLE_CLOUD_PROJECT pnpm e2e` — all green.

- [ ] **Step 3: security-reviewer**

Dispatch the `security-reviewer` subagent on the branch diff (new `/embed/*` routes, `frame-ancestors` CSP, `?shop=` client-claimed tenant routing, iframe sandbox, closed shadow + origin-checked postMessage). Resolve any finding before merge.

- [ ] **Step 4: PR + merge-gate**

```bash
git push -u origin feat/embeddable-widget
gh pr create --base main --title "feat: embeddable shopper widget (theme app extension + loader + panel)" --body "…agent plane: build-time; shopper-facing serving plumbing, no HITL boundary; security-reviewer PASS. Implements docs/superpowers/specs/2026-08-10-embeddable-widget-design.md."
env -u GOOGLE_CLOUD_PROJECT .claude/scripts/merge-gate.sh <pr#>
```

- [ ] **Step 5: Follow-up note**

Record the remaining human steps in the roadmap: `shopify app deploy` (register the app + set the real host), and standing up a production host. These are `docs/PATH-TO-PRODUCTION.md` Phase-1 #1 and #5.

---

## Self-review (author checklist — done)

- **Spec coverage:** distribution (Task 6), hybrid mount (Tasks 2,5), shop-domain resolution (Task 1), loader (Tasks 2,3), panel (Task 5), routes + CSP (Tasks 3,4), postMessage protocol (Tasks 2,5), tests (2,3,4,5,6,7), governance/security (Task 8). Every §5–§9 spec item maps to a task.
- **Placeholder scan:** the only literal placeholder is `REPLACE_WITH_APP_HOST` in the Liquid — that is a real deploy-time value (mirrors `shopify.app.toml`), documented as such, not a plan gap.
- **Type consistency:** `initWidgetLoader(LoaderConfig)` (Task 2) is consumed by `loader-entry.ts` (Task 3); `registerEmbedRoutes(app, EmbedDeps)` / `bundleLoader()` (Task 3) match their `server.ts` call; `tenantForShopDomain` (Task 1) matches `merchant-resolver.ts:254`.
- **Known deviation:** the inline-script panel UI (Task 5) is verified by e2e + a served-HTML assertion rather than a unit test, because unit-testing it would require refactoring the whole panel into modules (out of scope). Called out inline.
