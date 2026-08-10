# Embeddable shopper widget — design spec

**Date:** 2026-08-10 · **Status:** approved (brainstorm) → ready for implementation plan
**Roadmap item:** `docs/PATH-TO-PRODUCTION.md` Phase 1 #4 (the recommended first BUILD) — the single biggest
*buildable* widget production blocker.

## 1. Context & current state

The shopper live-chat widget's serving pipeline (mint → `/chat` → session → guardrails) is built and live on
staging, and the UI already exists as a **self-contained demo page** that is embed-shaped:
`packages/widget/public/index.html` reads `window.PALUP.embedKey` (fallback `"demo-embed-key"`, `:253`),
mints a short-TTL widget token via `GET /widget/token?key=…` (`:258`), and sends it on `/chat`.

What is missing is the **loader + distribution**: the UI is served only as a whole HTML page at `GET /`
(`server.ts:1065`); there is no loader script, no `extensions/` theme app extension, and no way for a
merchant to get the widget onto their live storefront. `shopify.app.toml` has `embedded = false` (correct — a
*storefront* widget, not an Admin embed) and covers only webhooks, not the storefront surface.

## 2. Goals / non-goals

**Goals (v1):**
- A merchant can install the app and turn the widget on in their theme editor — no manual snippet, no
  ScriptTag — and it appears on their storefront and answers their shoppers.
- The shopper's token, conversation, and (future) identity stay isolated from the merchant's page.
- Reuse the existing panel UI and the entire `/chat` pipeline unchanged.

