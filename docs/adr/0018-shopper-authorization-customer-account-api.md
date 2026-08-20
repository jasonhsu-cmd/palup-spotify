# ADR-0018: Shopper authorization via the Shopify Customer Account API (OAuth) — Accepted (built; live on staging)

- **Status: Accepted — built and merged.** `CAA_ENABLED`/`SHOPPER_AUTH` is **live on internal staging** (confirmed
  via `gcloud run services describe palup-widget-staging`, 2026-08-20: `WIDGET_AUTH_REQUIRED=true`,
  `SHOPPER_AUTH=true`, `CAA_REDIRECT_URI` and `SHOPPER_TOKEN_SECRET` both set) — this superseded the original
  "not yet cut over live" status, which was stale against that config (see the F13 investigation,
  `.superpowers/sdd/2026-08-20-widget-behavioral-harness-layer1/f13-investigation.md`). **INERT in production**
  (unset there). (OAuth adapter + `/auth/customer/login|callback|logout` routes registered in
  `widget-backend/src/server.ts`; live CAA commerce read adapter also behind `CAA_ENABLED`). Add the Shopify
  **Customer Account API (CAA) OAuth** as an additive, third
  shopper-identity adapter behind the vendor-neutral `IdentityPort` (ADR-0001), so the widget can read a
  shopper's **own** orders + subscriptions with a **per-shopper, least-privilege** token. **Hybrid** with
  the App-Proxy adapter (ADR-0017) — not a replacement. Behind `SHOPPER_AUTH` (default off, honored only
  with `WIDGET_AUTH_REQUIRED` per ADR-0017 F4) — **still INERT (unset) in production; live on internal
  staging** since the cutover confirmed 2026-08-20 above.
- **Owner (named):** jason.hsu@framy.co. **Plane:** run-time (shopper identity/authorization).
- **Governance-touching** (customer data + a durable server-side credential). `security-reviewer`
  required; **human-merged.** Ships **NO new autonomy**; preserves ADR-0016 human-routed skip/pause.

## Context — why CAA, and why now

Live catalog + policy grounding is shipped (ADR-0012), but the **Storefront API cannot read a customer's
orders or subscriptions** — those need the Admin API or the Customer Account API. We chose **CAA over the
Admin API**:

- **Least privilege / no standing liability.** The Admin path means holding a broad `read_orders` /
  `read_customers` token **per merchant** — a standing, high-blast-radius credential that a
  governance-first product should avoid at multi-merchant scale. CAA issues a **per-shopper** token
  Shopify scopes to the one customer, so cross-shopper reads are **IDOR-impossible by construction**.