**Non-goals (deferred):** proactive page-context browser triggers; merchant color/theming (position only);
analytics/unread persistence; the install→registry-row handoff (roadmap #2); a live commerce adapter.

## 3. Decisions (approved)

1. **Distribution = theme app extension (app-embed block).** Listing-ready and usable for the pilot; the
   Shopify-blessed path (no manual snippet, no deprecated ScriptTag).
2. **Mount = hybrid** — a **shadow-DOM launcher** (isolated CSS, no sensitive data) plus an **iframe panel**
   served from our origin (holds the token/conversation/identity, unreadable by the theme).
3. **Tenant resolution = shop domain, not an embed key.** The app-embed block always has
   `{{ shop.permanent_domain }}`; the backend resolves domain → tenant via the merchant registry (`pl_merchant`
   is keyed by shop domain, D1), with `WIDGET_EMBED_KEYS` as the existing named fallback. No key handoff, no
   merchant paste. The embed key stays supported for the demo / no-registry case.

## 4. Architecture

```
Merchant storefront page
 [1] Theme app extension (app-embed block)   ← `shopify app deploy`, toggled in the theme editor
       renders: <script src="https://<host>/embed/loader.js"
                        data-shop="{{ shop.permanent_domain }}"
                        data-position="{{ block.settings.position }}" async>
 [2] loader.js  (served by backend; runs in the merchant page)
       • launcher in a CLOSED shadow root (isolated CSS, no sensitive data)
       • lazily injects the PANEL <iframe src="/embed/panel?shop=…"> on first open
       • brokers launcher ↔ panel via origin-checked postMessage
 [3] Panel iframe  (our origin) = the existing widget UI (index.html, adapted)
       • holds the mint token, conversation, session, future guest identity
       • unchanged mint → /chat flow
 [4] Backend routes (widget-backend)
       • GET /embed/loader.js   → the built loader (public, cacheable)
       • GET /embed/panel       → the adapted panel HTML (frame-ancestors CSP)
       • existing /widget/token (+ ?shop=), /chat, /widget/guest, /consent, /forget — reused
```

**New code:** `extensions/palup-widget/` (theme app extension), a `loader.ts`→`loader.js` build in
`packages/widget`, two backend routes, and a `?shop=` resolution path on the mint route + `merchant-resolver`.
**Reused as-is:** the mint → `/chat` → session → guardrail pipeline and the panel UI.

## 5. Component specs

### 5.1 Theme app extension — `extensions/palup-widget/`
- **Responsibility:** inject the loader on every storefront page when the merchant enables the app embed.
- **Interface:** `shopify.extension.toml` (a `theme` extension, one app-embed block, pinned api_version) +
  `blocks/app-embed.liquid` which renders the loader `<script>` with `data-shop` / `data-position`, `target =
  "body"`, and a `{% schema %}` exposing exactly one setting: `position` (select: `bottom-right` |
  `bottom-left`, default `bottom-right`). App-embed's built-in enable toggle handles on/off.
- **Depends on:** the `/embed/loader.js` route; the host URL (deploy config).
- **Deployed by:** `shopify app deploy` (human INFRA step; not run in this repo today).

### 5.2 loader.js — `packages/widget/src/loader.ts` (built to `loader.js`)
- **Responsibility:** render the launcher, lazily mount the panel iframe, broker the postMessage protocol,
  fail safe.
- **Interface / behavior:**
  - IIFE, no globals except one namespaced init-guard (`window.__palupWidgetLoaded`); single-instance.
  - Read `data-shop`, `data-position` from `document.currentScript` (fallback: query the known script src).
  - Append one host element to `<body>`, `attachShadow({ mode: "closed" })`.
  - Render the launcher (bubble, fixed to `position`, isolated CSS in the shadow root; optional unread dot).
  - On first open: create `<iframe src="/embed/panel?shop=<shop>" sandbox="allow-scripts allow-same-origin
    allow-forms" title="Chat">` inside the shadow root; subsequent opens reveal it.
  - ESC and click-outside close; small-viewport ⇒ full-screen panel.
  - **Fail-safe:** any error ⇒ launcher no-ops; never throws into the merchant page.
- **Depends on:** the panel origin (same host); nothing from the merchant page.

### 5.3 Panel iframe — adapted `packages/widget/public/index.html`
- **Responsibility:** the chat UI + the existing mint→`/chat` flow, inside our origin.
- **Changes from today:** (a) read `shop` from its own URL query and pass it to the mint call (`?shop=` instead
  of / in addition to `?key=`); (b) emit/consume the postMessage protocol (§6) instead of being a standalone
  page; (c) served at `/embed/panel`, not `/`.
- **Depends on:** `/widget/token`, `/chat`, `/widget/guest`, `/consent`, `/forget` (all same-origin, unchanged).

### 5.4 Backend routes — `packages/widget-backend/src/`
- `GET /embed/loader.js` — serve the built loader; `content-type: application/javascript`, versioned +
  cacheable, CORS-open (public script).
- `GET /embed/panel` — serve the adapted panel HTML with a `Content-Security-Policy: frame-ancestors …`
  header and no `X-Frame-Options: DENY`. **Custom-domain nuance:** most production stores serve from a custom
  domain, not `*.myshopify.com`, so a hardcoded `*.myshopify.com` policy would fail to embed on the merchant's
  primary domain. v1 permits the resolved shop's known storefront domains (from the `pl_merchant` registry
  when present) plus `https://*.myshopify.com`; where the custom domain is unknown, it falls back to a
  permissive `frame-ancestors https:` — acceptable because the panel is a *public* surface (public catalog,
  rate-limited public token; an attacker framing it gains only the public agent). The exact policy is a
  security-reviewer decision at build.
- **Mint `?shop=`** — extend `/widget/token` (`server.ts:1072`) + `merchant-resolver` to resolve a shop domain
  → tenant (registry first, `WIDGET_EMBED_KEYS` fallback); the embed-key path stays.

## 6. postMessage protocol (contract)

Origin-checked in BOTH directions (`event.origin === OUR_ORIGIN`; verify `event.source` is the panel's
`contentWindow`). Message shape: `{ type: "palup:<name>", ...payload }`.

| Direction | type | payload | meaning |
|---|---|---|---|
| panel → loader | `palup:ready` | — | panel loaded; loader replies with `palup:host` |
| loader → panel | `palup:host` | `{ shop, position }` | hand the panel its config |
| loader → panel | `palup:open` | — | panel should show its opened state |
| panel → loader | `palup:resize` | `{ height }` | loader sizes the iframe |
| panel → loader | `palup:close` | — | loader hides the panel |
| panel → loader | `palup:unread` | `{ count }` | loader shows the unread dot |

## 7. Security & isolation
- The token/conversation/identity live in the panel iframe (our origin) — the merchant theme, third-party
  scripts, or an injected script on the storefront cannot read them.