- **Already provisioned.** The merchant's **Headless channel** issues the CAA credentials; and
  `subscriptionContracts` are available on the `Customer` object since the **2024-10 Customer API**
  ([changelog](https://shopify.dev/changelog/customer-apis-allow-querying-of-customer-subscription-contracts)).

The cost is an OAuth flow + an in-widget authorization UX, scoped here. This ADR unblocks **reads only**;
subscription **skip/pause** stays gated by ADR-0016.

## Spike — vendor facts pinned (retrieved 2026-08-02)

Verified against shopify.dev "Authenticate customers" and "Getting started", and the **live** OIDC
discovery doc `https://palup-skincare-jason.myshopify.com/.well-known/openid-configuration`
(issuer shop-id `72199635021`):

- **Per-SHOP client model.** Credentials (`clientId`/`clientSecret`) are issued **per merchant store**
  (install the Headless channel per store); the issuer is shop-specific
  (`https://shopify.com/authentication/<shop-id>`). Multi-merchant ⇒ **per-merchant credential +
  redirect_uri provisioning** (an onboarding step, not zero-touch).
- **Confidential client** for our server-side backend. The docs describe exactly our case — *"a back-end
  … and a server-side session to hold the refresh token"* — so token exchange sends the `client_secret`
  (via the `SecretsPort`) **plus** PKCE (S256). (The public/PKCE-only variant is the browser/Hydrogen
  case — not ours.)
- **Refresh tokens supported.** `grant_types_supported` = `authorization_code`, `refresh_token`,
  `urn:ietf:params:oauth:grant-type:jwt-bearer`. Exact TTLs are observed at implementation.
- **No token-revocation endpoint.** The metadata exposes an `end_session_endpoint` (logout,
  `…/logout`) but **no `revocation_endpoint`**. Kill-switch/logout therefore **cannot** rely on
  Shopify-side token revocation — it must **delete the local grant** (guaranteed non-use) + best-effort
  end-session.
- **Dynamic discovery.** Authorize/token/JWKS endpoints + the per-shop **issuer** are fetched from
  `.well-known/openid-configuration` (never hardcoded), which pins the issuer + JWKS for id_token
  validation. id_token signing = **RS256**; `code_challenge_methods` = **S256**; `subject_types` =
  `public`.
- **Scopes.** OAuth: `openid email customer-account-api:full`. App access scopes: `customer_read_orders`,
  `customer_read_customers` (+ `subscriptionContracts` on the `Customer` object). **HTTPS mandatory**; no
  localhost.

**Residual, observed at build (non-blocking — the design handles both):** exact refresh-token TTL, and
the id_token `sub` format (bare-numeric vs GID). The adapter **normalizes** the subject to the SAME
numeric customer id App-Proxy uses (fail-closed to anonymous if unnormalizable).

## Decision

Add a CAA OAuth adapter (`packages/widget-backend/src/shopify-customer-account-identity.ts`) — a
Shopify-specific adapter behind `IdentityPort`, mirroring `shopify-shopper-identity.ts`
(`node:crypto` + a plain `fetch` client, **no Shopify SDK**, HTTPS only). Both adapters emit the
**identical** `{kind:'shopper', source:'shopify', shopperId}` Principal and mint the **same** PalUp HMAC
session token via `mintShopperToken` — the same Shopify customer resolves to **one** `shopperId` whether
verified via App-Proxy or CAA (a test asserts this), which is what lets the "App-Proxy identity + CAA
read-token" composition and the `commerce-guard` ownership check hold across both paths.

**Hybrid composition:** App-Proxy is the **zero-friction default** for storefront-logged-in shoppers;
CAA is the additive **explicit "Sign in to view your orders"** path — the only one that yields the
shopper's own access token for reading their orders + subscriptions.

Four new backend routes gated by `SHOPPER_AUTH` (404/inert when off), IP rate-limited under the existing
`__mint__` bucket: `GET /auth/customer/login`, `GET /auth/customer/callback`, `GET /auth/customer/logout`,
and a one-time `/auth/customer/handoff` redeem. Authorization Code + PKCE(S256) + confidential
`client_secret`; **full id_token validation** (RS256 via the shop's JWKS with a bounded-TTL cache, fail
**closed** on unavailable JWKS/unknown kid; `iss` pinned to the flow's shop; `aud == client_id`; `exp`/
`iat`; `nonce`). Per-shopper access + refresh tokens stored **server-side, encrypted, tenant-scoped,
keyed by `shopperId`** — never in the browser, the client token, or any log.

## Hardening (adversarial review — 5 blockers folded in)

1. **Tenant-less callback.** `/auth/customer/callback` is a top-level Shopify redirect (only `code`/
   `state`/`error`). Pending-auth is stored in an **app-scoped** (`__shopify_app__`) RuntimeState
   collection keyed by the unguessable random `state`, with `tenantId` **inside** the value and treated
   as authoritative downstream. Tenant is **never** read from the callback URL/query.
2. **Issuer pinned to the flow's shop.** Resolve the expected shop from the record's tenant
   (`parseStoreDomains`) → that shop's OIDC issuer + JWKS + token endpoint, and require `iss` to equal
   **that** issuer — defeating an IdP/shop mix-up that would namespace shop B's customer under tenant A.
3. **`source` stays `'shopify'`.** Do **not** add a `caa`/`shopify_oauth` literal: it is invalid by
   construction (`shopperIdTenant`'s `[a-z0-9]+` source segment rejects `_`, and `buildShopifyShopperId`
   hardcodes `shopify:` + `/^\d+$/`), it splits the `shopperId` per customer, and it bakes a Shopify
   mechanism distinction into the vendor-neutral Principal (violates ADR-0001). Mechanism (`caa`) is
   recorded in the **audited grant event**, not the type.
4. **Kill-switch = guaranteed non-*use*.** The commerce/refresh path is strictly downstream of
   `matchedKill` (server.ts), so a killed tenant's token is never exercised and lazy refresh never fires.
   On kill/logout/incident: **delete the local grant first**, then best-effort `end_session` (there is
   **no** revocation endpoint). An explicit incident revocation-sweep over the tenant-scoped grant
   collection is budgeted work if active deletion on arm is required — not an afterthought.
5. **IDOR-safe token lookup.** The CAA-backed `CommercePort` adapter looks up the stored token by the
   **verified ALS principal's** `shopperId` (tenant derived from that id's namespace), never a method
   arg / tool output / brain input; the token never reaches the client. Absent/unrefreshable grant ⇒ a
   typed `reauth_required`.

## In-widget auth UX

Explicit opt-in (the friction CAA adds over App-Proxy). A visible **"Sign in to view your orders"**
control whose click handler opens `/auth/customer/login` via a **synchronous `window.open`** (never
auto-opened, never from an async model response — browser user-activation policy blocks those). On
`window.open() === null` (popup blocked), render an inline "click to sign in" + a **top-frame redirect**
fallback. The minted token returns via the **one-time handoff code** (recovers on both popup and redirect
paths) **and** an origin-checked `postMessage` to the known PalUp iframe origin, into `sessionStorage`;
then `/chat` starts sending `x-shopper-token` and the pending question is re-sent. Prefer App-Proxy (no
prompt) whenever available. On `reauth_required` mid-chat, clear the token and re-trigger sign-in.

## Governance

- **No new autonomy; no HITL/money boundary crossed here.** But a CAA-verified
  `{kind:'shopper',verified:true}` now **satisfies** the ADR-0016 fail-closed live-commerce guard ⇒
  subscription **skip/pause execution MUST stay human-routed** (unchanged). Do not conflate "verified
  owner" with "autonomous money action."
- **New durable credential class.** A stored refresh token is renewable, higher-blast-radius customer
  access than the App-Proxy short-TTL identity token. Encryption-at-rest is a **pre-build port-contract**
  decision (below). Every **grant** and each **credentialed self-read** is written to the immutable audit
  log (actor = hashed shopper ref, `reversalPath = "revoke grant + delete session"`). Kill-switch
  reachable (non-use guaranteed).
- **Not memory.** The stored token is identity/credential custody, **not** cross-visit shopper memory —
  drifting into durable personalization would ship an unconsented write governed by ADR-0015. Out of scope.

## Open decisions

1. **Encryption-at-rest contract** — **RESOLVED (2026-08-02):** app-layer **AES-256-GCM** envelope
   encryption in a `GrantStore` helper (`customer-grant-store.ts`) over the **unchanged**
   `RuntimeStatePort` — the port contract is untouched (zero ADR-0001 risk), the widget-backend encrypts
   before `put` / decrypts after `get`, key from the `SecretsPort` (`caa_grant_encryption_key`), no
   plaintext-in-KV. Promote to a dedicated port only if refresh/rotation logic thickens.
2. **ADR-0015 region/consent** — **RESOLVED (2026-08-02, ADR-0015 owner): A.** The durable grant is
   **credential custody** (an authenticated-session credential the shopper explicitly authorized via the
   OAuth consent), **not** the durable cross-visit *memory* ADR-0015 governs — so it is **not**
   consent-gated as memory. It **must** still honor two baseline GDPR obligations, now design
   requirements: (a) data-subject **erasure** deletes the stored grant (`GrantStore.delete`), and
   (b) **EU data-residency** for where the grant is stored. Capped access-token TTL + forced re-auth apply.
3. **Merchant onboarding** (per-shop client) — **OPEN:** per-merchant `redirect_uri` registration +
   secret provisioning is **manual** and a merchant can silently break it — design + budget it (a
   go-live/onboarding task, not a code blocker).

## Task list (ATDD-ready)

0. **(Done — this ADR)** Spike the CAA wire contract. Remaining observe-at-build: refresh-token TTL, `sub` format.
1. Decide the **encryption-at-rest** contract (open decision 1) and route through portability review; no plaintext refresh token.
2. Confirm **ADR-0015** applicability to durable grant retention with the ADR owner (open decision 2).
3. `shopify-customer-account-identity.ts`: PKCE(S256) helpers, authorize-URL builder from per-shop OIDC discovery, code→token exchange (HTTPS only; reject non-https config at startup; confidential `client_secret`), full id_token validation (RS256 via the shop's JWKS, fail-closed; `iss` pinned to the flow's shop; `aud`; `exp`/`iat`; `nonce`) → Principal or anonymous. Subject normalized to the App-Proxy numeric id via `buildShopifyShopperId`; `source` stays `'shopify'`.
   - *Acceptance:* App-Proxy and CAA for the same Shopify customer resolve to the **identical** `shopperId`; a wrong-issuer / bad-sig / bad-nonce / unknown-kid id_token ⇒ anonymous.
4. `GET /auth/customer/login`: gated by `SHOPPER_AUTH`, `__mint__` rate-limited; authenticate the widget token for tenant; persist the pending-auth record (`code_verifier`,`state`,`nonce`,`tenantId`,`shopDomain`) in the **`__shopify_app__`** collection keyed by random `state`, short TTL; 302 to the flow shop's authorize URL.
   - *Acceptance:* flag off ⇒ 404; tenant never read from the callback; record single-use.
5. `GET /auth/customer/callback`: branch on OAuth **error first** (`access_denied` ⇒ benign cancel copy; else generic; never echo `error_description`); single-use `state` lookup+delete; authoritative tenant/shop from the record; code→token against **that** shop; id_token validation; `shopperId` derivation; encrypted token storage; audited grant event; mint the PalUp token returned **only** via one-time handoff + exact-`targetOrigin` `postMessage`.
   - *Acceptance:* cross-tenant `state`, wrong issuer, replayed `state`, and declined-consent all fail closed to anonymous/benign; a row is written to the audit log on success.
6. Persist per-shopper access+refresh tokens (encrypted, tenant-scoped, keyed by `shopperId`, TTL from token expiry, access-token TTL capped short); provision `client_id`/`client_secret` via `SecretsPort` at the confirmed scope.
7. Server-side **refresh + logout** with **local-first** ordering: lazy refresh near expiry, capped session lifetime; on logout/kill/incident **delete local first**, then best-effort `end_session` (no revocation endpoint); add `GET /auth/customer/logout`.
   - *Acceptance:* a killed tenant's grant is never exercised (path downstream of `matchedKill`); logout deletes the local grant even if `end_session` fails.
8. Thread the stored token to a CAA-backed `CommercePort` read adapter **IDOR-safely**: look up by `currentPrincipal().shopperId` from the guard ALS (tenant from its namespace), never a method arg; return typed `reauth_required` when absent.
   - *Acceptance:* shopper A can never read shopper B's orders/subscriptions; token never reaches the client.
9. **Audit** the grant and each credentialed read (`identity.shopper.oauth_granted` + `commerce.read.self`, actor = hashed shopper ref, `mechanism='caa'`, `reversalPath`).
10. Widget (`packages/widget/public/index.html`): gesture-triggered "Sign in to view your orders" (synchronous `window.open`; popup-blocked fallback; one-time handoff + origin-checked `postMessage`); start sending `x-shopper-token`; re-send the pending question; handle `reauth_required`; prefer App-Proxy when available.
11. Gate behind `SHOPPER_AUTH` (default off, honored only with `WIDGET_AUTH_REQUIRED`); route the PR through `security-reviewer` with a **named human owner**; explicitly preserve ADR-0016 human-routed skip/pause.
12. **(Live cutover, separate)** Provision the per-shop CAA client + `redirect_uri` on `palup-skincare-jason`, capture a golden id_token/flow, live smoke, and a **human security re-review**.

## Consequences

- (+) Per-shopper **least privilege**; **no** broad standing Admin token per merchant; IDOR impossible by
  construction; reuses the shopper-token transport **and** the App-Proxy identity (hybrid).
- (+) `subscriptionContracts` + orders readable as the shopper.
- (−) An OAuth flow + an in-widget auth UX + a **durable credential class** to custody; **per-merchant**
  onboarding (per-shop client); **no** Shopify revocation endpoint (kill = local delete + best-effort
  logout).
- (−) Subscription **skip/pause** (ADR-0016) still needs its own enactment — this unblocks **reads** only.