- Closed shadow root + origin-checked postMessage prevent the theme from reading or spoofing panel messages.
- `sandbox="allow-scripts allow-same-origin allow-forms"`: `allow-same-origin` keeps the panel's *own*-origin
  storage/fetch while it stays cross-origin to the merchant page — isolation holds.
- Tenant routing by shop domain is the SAME trust model already accepted for the embed key: the widget token
  is a *public shopper* credential (short-TTL, tenant-scoped, rate-limited — `rate-limit.ts`), and the agent
  grounds only on that tenant's **public** catalog. A spoofed shop domain gets a rate-limited public token
  for that tenant's public agent — no new exposure.
- **security-reviewer** must pass: this adds internet-reachable routes (`/embed/*`), sets `frame-ancestors`,
  and adds a client-claimed tenant-routing input (`?shop=`).
- Known edge: a storefront with a strict `script-src` CSP could block the loader (Shopify app-embed scripts
  are generally permitted) — documented, not solved in v1.

## 8. Testing (ATDD)
- **Unit (vitest + jsdom):** launcher mounts in a closed shadow root; `data-*` config parse; single-instance
  guard; each postMessage handler; fail-safe on a panel error.
- **Backend (fastify.inject):** `/embed/loader.js` content-type + cache; `/embed/panel` emits the
  `frame-ancestors` CSP and no `X-Frame-Options: DENY`; mint resolves tenant by `?shop=` (registry + fallback).
- **E2E (Playwright):** a test page loads the loader → launcher mounts → click → panel iframe mounts → a
  `/chat` round-trip renders a reply.
- **Liquid block:** asserted by its rendered script-tag output (unit/snapshot of the block file), not a live
  Shopify render. `shopify app deploy` + a dev-store smoke is the human step (mirrors the P4 smoke pattern).

## 9. Acceptance criteria (machine-checkable)
1. `GET /embed/loader.js` returns `content-type: application/javascript` and a non-empty script.
2. `GET /embed/panel?shop=<demo shop>` returns HTML with `Content-Security-Policy` containing `frame-ancestors`
   and no `X-Frame-Options: DENY`.
3. `GET /widget/token?shop=<demo shop>` mints a token whose tenant equals the demo tenant (registry or
   `WIDGET_EMBED_KEYS` fallback); an unknown shop with no registry row + no fallback is refused.
4. In jsdom, running the loader with `data-shop`/`data-position` creates exactly one closed-shadow host with a
   launcher; running it twice creates only one.
5. The loader ignores/rejects a postMessage whose `origin !== OUR_ORIGIN`.
6. The loader never throws into the page when the panel fails to load (fail-safe).
7. `blocks/app-embed.liquid` renders a `<script>` with `data-shop="{{ shop.permanent_domain }}"` and the
   `position` setting; its `{% schema %}` exposes only `position`.
8. E2E: launcher → open → panel iframe → a `/chat` reply renders end-to-end on a test page.

## 10. Scope / YAGNI
- **v1:** the theme app extension (app-embed + `position`), the loader, the two backend routes, `?shop=`
  resolution, the adapted panel UI, and the tests above.
- **Deferred:** proactive browser triggers; color/theming; analytics/unread persistence; custom-domain
  `frame-ancestors` **auto-discovery** (querying Shopify for a shop's domains — v1 uses registry-known domains
  + a permissive `https:` fallback, §5.4); the install→registry-row handoff (roadmap #2).

## 11. Governance
Build-time work; shopper-facing serving plumbing that **crosses no HITL money/model/autonomy boundary** — it
routes tenants and mounts the existing agent, adding no new autonomous action. It DOES touch internet-reachable
routes + tenant routing, so `security-reviewer` gates the merge. `shopify app deploy` (registering the app +
extension) and standing up a production host are the human INFRA steps that follow.

## 12. Dependencies & open items
- **[INFRA, human]** `shopify app deploy` from a Partners account to register the app + the theme app extension
  (blocked on the roadmap's app-registration step; the code can be built and unit/e2e-tested first).
- **[BUILD, roadmap #2]** install → `pl_merchant` registry row so a real self-installed merchant resolves by
  shop domain (this spec works today for the demo tenant via `SHOPIFY_STORES`/`WIDGET_EMBED_KEYS`).
- **Host URL** for the loader `src` + panel — a deploy-time config value.
