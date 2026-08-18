# Deploy & scheduler (staging)

Staging **auto-deploys on merge to `main`**; **production is never auto-deployed** (locked decision,
`docs/design/build-automation.md` §1). Staging is now **configured and active** (WIF auth +
`STAGING_ENABLED=true`); before setup the workflows were guarded by `STAGING_ENABLED` so `main` stayed
green.

> Status: **staging is deployed to Cloud Run and serves live `/chat`.** The widget backend deploys via
> `deploy-staging.yml` and passes a post-deploy smoke that now exercises the **full serving path end-to-end**:
> `/health` → `{"ok":true,"model":"vertex/gemini"}` (and **fails if `model` is `mock`**, guarding against a
> silent fall-back off the Vertex adapter); an unauthenticated `/chat` is rejected with **401** (auth
> enforced); then it mints a widget token and calls `/chat`, asserting a **real, non-empty model reply** (not
> the auth fall-back or the oversize-input rejection). The widget UI is served at `/`. Every merge to `main`
> auto-redeploys and re-runs this gate. The exact model id is pinned in `.github/workflows/deploy-staging.yml`
> (`GOOGLE_CLOUD_LOCATION=global`, `PALUP_MODEL=gemini-3.5-flash`). Reply content is asserted **structurally**
> (non-empty, not a canned string), not verbatim — the model is nondeterministic. This exact flow was also
> verified live by hand against the deployed service (2026-07-31).
> **Run-time state is durable + shared:** backed by a Cloud SQL Postgres instance (`palup-staging`,
> `db-f1-micro`) via the `RuntimeStatePort`, so the operator Kill Switch, session state, canary, and the
> immutable audit log survive restarts and propagate across instances (NN #4/#5). `DATABASE_URL` is a
> Secret Manager secret mounted at deploy; `PALUP_REQUIRE_DATABASE_URL=true` makes the backend refuse to
> boot without it (no silent per-process fallback).
> **Shipped since (M1/M2/M3):** rate-limiting, input bounds, PII redaction, the operator auth gate, and
> widget tenant-identity are live (M1); the `rs_audit` INSERT-only GRANT is **applied + verified** (#19,
> see the Cloud SQL section); **per-merchant Shopify grounding is wired into the deploy + verified live
> (2026-07-31)** (M2 — see *Shopify grounding* below); and cost/latency telemetry is captured with an
> operator-gated read (M3).
> **Auth enforcement — now ON (the demo keeps working):** the service is `--allow-unauthenticated` at the
> Cloud Run edge, but `WIDGET_AUTH_REQUIRED=true` (repo variable, passed through at deploy), so the app-level
> widget-token check is the tenancy gate — a `/chat` request without a valid widget token returns **401**
> (verified live and asserted by the post-deploy smoke). The two enabling steps (both done):
> 1. **`WIDGET_TOKEN_SECRET`** (a random signing secret) is provisioned in Secret Manager and mounted into the
>    Cloud Run service (`--set-secrets WIDGET_TOKEN_SECRET=widget-token-secret:latest`) — the HMAC key for widget tokens.
> 2. **`WIDGET_AUTH_REQUIRED=true`** (set as a repo variable).
>
> The **demo keeps working** with no other change: the served widget (`packages/widget/public/index.html`)
> mints a short-TTL token from the embed key `demo-embed-key` (→ tenant `demo`) via `/widget/token`
> and sends it as a `Bearer` on `/chat`; a request without a valid token now returns 401. This exact flow —
> flag on + only the demo tenant configured → 200 under `demo` — is asserted by `widget-tenant.test.ts`
> ("WIDGET_AUTH_REQUIRED=true: the DEMO still works via the default demo-embed-key"). (The Cloud Run edge
> staying `--allow-unauthenticated` is fine: the app-level widget-token check is the tenancy gate; the edge
> is open only so the public embed can reach `/widget/token` and `/`.)
>
> **`WIDGET_EMBED_KEYS` is a required deploy env now (fail-closed).** It is the publishable
> embed-key → tenant registry, and it is **passed by `deploy-staging.yml`** as
> `{"demo-embed-key":"demo"}`. It used to be optional: the backend fell back to a built-in
> `demo-embed-key` → `demo` registry whenever the value was unset, malformed, or had any unusable entry —
> which **failed open**, because a merchant whose key is missing from the substituted registry cannot mint
> a token, and (with `WIDGET_AUTH_REQUIRED` off) its widget then serves under the `RUNTIME_TENANT`
> fallback: that merchant's sessions, audit rows, telemetry, consent records, memory namespace **and
> Shopify grounding context** all resolve under tenant `demo`, and an operator kill armed for their tenant
> would not halt them. So with `PALUP_REQUIRE_DATABASE_URL=true` (i.e. any real deployment) the service now
> **refuses to boot** unless the registry is explicitly declared, and it refuses on a malformed/partially
> invalid value in **any** environment — `resolveEmbedKeys`, `packages/widget-backend/src/server.ts`,
> mirroring `PALUP_REQUIRE_DATABASE_URL`'s own fail-fast. Local/dev (neither var set) is unchanged and
> still gets the built-in demo default. For a **real second merchant**, extend the value —
> `WIDGET_EMBED_KEYS={"demo-embed-key":"demo","<their-embed-key>":"<their-tenant>"}` — and give them that
> embed key + their own tenant id/store creds; no code change. Dropping the whole variable no longer
> degrades quietly: the revision fails its health check and the deploy goes red.
>
> **D1 — `WIDGET_EMBED_KEYS` is now a FALLBACK, not the source of truth.** Since D1 the serving path
> resolves a merchant through the **merchant registry** (`pl_merchant`) first and only falls back to this
> variable. The paragraph above still describes how the variable behaves; what changed is its *rank*. The
> full rule lives in `packages/widget-backend/src/merchant-resolver.ts`; the operator-relevant summary:
>
> | situation | what happens |
> |---|---|
> | the registry has an **active** row for the embed key | that tenant is served. The env map is not consulted. |
> | the registry has a row and it is **not** `active` | **refused (401/403)** — a stale `WIDGET_EMBED_KEYS` entry can **not** resurrect a revoked merchant |
> | the registry **could not be read** (query threw) | **refused** — an unreadable registry is not an absent row. Costs availability during a DB fault, on purpose |
> | the registry has **no row** for that key (or no `DATABASE_URL` ⇒ no registry) | the `WIDGET_EMBED_KEYS` entry is used — **logged** (`[merchant] tenant "…" resolved from the WIDGET_EMBED_KEYS ENV FALLBACK …`) and, when a registry exists, **audited once per tenant per hour** as `merchant.resolved_from_env` |
> | neither | 401 |
>
> **This is how staging's `demo` tenant keeps working**: no `pl_merchant` row names `demo`, so it resolves
> through the fallback and the post-deploy smoke gate (`?key=demo-embed-key` → live `/chat`) passes
> unchanged. It is a *named* fallback, not a silent one — `GET /health` now reports
> `"merchants":"registry+env"` (a durable registry with the fallback armed) or `"merchants":"env"`
> (local/dev, no `DATABASE_URL`).
>
> **Revocation is now real, and it is enforced per turn.** A widget token is a bearer credential with its
> own TTL (`WIDGET_TOKEN_TTL_SECONDS`, default 1h), so `/chat` re-checks `pl_merchant.status` on **every**
> request — a merchant set `uninstalled` (by the `app/uninstalled` webhook or by the CLI below) stops being
> served immediately, not when their last token expires. Before D1 they were served forever.
> `POST /forget` and `POST /consent` are deliberately **not** gated: erasure and consent withdrawal must
> outlive the install.
>
> **How to revoke or restore a merchant** (no HTTP route exists — see *How to halt the live agent* for why):
> ```bash
> pnpm exec tsx packages/widget-backend/src/jobs/merchant.ts status --tenant <tenantId> --status uninstalled
> pnpm exec tsx packages/widget-backend/src/jobs/merchant.ts status --tenant <tenantId> --status active   # reverse
> ```
> Revocation is a **status, never a delete** — the row, its `embedKey` and its `createdAt` survive, so an
> already-deployed storefront snippet works again on reactivation.
>
> **Onboarding a merchant who installed the app themselves — the two manual steps.** The install generates
> their embed key and writes it to `pl_merchant`, but **nothing hands it to them**: there is no merchant
> console and no route that returns it. So an operator must:
> ```bash
> # 1. read their embed key (and confirm status=active)
> pnpm exec tsx packages/widget-backend/src/jobs/merchant.ts show --tenant <tenantId>
> #    → acme-store  shop=acme-store.myshopify.com  embedKey=pk_…  status=active  region=us  …
> #    Give them that embedKey for their storefront snippet. It is PUBLISHABLE, not a secret.
> # 2. provision their Storefront token, or they get the FIXTURE catalog rather than their own products:
> #    add {"<tenantId>":{"shopify_storefront_token":"…"}} to the PALUP_SECRETS secret.
> ```
> Until both are done, an installed merchant is registered and revocable but **not usefully served** — which
> is exactly what the install landing page tells them ("not live on your storefront yet").
>
> **What D1 did NOT cut over** (so nobody assumes it did):
> - ~~**The Storefront token is still `SecretsPort`.**~~ **NARROWED BY D2 — see *Storefront-token
>   read-back (D2) go-live* below.** Serving reads `shopify_storefront_token` from `PALUP_SECRETS` — *not*
>   the encrypted delegate credential an install stores — **only while `MERCHANT_CRED_READBACK_ENABLED` is
>   OFF, which is the default (and how this branch ships).** ON, serving reads the custodied delegate
>   credential via `MerchantCredentialStore.read` first, and `shopify_storefront_token` becomes a
>   `missing`-only fallback (never installed) — an `unreadable` credential REFUSES rather than falling back
>   to it. With the flag OFF, **a merchant who installs themselves therefore still gets the built-in
>   FIXTURE catalog, not their own products,** until an operator provisions that secret for their tenant (or
>   completes the D2 go-live below). There is exactly one source of truth for the token while the flag is
>   off; two, ranked, while it is on.
> - ~~**`MERCHANT_REGION` / `MERCHANT_GROUNDING_MODE` are still process-wide env.**~~ **CLOSED BY D2 — see
>   *Per-merchant region* below.** A merchant is now *served* with the region on their own `pl_merchant`
>   row, i.e. the value `SHOPIFY_INSTALL_REGION` recorded. D1's `[config] SHOPIFY_INSTALL_REGION=… but
>   MERCHANT_REGION=…` boot warning **was removed**: the two variables now mean different things and
>   **should not be kept equal** (see below).
> - **The catalog-index and retention-sweep jobs still enumerate `SHOPIFY_STORES`,** so a self-installed
>   merchant is invisible to them. This is not a deferral by preference: `MerchantRegistryPort` has no
>   enumeration operation at all, so migrating those jobs needs a new port method.

## Shopify app install + compliance webhooks (C1/C2, D1)

**Both feature sets are absent-or-fully-configured** — a missing precondition means the routes are never
registered (**404**), never half-working. They have **separate** gates on purpose: letting the OAuth
redirect URI lapse must not stop honouring GDPR erasure for merchants who already installed.

**Install routes** (`GET /shopify/install` → `GET /shopify/callback`) need **all** of:

| setting | kind | notes |
|---|---|---|
| `SHOPIFY_APP_CLIENT_ID` | env | the app's OAuth client id — not a secret, it ships in the URL |
| `SHOPIFY_INSTALL_REDIRECT_URI` | env | must **also** be registered as an allowed redirect URL on the Shopify app |
| `SHOPIFY_INSTALL_REGION` | env | `us`\|`eu`\|`uk`\|`other`. **Required, no default** — an unset var must not make a residency decision. Since D2 this is the region a new merchant is both *recorded with* and *served under*; it does **not** need to equal `MERCHANT_REGION` (see *Per-merchant region*) |
| `SHOPIFY_INSTALL_SCOPES` | env, optional | defaults to `unauthenticated_read_product_listings` |
| `SHOPIFY_DELEGATE_SCOPES` | env, optional | comma-separated; must be covered by what the merchant granted |
| `shopify_app_client_secret` | **secret** | in `PALUP_SECRETS` under the **app-scoped** pseudo-tenant `__shopify_app__`: `{"__shopify_app__":{"shopify_app_client_secret":"…"}}` |
| `DATABASE_URL` | secret | an in-memory registry is refused — it would forget every install on the next cold start while reporting success |

**Compliance webhooks** need only the last two (`shopify_app_client_secret` + `DATABASE_URL`), because
Shopify signs webhook HMACs with the same app client secret — **no new env var, no new secret**:

- `POST /shopify/webhooks/customers/data_request`
- `POST /shopify/webhooks/customers/redact`
- `POST /shopify/webhooks/shop/redact`
- `POST /shopify/webhooks/app/uninstalled` ← the topic that makes revocation real (see D1 above)

`AUDIT_HMAC_SECRET` is the keyed-HMAC key for audit `subjectRef`s, so a low-entropy numeric customer id is
never recorded as a bare hash. It is **optional to BOOT** and falls back to `SHOPPER_TOKEN_SECRET` — but
**corrected 2026-08-06: it is NOT optional for memory go-live.** Checklist **B5** requires it, because with
neither variable set the effective key is `undefined`, and then `subjectRef` degrades to an unsalted digest
that `widget-memory/src/audit.ts` states is unsafe for a low-entropy `acct:` subject, `server.ts` skips the
identity audit entirely, and the Shopify webhook path records the literal
`"unreferenced (no AUDIT_HMAC_SECRET configured)"`.

**It is provisioned and live on staging as of 2026-08-06** (secret `audit-hmac-secret`, mounted via the
`AUDIT_HMAC_SECRET_NAME` repo variable, verified present on the serving revision). Provision it **before the
first real write**, not after: changing the key changes every `subjectRef`, so audit rows for the same
subject stop correlating across the change. Full three-step procedure — including the IAM grant that is easy
to miss and breaks every deploy — is under *One-time setup* below.

**Two KV collections** these add to `rs_kv` (no migration — the runtime store's own table):
`shopify_webhook_seen` (delivery dedup, TTL'd) and `shopify_data_requests` (the `customers/data_request`
record). Pending installs live in `shopify_install_pending` under the reserved tenant `__shopify_app__`.

**A per-merchant encryption key is required at install time and cannot be checked at boot** (the tenant is
unknown until someone installs): `MEMORY_ENCRYPTION_KEY__merchant-cred`, per tenant, in the same
`PALUP_SECRETS` map. Without it the delegate token cannot be encrypted, so the callback **refuses** —
502, no row, no credential, nothing stored in the clear. Its rotation slot is
`MEMORY_ENCRYPTION_KEY__merchant-cred_previous` and it follows the **same two-step procedure** as
`MEMORY_ENCRYPTION_KEY` (below): copy current → `_previous`, put new at the base name. Two honest limits
carried over: nothing re-encrypts existing rows for you (a row moves to the new key only when it is
written again — i.e. on re-install), and rotating the merchant's **token** is a different operation from
rotating the **key**. The `__merchant-cred` scope exists so that a compromise of `MEMORY_ENCRYPTION_KEY`
does **not** expose stored merchant credentials.

## Embedding the widget on a storefront (theme app extension)

The shopper widget mounts on a merchant's live storefront via a Shopify **theme app extension**
(`extensions/palup-widget/`) — not a manual snippet or the deprecated ScriptTag API. Full design:
`docs/superpowers/specs/2026-08-10-embeddable-widget-design.md`.

**Install path:**
1. `shopify app deploy` (human, Partners account) registers the app **and** the `palup-widget` app-embed
   extension (`extensions/palup-widget/shopify.extension.toml`: `type = "theme"`, `api_version = "2026-07"`
   — matches the api version pinned in `shopify.app.toml`'s `[webhooks]` block). `docs/PATH-TO-PRODUCTION.md`
   notes this deploy has never been run (`shopify.app.toml:10`: "this repo does not deploy via the Shopify
   CLI today").
2. The merchant enables the app embed in their theme editor (Shopify's built-in on/off toggle — no code on
   their side). Enabling it injects `blocks/app-embed.liquid`'s `<script>` tag onto every storefront page.
3. That script (`data-shop="{{ shop.permanent_domain }}" data-position="…"`) loads `GET /embed/loader.js` —
   the bundled loader IIFE (`bundleLoader()`, esbuild over `packages/widget/src/loader-entry.ts`,
   `packages/widget-backend/src/routes/embed.ts`) — which mounts a closed-shadow launcher and, on first
   open, an iframe at `GET /embed/panel?shop=…` (the chat UI, with a per-shop `frame-ancestors` CSP).
4. The panel mints a widget token via `GET /widget/token?shop=…`. Tenant resolution is by **shop domain**
   via `merchants.tenantForShopDomain` (`merchant-resolver.ts:254,567`; called from `server.ts:1133`): the
   merchant registry (`pl_merchant`, populated by a completed OAuth install) wins when an **active** row
   exists for that domain; otherwise `SHOPIFY_STORES`/`WIDGET_EMBED_KEYS` is the named fallback — today the
   only populated case, and how the `demo` tenant is served.

**Custom domains are supported for the panel's CSP.** A merchant browsing their storefront on their own
domain (e.g. `shop.their-brand.com`) rather than `*.myshopify.com` still gets a widget that renders,
because `GET /embed/panel`'s `frame-ancestors` widens to include that domain too — resolved **server-side
only**, via `merchants.primaryDomainForShop(shop)` (`merchant-resolver.ts`), keyed by the already-accepted
`?shop=` and never a second client-supplied parameter. Precedence is registry-first, same as identity: an
**active** `pl_merchant` row's own `primaryDomain` wins (including "explicitly no custom domain
configured" — a row that exists never blends with the env fallback below), a **revoked** row resolves to
no custom domain, and only the **absence of any row at all** falls through to the named
`SHOPIFY_PRIMARY_DOMAINS` env var (same JSON shape as `SHOPIFY_STORES`, but keyed by **shop domain**
rather than tenant: `{"<shop>.myshopify.com": "<custom-domain>"}`).

Populate a merchant's custom domain one of two ways:
- **`SHOPIFY_PRIMARY_DOMAINS`** — the named env fallback, for the same "no registry row yet" posture
  `SHOPIFY_STORES`/`WIDGET_EMBED_KEYS` already use (local/dev/e2e, or any tenant with no `pl_merchant` row).
- **The operator CLI** — `pnpm exec tsx packages/widget-backend/src/jobs/merchant.ts set --tenant
  <tenantId> --primary-domain <host>`, which writes it durably to the merchant's own registry row (read
  back and audited, like every other `set`/`status` change — see `jobs/merchant.ts`'s own header).

Both paths validate the value as a bare hostname (trim + lowercase; no scheme, path, port, space, `;`, or
CR/LF) — the write-time guard — and the panel route re-validates it again immediately before it enters the
`Content-Security-Policy` header, so a hand-edited registry row can never widen framing to an arbitrary
value. **Install-time auto-population is a deferred fast-follow, not built here:** the OAuth install
(`shopify-install.ts`) does not call Shopify's Admin API for the shop's `primaryDomain` today, so a
merchant who installs still needs one of the two paths above populated by hand until that call is added.

**The deploy-time host placeholder — no substitution mechanism exists yet.** Both
`extensions/palup-widget/blocks/app-embed.liquid:12` (`https://REPLACE_WITH_APP_HOST/embed/loader.js`) and
`shopify.app.toml:25` (`application_url = "https://REPLACE_WITH_APP_HOST"`) carry the literal string
`REPLACE_WITH_APP_HOST`. Grepped the repo for anything that substitutes it (build script, `sed`, CI step,
`pnpm` task): **none exists.** `shopify app deploy` alone does not fill it in — a human must hand-edit both
occurrences to the real app host (or a build/templating step must be added later) **before** that deploy is
meaningful for real traffic.

**A merchant who installs today still gets the fixture catalog, not their own products — while
`MERCHANT_CRED_READBACK_ENABLED` is OFF, which is the default and how this branch ships.** The OAuth
install (`shopify-install.ts`) records a `pl_merchant` row and a shop domain, which is enough for the embed
to resolve a tenant. With the flag OFF, serving reads the Storefront access token from `SecretsPort`
(`shopify_storefront_token`, hand-provisioned per tenant), never the delegate credential the install
captures (`merchant-store.ts:16,54-61`), and until an operator provisions that secret for a tenant,
`resolveShopifyStore` returns `undefined` and that merchant's shoppers ground on the built-in fixture
catalog — the embed extension alone does not close this gap. With the flag ON, serving reads the install's
own custodied delegate credential first (see *Storefront-token read-back (D2) go-live* below) and only
falls back to `shopify_storefront_token` for a tenant with no custodied credential at all. See *Shopify app
install* above ("Onboarding a merchant who installed the app themselves") and
`docs/PATH-TO-PRODUCTION.md` Phase 1 #2/#3.

**Extension schema — consistent with `shopify.app.toml`, not live-validated.** The schema shape
(`type = "theme"`, one app-embed block, `target: "body"`, one `position` select setting in
`app-embed.liquid`'s `{% schema %}`) matches the documented app-embed block conventions and the api version
`shopify.app.toml` already pins, but neither file has been rendered by real Shopify tooling.
`packages/widget/test/app-embed-liquid.test.ts` asserts the rendered Liquid as a string, not a live
Shopify theme-editor render. `shopify app deploy` is the validation step — it may surface schema issues
this repo cannot catch statically.

## Sample storefront (staging demo)

The staging root (`palup-widget-staging-…run.app/`) serves a **production-credible sample storefront** for the
demo tenant (`palup-skincare-jason`), not a bare stand-in. Fastify serves it, read at boot from
`packages/widget/public/storefront/`:

- `GET /` → home (product grid), `GET /product/:handle` → PDP, `GET /cart` → cart; `GET /storefront/app.css|app.js`.
- The pages render the SAME live catalog the assistant is grounded on, via `GET /storefront/catalog?shop=<domain>`
  (`routes/storefront-catalog.ts`) — public, uniform-404 (no oracle), per-IP + fail-closed per-tenant
  rate-limited, served behind the 30-min grounding cache. Storefront and assistant finally agree.
- Each page embeds the widget through the **real loader** (`<script src="/embed/loader.js" data-shop=…>`); the
  panel is framed same-origin (the panel's `frame-ancestors` now includes `'self'`), and the shopper's cart +
  page context reach the widget via the loader's `palup:context` bridge (whitelisted to `{productId, quantity}`).
- The widget is **brand-themed** per tenant (`widget-theme.ts`, server-injected into `/embed/panel`; launcher via
  `GET /embed/theme?shop=`), contrast-safe by construction.
- The standalone widget harness (the old inlined demo) moved to `GET /widget` (test/dev only).

**Lighting up the sales-partner surfaces on this demo is a §5 human step** (not a build agent's). Set the
GitHub Actions vars `PRODUCT_CITATIONS` + `PRODUCT_CARDS` + `CART_LINE_ITEMS` (product cards + one-tap cart
deep-links + cart signals), `GREETING_PROACTIVE` (first-touch greeting — still a **draft PR**, needs
agent-evolution-steward + §5 approval), and `MEMORY_ENABLED` (returning-shopper nurture — gated by
`MEMORY-GO-LIVE-CHECKLIST.md`); run `pnpm catalog:enable --scope platform|tenant:<id> --on` if catalog
retrieval is needed; and `pnpm grounding:invalidate <tenant>` at cutover so the first grounded turn carries
the new product images/handles. Verify the live catalog actually has product images + working variant ids
(`pnpm shopify:verify` / `pnpm model:smoke`) before relying on photos/cart deep-links.

## Per-merchant region (D2) — the setting that decides a consent regime

`region` is not a label. It selects the **consent regime**: `consentPermits(region, "ordinary", value)` is
`region === "us" ? value !== "out" : value === "in"` (`packages/widget-brain/src/consent-rules.ts`). Serving
an EU merchant under `us` therefore does not mislabel anything — it converts an **opt-in** regime into an
**opt-out** one and stores cross-visit facts about shoppers who never agreed. Before D2 that was guaranteed
for every merchant whose residency differed from the one process-wide `MERCHANT_REGION`.

| situation | region + groundingMode used |
|---|---|
| the merchant has an **active** `pl_merchant` row with a valid `region` | **that row's** `region` and `grounding_mode`. `MERCHANT_REGION` is not consulted |
| the merchant has **no row** (or there is no registry) | `MERCHANT_REGION` / `MERCHANT_GROUNDING_MODE` — the named fallback, same rank `WIDGET_EMBED_KEYS` has for identity. **This is staging's `demo` tenant** |
| the row is active but its `region` is missing / not in the enum | **REFUSED** — 401 at `/widget/token`, 403 + flag `merchant_region_unset` at `/chat`. Audited as `merchant.region_unset`. It is *never* defaulted to `MERCHANT_REGION` |
| the registry could not be read | **REFUSED** (D1's rule, unchanged) |

**Why the third row refuses instead of falling back.** An absent row is an unambiguous fact — nobody claims
this tenant, so the operator's env map is the only claim there is, and using it is legitimate. An *active*
row with no usable region is a merchant we **have**, whose jurisdiction we do **not know**; substituting
`MERCHANT_REGION` there is a residency decision made by a variable nobody set for that merchant, which is
the exact thing that makes `SHOPIFY_INSTALL_REGION` and `NewMerchant.region` required with no default. A
wrong region is undetectable after the fact; a refused merchant is visible within one page load.
`groundingMode` deliberately does **not** refuse — it is product policy, not law, so an unusable value
degrades to the most restrictive mode (`off`) and keeps the store served.

**Fix a refused merchant** (one command, effective on the next request — nothing is deleted or reset):
```bash
pnpm exec tsx packages/widget-backend/src/jobs/merchant.ts set --tenant <tenantId> --region us|eu|uk|other
pnpm exec tsx packages/widget-backend/src/jobs/merchant.ts set --tenant <tenantId> --grounding-mode off|general|full
```
Do **not** guess the value.

**`MERCHANT_REGION` and `SHOPIFY_INSTALL_REGION` now mean different things and may legitimately differ:**
`SHOPIFY_INSTALL_REGION` is the residency **new installs are recorded with**; `MERCHANT_REGION` is the
fallback for tenants with **no row**. A US-hosted deployment onboarding EU merchants should set them
differently. D1's boot warning that they must match was removed for exactly this reason.

**One wire-contract change:** `/chat` responses that answer *before* a merchant is resolved (oversize input,
unauthenticated, rate-limited, and the servability refusal) now report `consentMode: "opt_in"` — the
stricter regime — instead of the process default. The shipped widget throws on any non-2xx before reading
the body, so it never sees these; the change is about not asserting a jurisdiction we did not resolve.

## Storefront-token read-back (D2) go-live

**This ships DARK: `MERCHANT_CRED_READBACK_ENABLED` defaults to OFF, and it is OFF on this branch.** The
OAuth install → delegate-mint → Storefront-read chain this section describes has **never been run against
a real Shopify store from this repo** — the verification harness in step (c) below is exactly the step that
would prove it, and nobody has run it. Nothing here means a merchant is being served live today; it is the
runbook for the operator who later does step (a)–(e) below, one merchant at a time.

**What changes when the flag is ON.** Off, credential resolution is unchanged from D1: `resolveShopifyStore`
reads `shopify_storefront_token` from `SecretsPort` only (`packages/widget-backend/src/merchant-store.ts`).
On, `resolveStorefrontCredential` (same file) becomes a three-way resolver:

| `MerchantCredentialStore.read` result | outcome |
|---|---|
| `found` (a custodied delegate credential decrypts) | used live |
| `missing` (never installed, or deleted) | falls back to `shopify_storefront_token` in `SecretsPort` — the pre-D2 behavior, unchanged |
| `unreadable` (a row exists but is malformed or fails to decrypt) | **REFUSES** — never fixtures, never the `SecretsPort` fallback |

`/chat`'s own pre-flight (`packages/widget-backend/src/server.ts:1964-1988`) runs the same check before the
model turn, so an `unreadable` credential is refused there too, not only inside grounding.

**The crypto secret.** The delegate credential is encrypted under its own `CryptoPort` key scope,
`MERCHANT_CRED_KEY_SCOPE = "merchant-cred"` (`packages/state-postgres/src/merchant-credential-store.ts:76`).
For the default secret base name, `keyScopeSecretName("MEMORY_ENCRYPTION_KEY", "merchant-cred")`
(`packages/platform-ports/src/crypto-port.ts:147`, separator `"__"` at line 106) resolves to
**`MEMORY_ENCRYPTION_KEY__merchant-cred`**, provisioned per tenant in the same `PALUP_SECRETS` map as
described under *Shopify app install + compliance webhooks* above — that secret is required at **install**
time too (a missing key there makes the OAuth callback refuse with 502 and store nothing, before D2 even
applies). At **read** time, a missing or wrong key for this scope is exactly the `unreadable` case above:
the shopper sees the graceful 503 below, **never fixtures**, and never a silent "unconfigured" treatment —
an unreadable credential must never be mistaken for an absent one (see *Rotating `MEMORY_ENCRYPTION_KEY`*
above for why the two failure modes are reported differently on purpose).

**The flag.** `MERCHANT_CRED_READBACK_ENABLED` (`packages/widget-backend/src/server.ts:307`) — env, exact
string `"true"`, default OFF. ON logs a boot warning
(`[boot] MERCHANT_CRED_READBACK_ENABLED=true — serving reads custodied delegate tokens (D2 read-back).`)
and constructs a read-capable `MerchantCredentialStore` handle reused by both grounding and the `/chat`
pre-flight; OFF constructs nothing, so an off/unconfigured deployment never attempts a credential read at
all — identical behavior and cost to before D2. It is a single **global** switch, not per-tenant — see
*Deferred* below.

**Ordered go-live for ONE merchant** (operator-run; requires a real Shopify dev store; none of this has
been executed yet):

1. `shopify app deploy` (Partners account) plus the install env vars — `SHOPIFY_APP_CLIENT_ID`,
   `SHOPIFY_INSTALL_REDIRECT_URI`, `SHOPIFY_INSTALL_REGION`, and `shopify_app_client_secret` in
   `PALUP_SECRETS` under `__shopify_app__` (see *Shopify app install + compliance webhooks* above).
2. The merchant installs on their (dev) store via `GET /shopify/install` → `GET /shopify/callback`. The
   callback custodies the delegate token with `MerchantCredentialStore.put`, which requires
   `MEMORY_ENCRYPTION_KEY__merchant-cred` for their tenant to already be provisioned — missing it makes the
   callback return 502 and store nothing.
3. **Before touching the flag**, prove the custodied token actually authenticates a Storefront read, with
   the operator harness (`packages/widget-backend/src/shopify-verify-smoke.ts` — its own doc comment is the
   source for this invocation):
   ```bash
   SHOPIFY_APP_CLIENT_ID=<the app's OAuth client id> \
   PALUP_SECRETS='{"__shopify_app__":{"shopify_app_client_secret":"<the app's OAuth client secret>"}}' \
   pnpm shopify:verify <shop>.myshopify.com <code>
   ```
   `<code>` is the single-use, short-lived OAuth code Shopify appends to the redirect once the merchant
   approves the install: build the authorize URL (`buildInstallAuthorizeUrl`,
   `shopify-install-identity.ts`), open it against the real dev store, approve, and copy `code` from the
   redirect's query string **immediately** — a stale or already-used code makes the harness print
   `FAIL (exchange)` rather than throw. On success it prints `PASS — read N product(s) via the Storefront
   API` plus the granted/access scope arrays; it **never** logs or returns the token itself.
4. Flip `MERCHANT_CRED_READBACK_ENABLED=true` (repo variable / deploy env). From the next request, serving
   attempts to read this merchant's custodied credential.
5. **Only now** clear any grounding-cache entry already holding fixture context for this tenant, so the
   first grounded turn after go-live reflects the real catalog instead of a stale fixture
   (`jobs/merchant.ts`'s own `invalidate-grounding` doc string):
   ```bash
   pnpm grounding:invalidate --tenant <tenantId>
   ```
   (Documented here as the CLI actually parses it — `--tenant <tenantId>`, the same flag grammar
   `show`/`status`/`set` already use in `jobs/merchant.ts` — rather than as a bare positional argument.)

   **Order matters, and it is reversed from earlier drafts of this runbook.** Invalidating BEFORE the flip
   left a window — any shopper turn between the invalidate and the flip — that re-populated the cache with
   the fixture catalog for the full TTL (30 min default), because credential read-back was still off at that
   moment. Flipping first is safe: while the flag is off nothing re-caches fixtures for this tenant path
   differently than before, and once it is on, `resolveStorefrontCredential`'s `refuse` outcome is never
   cached (it throws — `createCachingGroundingPort` only writes on a successful `inner.getContext`), so the
   worst a shopper turn between steps 4 and 5 can do is cache one stale-but-real read that step 5 then
   replaces. A `live` resolve in that window caches the merchant's real catalog, which invalidation then
   correctly discards so step 5's read is fresh.

**Refusal behavior.** An `unreadable` credential makes `POST /chat` return **503** with
`flags: ["grounding_unavailable"]` and the shopper-facing reply *"This store's assistant is temporarily
unavailable. Please try again shortly."* — never fixtures, never an empty catalog, and no hint that this is
specifically a credential/decryption problem (`server.ts:1964-1988`). This is deliberately a **different**
shape from the servability 403 above (transient/operator-fixable, not a revocation).

**Deferred — not built in this change, tracked, not guessed at:**
- **Embed-key delivery** — nothing hands an operator-free merchant their own embed key today.
- **Merchant-console self-serve go-live** (+ its own `HITL-POLICY.md` entry + App-Bridge auth) — steps 1–5
  above are entirely operator/CLI-run; there is no in-product flow.
- **Per-merchant read-back enablement** — `MERCHANT_CRED_READBACK_ENABLED` is one process-wide flag, not a
  per-tenant toggle; flipping it changes behavior for every merchant whose credential is already custodied.
- **Catalog-index blind spot for a read-back-only merchant.** `jobs/catalog-index.ts` enumerates
  `SHOPIFY_STORES` and resolves creds via `resolveShopifyStore` — not `resolveStorefrontCredential`'s D2
  read-back path — so a merchant served only through this go-live is never vector-indexed. If this
  deployment also has `CATALOG_RETRIEVAL=true`, their shoppers keep getting the full-catalog fallback, not
  top-K retrieval, until an operator adds them to `SHOPIFY_STORES` too (or the index job gains registry
  enumeration — see D1's *not cut over* note above on why that's a separate `MerchantRegistryPort` change).
- **Returns/shipping policy-scope widening.**
- **Embedded/iframe install.**
- The 7 install-boot preconditions in staging, and memoizing the credential read across the `/chat`
  pre-flight + the grounding router (today a double decrypt per grounded turn — correct, not yet
  optimized).

## What the staging deploy actually passes (D3)

`--set-secrets` and `--set-env-vars` **replace the whole set on every deploy**, so anything not listed in
`.github/workflows/deploy-staging.yml` is dropped on the next merge. Track B repeatedly documented env vars
here and passed none of them; `packages/widget-backend/test/deploy-staging-env.test.ts` is now a unit test
over that workflow file so the list cannot silently lose an entry again. (It proves the *list*, not the
deploy — only a real deploy proves that.)

**Always passed** — `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`, `PALUP_MODEL`,
`PALUP_REQUIRE_DATABASE_URL`, `WIDGET_AUTH_REQUIRED`, `MERCHANT_CRED_READBACK_ENABLED`, `WIDGET_EMBED_KEYS`,
`SHOPIFY_STORES`, and (new in D3) `MERCHANT_REGION` + `MERCHANT_GROUNDING_MODE`. Secrets: `DATABASE_URL`,
`WIDGET_TOKEN_SECRET`, `PALUP_SECRETS`.

**Optional, driven by repo variables** (`Settings → Secrets and variables → Actions → Variables`). Each is
appended only when set, so an unset one never produces an empty env pair:

| repo variable | effect |
|---|---|
| `MERCHANT_REGION` / `MERCHANT_GROUNDING_MODE` | the D2 fallback for tenants with no row. Default `us` / `full` — the same values the code already assumed, now visible instead of implied |
| `SHOPIFY_APP_CLIENT_ID`, `SHOPIFY_INSTALL_REDIRECT_URI`, `SHOPIFY_INSTALL_REGION` | **all three or none.** A partial set **fails the deploy** with a `::error::` rather than leaving `/shopify/*` silently 404. An invalid `SHOPIFY_INSTALL_REGION` also fails the deploy |
| `SHOPIFY_INSTALL_SCOPES`, `SHOPIFY_DELEGATE_SCOPES` | optional overrides of the code defaults |
| `AUDIT_HMAC_SECRET_NAME` | the **name of an existing Secret Manager secret**, which is then mounted as `AUDIT_HMAC_SECRET` |
| `GUEST_TOKEN_SECRET_NAME` | the **name of an existing Secret Manager secret**, mounted as `GUEST_TOKEN_SECRET` (ADR-0019 R2-4). Unset ⇒ not mounted ⇒ guest tokens cannot be minted — three-step procedure below, right after `AUDIT_HMAC_SECRET`'s |

**What an operator must create before any of this does anything.** These are *not* provisioned by this
change and the deploy does not create them:

1. **`shopify_app_client_secret`** inside the existing `palup-secrets` payload, under the app-scoped
   pseudo-tenant: `{"__shopify_app__":{"shopify_app_client_secret":"…"}}`. Until it exists, `/shopify/*`
   stays **404 even with all three env vars set** — both C1's install gate and C2's webhook gate read it.
   It is a JSON entry in a secret that is already mounted, so there is nothing to add to the workflow.
2. **`MEMORY_ENCRYPTION_KEY__merchant-cred`** per installing tenant, in the same `palup-secrets` payload.
   Also nothing to add to the workflow. Missing ⇒ the install callback returns **502** and stores nothing.
3. **An `AUDIT_HMAC_SECRET` secret**, needed for a keyed subject ref in memory + GDPR-erasure audit rows
   (`MEMORY-GO-LIVE-CHECKLIST.md` B5). Without it those rows record the literal
   `unreferenced (no AUDIT_HMAC_SECRET configured)` — a documented degradation, not a crash, which is why
   the workflow does **not** hard-code a mount for it: a `--set-secrets` reference to a secret that does
   not exist makes `gcloud run deploy` itself fail and would break **every** merge until someone created it.

   **It takes THREE steps, not two, and skipping the third breaks every deploy.** Learned the hard way on
   2026-08-06: the secret was created and `AUDIT_HMAC_SECRET_NAME` was set, which makes the mount
   unconditional — and the very next deploy failed at *Creating Revision* with
   `Permission denied on secret … audit-hmac-secret … must be granted roles/secretmanager.secretAccessor`.
   Cloud Run's rollout safety contained it (the bad revision never became ready, traffic stayed on the
   previous one, staging kept serving), but **no further deploy can succeed until the grant exists**,
   because the mount is now always attempted.

   ```bash
   # 1. create the secret
   openssl rand -base64 48 | gcloud secrets create audit-hmac-secret \
     --data-file=- --replication-policy=automatic --project "$GCP_PROJECT"

   # 2. GRANT THE RUNTIME SERVICE ACCOUNT ACCESS — the step that is easy to miss.
   #    Every other mounted secret (palup-secrets, palup-staging-database-url, widget-token-secret) already
   #    has this exact per-secret binding; there is no project-level secretAccessor to inherit from.
   gcloud secrets add-iam-policy-binding audit-hmac-secret \
     --member="serviceAccount:$(gcloud projects describe "$GCP_PROJECT" --format='value(projectNumber)')-compute@developer.gserviceaccount.com" \
     --role=roles/secretmanager.secretAccessor --project "$GCP_PROJECT"

   # 3. only now point the workflow at it
   gh variable set AUDIT_HMAC_SECRET_NAME --body audit-hmac-secret
   ```

   Verify with `gcloud secrets get-iam-policy audit-hmac-secret` — it must list
   `roles/secretmanager.secretAccessor` for the `-compute@developer.gserviceaccount.com` service account,
   matching the other three secrets. **Changing this key later changes every `subjectRef`**, so old and new
   audit rows stop correlating for the same subject: provision it before the first real memory write.
4. **A `GUEST_TOKEN_SECRET` secret** (ADR-0019 Revision 2, task 2 — `docs/adr/0019-server-issued-guest-identity.md`
   R2-4), the HMAC key for the server-issued guest identity token. It is deliberately a **SEPARATE** secret
   from `WIDGET_TOKEN_SECRET` and `SHOPPER_TOKEN_SECRET`: sharing a key would mean one compromise both
   impersonates a merchant principal *and* forges a guest token for any `aid` — squatting restored, the
   exact failure ADR-0019 exists to make structurally impossible. For the identical reason as
   `AUDIT_HMAC_SECRET` above, the workflow does **not** hard-code a mount for it: a `--set-secrets`
   reference to a secret that does not exist makes `gcloud run deploy` itself fail and would break
   **every** merge until someone created it. It mounts only once an operator names an existing secret in
   the `GUEST_TOKEN_SECRET_NAME` repo variable.

   **It takes the SAME three steps as `AUDIT_HMAC_SECRET`, and skipping the third breaks every deploy the
   same way** — the runtime service account needs `roles/secretmanager.secretAccessor` on the secret;
   `roles/editor` (what it already has) does **not** include `secretmanager.versions.access`, so without
   this grant the very next deploy fails at *Creating Revision*, exactly as B5 did on 2026-08-06.

   ```bash
   # 1. create the secret
   openssl rand -base64 48 | gcloud secrets create guest-token-secret \
     --data-file=- --replication-policy=automatic --project "$GCP_PROJECT"

   # 2. GRANT THE RUNTIME SERVICE ACCOUNT ACCESS — the step that is easy to miss.
   gcloud secrets add-iam-policy-binding guest-token-secret \
     --member="serviceAccount:$(gcloud projects describe "$GCP_PROJECT" --format='value(projectNumber)')-compute@developer.gserviceaccount.com" \
     --role=roles/secretmanager.secretAccessor --project "$GCP_PROJECT"

   # 3. only now point the workflow at it
   gh variable set GUEST_TOKEN_SECRET_NAME --body guest-token-secret
   ```

   Verify with `gcloud secrets get-iam-policy guest-token-secret` — it must list
   `roles/secretmanager.secretAccessor` for the `-compute@developer.gserviceaccount.com` service account.

   **Until all three steps are done, `GUEST_TOKEN_SECRET` is not mounted and guest tokens simply cannot be
   minted — ADR-0019's guest-identity feature stays inert.** That is the **correct state today**: this is
   only ADR-0019 task 2 (the conditional-mount wiring + this procedure). `mintGuestToken` /
   `createGuestTokenIdentity` exist in `packages/platform-ports` (task 1, merged), but no server route
   calls them yet — so provisioning this secret does not, by itself, mint anything. **UPDATE 2026-08-17:**
   ADR-0019 tasks 1–9 shipped (`POST /widget/guest` mint/renew now exists, `server.ts`), and
   `MEMORY_ADR_ACCEPTED` is flipped `true` for INTERNAL STAGING (`packages/widget-memory/src/flag.ts`), so
   for the staging memory enablement `GUEST_TOKEN_SECRET` IS provisioned + named (A4 condition 2) — the
   "inert / not built" framing above is the pre-2026-08-17 state, kept for the provisioning steps it
   documents. (ADR-0019 task 10, the guest→account carry-over, stays unbuilt + legal-gated.)
5. **The `pl_merchant` grants** (`GRANT SELECT, INSERT, UPDATE … TO palup_app`, deliberately no `DELETE`) —
   see *Cloud SQL* below. `migrate()` runs the DDL at boot only when the install or webhook routes are
   enabled, i.e. only once (1) exists.

**The post-deploy smoke gate gained one check:** `/health` must report `merchants` starting with
`registry`. `env` there would mean no durable merchant registry is reachable, so revocation would not
revoke and every tenant would be served under the process's region — the two properties D1 and D2 exist to
provide. It fails the gate rather than passing quietly.

## How to halt the live agent

Governance non-negotiable #4 — *any agent, at any scope, halted instantly*. The three commands below are
the supported way to do it; they are the **only** arming path that works against the current deployment
(the control-plane operator console — `POST /api/runtime-kill` — is the same registry, but that service
**is not deployed**; `deploy-staging.yml` deploys only `palup-widget-staging`).

```bash
export DATABASE_URL=…                                  # MUST be the store the backend uses (see below)

pnpm kill:arm    --scope global --reason "checkout bug — <your name>"   # halt everything, now
pnpm kill:status                                                       # what is armed right now
pnpm kill:disarm --scope global                                        # resume
```

**Scopes** (exactly these; there is no default — a missing `--scope` is refused, so a forgotten flag can
never halt the platform by accident):

| `--scope` | Halts |
|---|---|
| `global` | every tenant, every run-time agent |
| `tenant:<id>` | one merchant (`tenant:demo` is the staging/demo tenant) |
| `agent:shopper` | the shopper agent type platform-wide (`shopper` is the only run-time agent type today) |
| `all` | **disarm only** — lifts every armed scope. `arm --scope all` does not exist. |

**Getting `DATABASE_URL`.** The value mounted into Cloud Run is the Secret Manager secret
`palup-staging-database-url`, and it connects over the Cloud SQL **unix socket**
(`host=/cloudsql/palup-jason:us-central1:palup-staging`) — that path exists inside Cloud Run, not on a
laptop. So from a workstation either (a) run the Cloud SQL Auth proxy for
`palup-jason:us-central1:palup-staging` and build a `postgres://palup_app:<palup-staging-pg-app>@127.0.0.1:5432/palup`
URL, or (b) run the command from a shell that already has the socket (e.g. a Cloud Run job/exec on the
same instance). *(The proxy route is the standard Cloud SQL pattern; it has not been exercised against
this instance as part of this change — the drill in the PR that added these scripts ran against a real
Postgres engine in-process, not against staging.)* If `DATABASE_URL` is unset the tool **refuses to run**
rather than falling back to a per-process store that the deployed backend would never see.

**What a halt actually stops** (all verified in `packages/widget-backend/src/server.ts`):

- `POST /chat` → the reply comes back with `escalate: true`, `pitch: "none"`, `flags: ["kill_switch"]`; the
  model is never called.
- `POST /consent` and `POST /forget` → `503 {"error":"paused"}` (the audited consent write and the
  erasure path are halted too).
- The customer-account OAuth routes → no new credential flow is started.
- `pnpm sweep` (scheduled retention) → skips every halted tenant before deleting anything.
- Promotion of new agent behavior to the live shopper agent (control-plane `promoteToServing`) fails
  closed while `global` or `agent:shopper` is armed.

**What it does not do:** it does not stop the process, drop traffic at the edge, or roll anything back. The
widget stays up and degrades to escalation. It is also **not** an erasure — nothing is deleted by arming.

**Notes.**
- Every arm/disarm writes an immutable audit row (`runtime_kill.arm` / `runtime_kill.disarm`) in the same
  transaction as the registry write (NN #5). The audit actor is always `operator`, so **name yourself in
  `--reason`** — that string is the only record of who halted the platform.
- Each run prints the measured decision→halt-confirmed latency, and confirms by **reading the registry
  back**; if the scope is not armed afterwards the command fails loudly instead of reporting success.

## How to put the agent in basic mode (cost cap)

§8a invariant 14 — *at the billing cap: no proactive; live chat continues; the customer never sees billing
state*. **This is not a halt.** At cap the shopper is still answered normally; the agent just stops
*initiating*. If you want to stop the agent, use the kill switch above instead.

```
pnpm cap:set    --scope global|tenant:<id> [--reason "you, and why"]
pnpm cap:status
pnpm cap:clear  --scope global|tenant:<id>|all
```

Same registry-and-CLI shape as the kill switch, and the **same `DATABASE_URL` requirement and caveats** —
see *Getting `DATABASE_URL`* above; unset ⇒ the tool refuses rather than writing to a per-process store the
deployed backend would never read. `--scope` is **never** defaulted: a forgotten flag would otherwise put
every merchant on the platform into basic mode. `cap:set --scope all` does not exist; only `cap:clear` may
widen to `all`.

**What a cap actually changes** (`packages/widget-brain/src/brain.ts`, proactive rung):

- A proactive exit-intent trigger goes **quiet** — `pitch: "none"`, empty reply, `flags: ["at_cap", …]`.
  This holds even with a high-value cart and a satisfied shopper, which is the case a
  conversion-maximising policy would most want to fire on.
- **Reactive turns are untouched.** Product questions, support, and safety all behave exactly as normal —
  a safety report still escalates. Cost never suppresses safety.
- No reply mentions billing, plans, limits, quotas or usage, including when the shopper asks why the agent
  went quiet. The `at_cap` flag is operator-facing only and never reaches shopper-visible text.

**Direction of safety.** `cap:set` only ever *removes* autonomy and cannot spend money, so it is safe to
apply automatically — that is what a circuit-breaker is. `cap:clear` *restores* autonomy, so the audit
attributes a set to `cost-circuit-breaker` and a clear to `operator`: a machine may apply a cap, only a
person lifts one. Adjusting the COGS cap **number** is a Policy change and is not done with this tool
(`docs/design/cost-margin-telemetry.md`).

**Not built yet, so that nobody assumes otherwise:** nothing automatically converts measured spend into a
cap. The control plane measures cost, but an **operator sets the cap today**. The control-plane routes
(`POST /api/cost-cap`, `POST /api/cost-cap/clear`) are the same registry, but that service is **not
deployed** by `deploy-staging.yml`, so the CLI above is the only path that works — which is why the audit's
`reversalPath` names the CLI first.
- A halt propagates to every serving instance because the registry lives in the shared Cloud SQL store —
  which is exactly why `DATABASE_URL` must be the deployment's own.

## Cloud SQL (run-time state store, ADR-0004)

- **Instance:** `palup-staging` (Postgres 16, `db-f1-micro`, single-zone, `us-central1`), connection name
  `palup-jason:us-central1:palup-staging`. Resize the tier in place later with
  `gcloud sql instances patch palup-staging --tier=…` (brief restart, no data migration).
- **Secrets (Secret Manager, never in code):** `palup-staging-pg-root` (postgres su), `palup-staging-pg-app`
  (app user), `palup-staging-database-url` (the full `DATABASE_URL`, mounted into Cloud Run via
  `--set-secrets`). DB `palup`, app user `palup_app`.
- **Connection:** Cloud Run attaches the instance with `--add-cloudsql-instances` and connects over the
  unix socket (`host=/cloudsql/<conn>`). The runtime SA has `roles/cloudsql.client` + `secretAccessor`
  on the URL secret.
- **Schema:** auto-created on boot — THREE idempotent migrations run against the SAME shared connection
  pool (state-postgres's `createRuntimeStore()`/`createVectorStore()` share one `pg.Pool` per process; see
  the vector-factory doc comment): `PostgresRuntimeStore.migrate()` (`rs_kv`/`rs_stream`/`rs_audit`),
  `PostgresVectorStore.migrate()` (`vp_records` — the durable cross-visit-memory table, ADR-0015), and
  `PostgresMerchantRegistry.migrate()` (`pl_merchant` — see below; runs only when the Shopify install or
  webhook routes are enabled). No manual migration for any of them.
- **`pl_merchant` privileges (the merchant registry, B1) — not yet applied to any instance as far as this
  doc's own history shows; verify against the live instance before relying on this.** `palup_app` needs
  `SELECT`, `INSERT` and `UPDATE`. It does **not** need `DELETE`: revocation is a *status change*, never a
  row delete (the adapter issues no `DELETE` at all — deleting the row would strand the tenant's sessions,
  consent records, audit chain and memory namespaces in namespaces nothing can resolve), so withholding
  `DELETE` is a cheap, real guard rather than a formality.
  ```sql
  GRANT SELECT, INSERT, UPDATE ON pl_merchant TO palup_app;   -- deliberately NO DELETE
  ```
  **This is a CROSS-TENANT table by design** — it is the one read that happens *before* a tenant is known
  (embed key / shop domain → tenant), so unlike `rs_kv` it has no `tenant_id` predicate to scope by and RLS
  is not applicable in the same way. The isolation guarantees are instead enforced by two **unique
  indexes** the migration creates, on `lower(shop_domain)` and on `embed_key`. Those are the security
  boundary, not a tidiness measure: without them a duplicate row makes a reverse lookup return whichever
  row the planner emitted first — a silent, non-deterministic **wrong-tenant** resolution on a live shopper
  request. If duplicate rows already exist, `migrate()` cannot build the index and **boot fails loudly**,
  which is the intended outcome.
- **Since D1 this table is on the serving hot path.** Every `/widget/token` mint and every `/chat` turn
  reads it (see the D1 note above). Two operational consequences: (a) a `pl_merchant` outage now refuses
  mints and turns rather than degrading quietly — that is deliberate, so a database fault cannot resurrect
  a revoked merchant; (b) the reads are single-row lookups on unique indexes, but they are per-request, so
  they count against the shared-core Cloud SQL tier's connection budget alongside the kill-switch read.
- **Audit immutability (#19):** `rs_audit` is INSERT/SELECT-only for `palup_app` (applied on staging;
  UPDATE/DELETE denied — verified). Re-apply for any new instance via
  `scripts/setup-audit-immutability.sql` (run as `postgres` through the Cloud SQL proxy). The backend
  also emits an `AUDIT_ANCHOR {seq,hash}` line to stdout per audited turn → Cloud Logging keeps an
  immutable witness of the chain head *outside* the DB, so tail-truncation / rewrite by a compromised
  DBA is reconcilable. (Automated anchor↔DB reconciliation is a monitoring follow-up.)
- **`vp_records` privileges (ADR-0015 durable cross-visit memory) — not yet applied to any instance as far
  as this doc's own history shows** (this table ships on the branch that adds `PostgresVectorStore`,
  which had not deployed as of this note; verify against the live instance before relying on this).
  Unlike `rs_audit`, `vp_records` genuinely needs `SELECT`/`INSERT`/`UPDATE`/`DELETE` for `palup_app` — a
  right-to-erasure (`POST /forget`, Consent-2 withdrawal) must be able to `DELETE`, and `upsert`'s
  `ON CONFLICT ... DO UPDATE` needs `UPDATE`. There is currently no immutability guarantee analogous to
  `rs_audit`'s INSERT/SELECT-only grant on this table (erasure requiring DELETE is the reason it can't be
  INSERT-only the same way). `tenant_id` is a real, indexed column on this table specifically so a
  defense-in-depth **row-level security** policy scoped by `tenant_id` can be added later without a
  migration — production SHOULD enable it, mirroring `PostgresRuntimeStore.migrate()`'s own RLS note; it
  is not enabled by app code today. **Special-category (Art-9) fact payloads are encrypted before they
  ever reach this table** (ADR-0015 Inv 9, go-live blocker #2 — CLOSED): `packages/widget-memory/src/
  service.ts` AES-256-GCM-encrypts a special-category fact's `text` and its `disposition[].value`/
  `sourceQuote` BEFORE calling this adapter's `upsert`, via a new `CryptoPort` (`packages/
  platform-ports/src/crypto-port.ts`) — this table itself still just stores whatever bytes it's handed
  (plain `text`/`jsonb` columns), so a DBA/disk-snapshot/log-shipping path sees ciphertext, not a health
  fact in the clear (see `postgres-vector-store.ts`'s own file-level note). **This requires a new secret**:
  `MEMORY_ENCRYPTION_KEY`, provisioned per tenant in the SAME `PALUP_SECRETS` JSON map the Shopify
  Storefront token already lives in (`{"<tenant>":{"MEMORY_ENCRYPTION_KEY":"<a high-entropy secret,
  16+ bytes>", ...}}`) — without it, a special-category memory write is REFUSED (fail-closed, never
  stored in the clear) and a `write.refused` audit entry records it. **As of 2026-08-17 `MEMORY_ADR_ACCEPTED`
  is flipped `true`** (`packages/widget-memory/src/flag.ts`; ADR-0015 Accepted for INTERNAL STAGING, legal
  DEFERRED, `security-reviewer` PASS-WITH-CONDITIONS), so on the staging service where `MEMORY_ENABLED=true`
  memory is LIVE — which makes **`MEMORY_ENCRYPTION_KEY` for the serving tenant a HARD precondition, not
  go-live prep** (A4 condition 1). It must be provisioned for the actual serving tenant `palup-skincare-jason`
  (the earlier key was `demo`-only); without it ordinary facts persist in the clear and special-category
  writes fail-closed. Production stays OFF (deployed nowhere, `MEMORY_ENABLED` unset) and external go-live
  remains legally gated.
- **Rotating `MEMORY_ENCRYPTION_KEY` — two steps, in this order.** A naive one-step replacement is
  IRRECOVERABLE: every fact written under the outgoing key stops decrypting, and `recall` drops each one
  permanently (it is detected — a PII-free `recall.dropped` audit records the count — but detection is
  not recovery; the plaintext is gone). To rotate safely, for the tenant being rotated:
  1. Copy the CURRENT value to `MEMORY_ENCRYPTION_KEY_previous` in the same `PALUP_SECRETS` entry, and
     put the NEW value at `MEMORY_ENCRYPTION_KEY`. `decrypt` tries the current key first and falls back
     to `_previous` when the envelope's key id doesn't match, so existing records keep decrypting while
     new writes use the new key.
  2. Keep `_previous` for at least one full retention window (30 days — `ORDINARY_TTL_DAYS`/
     `SPECIAL_TTL_DAYS`, and note retention SLIDES from last activity, so an actively-returning shopper's
     records outlive a bare 30 days from rotation). Only then remove `_previous`. Watch for
     `recall.dropped` audit entries during the window — a non-zero count means records were written under
     a key that is no longer reachable.

  **The same two steps apply to `MEMORY_ENCRYPTION_KEY__merchant-cred`** (the per-merchant delegate-credential
  key — see *Shopify app install + compliance webhooks* above), whose rotation slot is
  `MEMORY_ENCRYPTION_KEY__merchant-cred_previous`. The `__merchant-cred` suffix is a **key scope**: it is
  what makes the two keys rotate independently, so a `MEMORY_ENCRYPTION_KEY` compromise does not expose
  stored merchant credentials. One difference in the failure mode, worth knowing before you rotate: an
  unreadable *memory* key drops a fact and audits `recall.dropped`, whereas an unreadable *credential* is
  reported as `unreadable` and is **never** silently treated as "this merchant has no credential" — so the
  symptom is a loud refusal, not a merchant quietly falling back to fixtures.

## Shopify grounding (M2, ADR-0012)

Per-merchant grounding pulls the merchant's live catalog + policies from the **Shopify Storefront API**
(v2026-07) behind the `GroundingPort`. **Verified live 2026-07-31** against
`palup-skincare-jason.myshopify.com` (HTTP 200; brand + refund/shipping policies + a real catalog). Both
config values are set **by `deploy-staging.yml`** — `--set-secrets`/`--set-env-vars` REPLACE the whole set
each deploy, so they must live in the workflow; dropping them silently reverts grounding to the fixtures:

- **Secret Manager `palup-secrets`** — a nested JSON `{"<tenant>":{"shopify_storefront_token":"…"}}`
  read via the `SecretsPort`; holds each tenant's **private** Storefront token (`Shopify-Storefront-
  Private-Token`). Mounted into Cloud Run as the `PALUP_SECRETS` env via `--set-secrets`. The runtime
  SA has `secretAccessor` on it.
- **`SHOPIFY_STORES` env** — a non-secret `{"<tenant>":"<shop>.myshopify.com"}` map (validated to a
  `*.myshopify.com` host before any fetch), set in `deploy-staging.yml` via gcloud's `^@^` delimiter.
- **Current mapping:** `demo → palup-skincare-jason.myshopify.com`, so staging traffic (the demo tenant)
  grounds on the real store. A tenant with no resolved creds falls back to the built-in fixtures —
  non-breaking.
- Grounding is cached per tenant on the `RuntimeStatePort` (TTL) with degrade-to-stale/safe-empty, so a
  slow/down Shopify never hangs `/chat`.
- **Catalog ceiling — 1000 products (4 Storefront pages × 250).** The catalog is fetched by cursor
  pagination and returned **only if complete**; a bigger catalog, a lost page, or a broken cursor makes
  the fetch fail so the cache serves last-known-good (or safe-empty when cold) instead of a truncated
  catalog. Truncation would make the agent deny products the merchant carries. Watch the
  `[grounding.shopify]` log for a `reason` field — `catalog-ceiling-exceeded` (this merchant needs
  relevance retrieval, not a bigger fetch — raising the ceiling alone puts every SKU into every prompt),
  `pagination-discarded-partial` (transient Shopify failure mid-fetch; the previous catalog keeps
  serving), `pagination-cursor-missing` / `pagination-cursor-stalled` (a Storefront response we refuse to
  paginate on). Lines with `reason` carry `products` (how many were discarded) and never the token.

## One-time setup

**Fastest — run the script** (as a project owner with `gcloud` + `gh` authenticated):

```bash
GCP_PROJECT=palup-jason GITHUB_REPO=jasonhsu-cmd/palup-spotify bash scripts/setup-staging.sh
```

It does everything below (WIF pool/provider restricted to your repo, deploy SA + roles, and the GitHub
secrets/variables incl. `STAGING_ENABLED=true`). The manual equivalent:

1. **Enable APIs** in your GCP project: Cloud Run, Cloud Build, Artifact Registry, Vertex AI.
2. **Workload Identity Federation** (no long-lived keys): create a WIF pool + provider for GitHub, and a
   deploy service account with `roles/run.admin`, `roles/cloudbuild.builds.editor`,
   `roles/artifactregistry.admin` (create the source-deploy repo), `roles/storage.admin` (Cloud Build
   source bucket), `roles/iam.serviceAccountUser`, and `roles/aiplatform.user` (so the running service
   can call Vertex). The container binds `0.0.0.0:$PORT` (Cloud Run requirement) via `HOST=0.0.0.0`.
3. **GitHub repo → Settings:**
   - **Variables:** `STAGING_ENABLED=true`, optionally `GCP_REGION` (default `us-central1`).
   - **Secrets:** `GCP_PROJECT`, `GCP_WIF_PROVIDER` (full provider resource name), `GCP_DEPLOY_SA`
     (deploy SA email).

## What runs

- **`.github/workflows/deploy-staging.yml`** — on push to `main`: `gcloud run deploy` from source, then a
  **post-deploy smoke gate** that exercises the full serving path — `/health` (`ok:true` + live `vertex/gemini`
  adapter, failing on `mock`), unauthenticated `/chat` → **401**, token mint, and an authenticated `/chat`
  asserting a real non-empty model reply. The service gets `GOOGLE_CLOUD_PROJECT`/`LOCATION`/`PALUP_MODEL`, so
  it serves the **real Gemini** model.
- **`.github/workflows/drift-check.yml`** — **manual** ("Run workflow"), no schedule: a live-model smoke
  + the cross-family judge (guarded by `STAGING_ENABLED` / `JUDGE_ENABLED`). The offline eval is
  deterministic and runs locally in `merge-gate.sh` before every merge (and in CI on push to `main`), so
  it isn't re-run on a timer; trigger this only to check the live model (e.g. after Google updates the
  `gemini-3.5-flash` alias).

## Retention sweep (B4) — the job that makes expiry real

`sweepAllSubjects` and the `pnpm sweep` entrypoint are **built and tested; nothing schedules them.** Until
something does, retention is enforced only *opportunistically*, on a returning shopper's own `/chat` turn —
so a shopper who never comes back is **never physically reclaimed**, which is precisely the gap
`MEMORY-GO-LIVE-CHECKLIST.md` B4 exists to close. Expiry that nothing runs is aspirational, and
ADR-0015 Inv 4 says it must not be.

**Schedule this BEFORE setting `MEMORY_ENABLED=true`** (the `MEMORY_ADR_ACCEPTED` const is already flipped
for internal staging as of 2026-08-17, so `MEMORY_ENABLED` is the remaining live gate — A4 condition 4).
With memory off nothing is ever written, so the job simply reports zeros — there is no reason to wait, and
§D step 7 asks for it in that order so the mechanism is proven before the first real write exists to depend
on it. It must target the serving tenant `palup-skincare-jason` (`SWEEP_TENANTS`/`SHOPIFY_STORES`).

The job needs the **same** `DATABASE_URL` and `AUDIT_HMAC_SECRET` as the service (its audit `subjectRef`s
must correlate with serving's — `retention-sweep.ts` mirrors server.ts's own fallback to
`SHOPPER_TOKEN_SECRET`), plus the tenants to visit. **There is no tenant registry to enumerate**, by
design: a deletion job must not discover its own targets. It sweeps the union of `SHOPIFY_STORES` keys and
a comma-separated `SWEEP_TENANTS`, and **exits 1 with `no tenants configured` if both are empty** rather
than silently succeeding over nothing.

> **`--set-cloudsql-instances` is NOT optional.** Verified 2026-08-06: the service carries the
> `run.googleapis.com/cloudsql-instances: palup-jason:us-central1:palup-staging` annotation and
> `DATABASE_URL` is a **`/cloudsql/` unix-socket** URL (checked without printing the value). A job without
> the same attachment has no socket to open and cannot connect at all — it will not "degrade", it will fail
> every run. Mount `AUDIT_HMAC_SECRET` only once B5 is done; naming a secret that does not exist makes
> `gcloud` itself fail.

```bash
# 1. Create the job. `--command pnpm --args sweep` overrides the image's CMD ["pnpm","backend"];
#    the `pnpm` launcher is on PATH in the runtime image (Dockerfile: corepack enable, PNPM_HOME=/pnpm).
gcloud run jobs deploy palup-retention-sweep \
  --source . --region us-central1 --project palup-jason \
  --command pnpm --args sweep \
  --set-cloudsql-instances palup-jason:us-central1:palup-staging \
  --set-secrets "DATABASE_URL=palup-staging-database-url:latest" \
  --set-env-vars "^@^SWEEP_TENANTS=demo@PALUP_REQUIRE_DATABASE_URL=true"
# …and once B5 has provisioned the audit key, add it so the job's subjectRefs match serving's:
#   --set-secrets "DATABASE_URL=palup-staging-database-url:latest,AUDIT_HMAC_SECRET=<secret-name>:latest"

# 2. Run it once by hand and READ THE OUTPUT before scheduling anything
gcloud run jobs execute palup-retention-sweep --region us-central1 --project palup-jason --wait

# 3. Enable Cloud Scheduler. It is NOT enabled by default, and the API needs a few minutes to settle
#    (see the propagation note below) — do this before creating the schedule, not alongside it.
gcloud services enable cloudscheduler.googleapis.com --project palup-jason

# 4. A DEDICATED invoker identity whose only power is starting this one job. Deliberately NOT the default
#    compute SA: that one holds project `roles/editor`, and wiring an Editor identity into a scheduler
#    that fires a DESTRUCTIVE job is the wrong default. (Editor does include `run.jobs.run`, so the lazy
#    option works — which is exactly why it needs saying no to.)
gcloud iam service-accounts create palup-sweep-invoker \
  --display-name="Cloud Scheduler invoker for the retention sweep job" --project palup-jason
gcloud run jobs add-iam-policy-binding palup-retention-sweep \
  --region us-central1 --project palup-jason \
  --member="serviceAccount:palup-sweep-invoker@palup-jason.iam.gserviceaccount.com" \
  --role="roles/run.invoker"

# 5. Schedule daily, once step 2 looks right. 03:17 UTC — off-peak, and an odd minute so it does not
#    join the top-of-hour thundering herd. --time-zone=UTC explicitly, so DST never shifts it.
gcloud scheduler jobs create http palup-retention-sweep-daily \
  --location=us-central1 --project palup-jason \
  --schedule="17 3 * * *" --time-zone=UTC \
  --uri="https://us-central1-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/palup-jason/jobs/palup-retention-sweep:run" \
  --http-method=POST \
  --oauth-service-account-email="palup-sweep-invoker@palup-jason.iam.gserviceaccount.com" \
  --max-retry-attempts=3 --min-backoff=60s --max-backoff=600s

# 6. Prove it fires, rather than waiting until tomorrow to find out.
gcloud scheduler jobs run palup-retention-sweep-daily --location us-central1 --project palup-jason
gcloud run jobs executions list --job palup-retention-sweep --region us-central1 --project palup-jason
```

**Verified working 2026-08-06** — that exact URI, that invoker SA, and `--max-retry-attempts=3` produced
scheduler-triggered executions that completed with `succeededCount=1` and the expected
`[sweep] store=postgres vector=postgres tenants=1` / `visited=0 deleted=0 …` output.

> **PROPAGATION: `gcloud scheduler jobs run` exits 0 while doing nothing, for the first few minutes after
> enabling the API.** Observed: the first force-run returned exit 0, wrote no output, left
> `lastAttemptTime` at `(never)`, and created no execution — and then fired *late*, so a retry a few
> minutes later produced **two** executions rather than one. Do not conclude the wiring is broken from one
> immediate check; look at `lastAttemptTime` and `status` on the scheduler job (`status: {}` means success)
> and give it a few minutes. A double execution is harmless here: the second sweep finds nothing expired,
> which `retention.ts` handles with no vector call and no audit at all.

**Why `--max-retry-attempts` is safe.** A retried `:run` starts a *new* execution rather than resuming one.
That is fine because the sweep is effectively idempotent — records the first run deleted are simply no
longer expired-and-present, and a subject with nothing expired produces no delete and no audit row.

> **Step 1 is now confirmed too (2026-08-06):** it was run and the resulting job was inspected —
> `command=[pnpm] args=[sweep]`, `cloudsql=palup-jason:us-central1:palup-staging`, `DATABASE_URL` and
> `AUDIT_HMAC_SECRET` both mounted from their secrets, `maxRetries=3`, `timeoutSeconds=600`. It was
> originally written unverified because this session denies `gcloud * deploy *` (settings.json — the guard
> that stops an agent deploying anything), which also blocks reading that subcommand's `--help`.
>
> **`AUDIT_HMAC_SECRET` on the job is not optional once B5 is live.** Serving writes KEYED `subjectRef`s;
> a job without the key writes UNKEYED sha256 refs for the same subjects. Two pseudonyms for one person,
> in an INSERT-only `prev_hash`-chained table where a wrong ref cannot be corrected afterwards. Add it in
> the same `--set-secrets` list, never as a follow-up after the job has done real work.

**Verify the run, don't assume it** — per-tenant the job prints
`visited=… deleted=… retired=… failed=… remaining=…`, and:

- `remaining > 0` means `SWEEP_MAX_SUBJECTS` capped the run and work is left for the next one — printed,
  never silent.
- A **halted** tenant is skipped *before* anything is deleted (`[sweep] tenant=… HALTED by kill switch`) —
  NN#4 holds for destructive background work too.
- The process **exits non-zero** on any tenant failure, so a Cloud Run Job surfaces the run as unhealthy
  instead of reporting success.
- Confirm the `ttl_sweep` audit entries actually land in the **durable** sink (B5) — audit-before-delete
  means a destructive action is never invisible, but that only holds if the sink is the Postgres
  hash-chained log rather than a per-process in-memory store. Check `/health` reports `store: postgres`.

> **B5 note, verified 2026-08-06 against the deployed staging config:** `AUDIT_HMAC_SECRET` is **not
> mounted** (no `AUDIT_HMAC_SECRET_NAME` repo variable is set) and `SHOPPER_TOKEN_SECRET` is absent, so the
> effective key is **undefined** today. The hash **chain** is unaffected — it is an unkeyed
> `sha256(canonicalize(base))` (`platform-ports/src/audit-hash.ts`) — but `subjectRef` degrades to an
> unsalted digest, which `widget-memory/src/audit.ts` states is fine for a 128-bit guest `anonId` and
> **NOT safe for a low-entropy `acct:` subject**, and `server.ts` skips the identity audit entirely while
> it is unset. Provision it (create the Secret Manager secret, then set `AUDIT_HMAC_SECRET_NAME`) **before**
> memory is enabled, not after — the same "before the first real write" rule the checklist's rollback note
> applies to B5/B6.

## Scheduled catalog-index backstop (`palup-catalog-index`) — S3 §E

The ADR-0020 missed-event backstop. Webhooks are the fast path; the 15-min serve-time ceiling is the money
safety net; this hourly full reconcile (now ANN-safe via the S3 ledger) is the missed-event catch-all. It
MAINTAINS THE DARK CORPUS — it spends real Vertex embedding on changed hashes — so **enabling it is a human
cost decision (jason's), not a build agent's**. Nothing here flips a serving flag; serving stays HITL §5.

> Same `/cloudsql/` unix-socket `DATABASE_URL` requirement, and same "REPLACE-set on every deploy" trap, as
> the retention sweep above. A job without the Cloud SQL attachment cannot connect at all.

**First-run cost — read before the first apply.** The first S3 reconcile against a pre-existing corpus has
no ledger yet (no prior content-hashes to diff against), so it **RE-EMBEDS 100% of the catalog** — full
metered Vertex embedding spend, not the bounded "changed products only" spend every run after it does. The
owner should expect and budget for this one-time spend when the job first runs; it does not recur on
subsequent hourly runs, which embed only products whose content hash changed since the last reconcile.

> **Owner runs these — do NOT execute here.** These are the exact `gcloud` commands for jason to run by
> hand; no `gcloud`/`terraform` command is executed by a build agent in this repo.

```bash
# 1. Create the job. `--command pnpm --args catalog:index` overrides the image CMD ["pnpm","backend"] to run
#    the catalog index CLI (packages/widget-backend/src/jobs/catalog-index.ts) for every SHOPIFY_STORES tenant.
gcloud run jobs deploy palup-catalog-index \
  --source . --region us-central1 --project palup-jason \
  --command pnpm --args catalog:index \
  --set-cloudsql-instances palup-jason:us-central1:palup-staging \
  --set-secrets "DATABASE_URL=palup-staging-database-url:latest,PALUP_SECRETS=palup-secrets:latest" \
  --set-env-vars '^@^VECTOR_ANN=true@SHOPIFY_STORES={"demo":"palup-skincare-jason.myshopify.com"}@PALUP_REQUIRE_DATABASE_URL=true@GOOGLE_CLOUD_PROJECT=palup-jason@GOOGLE_CLOUD_LOCATION=global@PALUP_EMBED_MODEL=gemini-embedding-2@PALUP_EMBED_DIMENSION=1536'
# GOOGLE_CLOUD_LOCATION=global is REQUIRED for gemini-embedding-2 — verified 2026-08-17 by probe: the model
# 404s (NOT_FOUND) at us-central1 ("not available in the specified region") and resolves only at `global`,
# which is also what the serving service uses (deploy-staging.yml). `--region us-central1` above is the
# Cloud Run region and is unrelated to the Vertex endpoint.
# TWO CORRECTIONS over the earlier draft of this command, both load-bearing:
#   (1) VECTOR_ANN=true — WITHOUT it, createVectorStore (vector-factory.ts:28) writes to the NON-ANN
#       PostgresVectorStore, a DIFFERENT table than the pgvector HNSW store the VECTOR_ANN serving path
#       reads. Index and serve MUST use the same store, so the job needs VECTOR_ANN=true too.
#   (2) SHOPIFY_STORES is parsed as JSON (merchant-store.ts:22 parseStoreDomains) — it must be
#       {"demo":"…"}, not demo=…, or tenantsToIndex() finds no tenant and the job no-ops.
# The embed model/dimension MUST match the serving pin (deploy-staging.yml): gemini-embedding-2 @ 1536.
# NOTE: no serving-side flag is set here — the job WRITES the corpus, it does not serve it (see the
# "Enabling note" below). Add PRODUCT_FACTS_POLL=true only when the Tier-2 poll producer is intended (§5).

# 2. Run it once by hand and READ THE OUTPUT before scheduling anything. On a pre-existing corpus this first
#    run is the 100%-re-embed run described above — expect it to take longer and cost more than every run
#    after it.
gcloud run jobs execute palup-catalog-index --region us-central1 --project palup-jason --wait

# 3. Enable Cloud Scheduler (idempotent; give the API a few minutes to settle — see the sweep's note).
gcloud services enable cloudscheduler.googleapis.com --project palup-jason

# 4. A DEDICATED invoker identity whose ONLY power is starting this one job (mirrors palup-sweep-invoker).
gcloud iam service-accounts create palup-catalog-index-invoker \
  --display-name="Cloud Scheduler invoker for the catalog index backstop" --project palup-jason
gcloud run jobs add-iam-policy-binding palup-catalog-index \
  --region us-central1 --project palup-jason \
  --member="serviceAccount:palup-catalog-index-invoker@palup-jason.iam.gserviceaccount.com" \
  --role="roles/run.invoker"

# 5. Schedule HOURLY, at an odd minute to dodge the top-of-hour herd. --time-zone=UTC so DST never shifts it.
gcloud scheduler jobs create http palup-catalog-index-hourly \
  --location=us-central1 --project palup-jason \
  --schedule="23 * * * *" --time-zone=UTC \
  --uri="https://us-central1-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/palup-jason/jobs/palup-catalog-index:run" \
  --http-method=POST \
  --oauth-service-account-email="palup-catalog-index-invoker@palup-jason.iam.gserviceaccount.com" \
  --max-retry-attempts=3 --min-backoff=60s --max-backoff=600s

# 6. Prove it fires.
gcloud scheduler jobs run palup-catalog-index-hourly --location us-central1 --project palup-jason
gcloud run jobs executions list --job palup-catalog-index --region us-central1 --project palup-jason
```

**Spend note (for the apply):** enabling the hourly job starts real Vertex embedding spend on the dark
corpus. The **first** run is unbounded (100% re-embed — see above); every run after it is bounded, because
only changed content hashes embed (content-hash + ledger diff). The apply, and its cost, is the owner's
decision — this job does not enable serving (see below).

**Known blind-spot (documented, not fixed here — S4 follow-up):** both this job and the sweep enumerate
`SHOPIFY_STORES` for their tenant list (`catalog-index.ts` `tenantsToIndex`). A self-installed merchant
absent from that env is **NOT reconciled** by this backstop. The tenant list should come from the install
registry — deferred to S4 (spec §H(2)). Until then, a newly-installed merchant relies on webhooks + the
15-min serve ceiling until its domain is added to `SHOPIFY_STORES`.

**Enabling note:** deploying and running this job maintains the DARK corpus and spends on embeddings, but it
does **NOT** enable serving. `CATALOG_RETRIEVAL` / `VECTOR_ANN` stay **§5 named-owner promotions** —
nothing in this job's env or command flips them.

## Per-tenant `CATALOG_RETRIEVAL` promotion (S4 §5 — HITL-POLICY §5 owner promotion bar)

This is the operator procedure for the per-tenant `CATALOG_RETRIEVAL` promotion bar that
`docs/HITL-POLICY.md` §5's `CATALOG_RETRIEVAL` block states. This is a **named-human action** (jason.hsu)
— nothing here is run by a build agent, and no step flips a flag on its own; each step is deliberate.

**Preconditions — verify ALL before starting (each is a real gate, not a nicety):**
- [ ] **§3-rule-4 erasure decision resolved (Step 0 below).** Do not enable `CATALOG_WEBHOOKS` until it is.
- [ ] **`VECTOR_ANN=true`** on the serving service — required for any corpus >5000 SKUs (the brute-force
      store silently truncates at 5000); it selects the pgvector engine the corpus lives in.
- [ ] **`PRODUCT_FACTS_HYDRATION=true`** + `PRODUCT_FACTS_MAX_AGE_MS` (default 900_000 = 15 min) — so a
      retrieved product's price/availability is the fresh `ProductFactsPort` overlay and a stale fact renders
      "current price needs confirming", never a wrong number.
- [ ] **A fresh reindex first + ProductFacts populated for the tenant** — the shell serving path has no live
      catalog, so a delisted product lingers until the corpus is reindexed, and a product with no fresh fact
      renders priceless. Run Step 2 immediately before enabling.
- [ ] **`CART_LINE_ITEMS` may now be co-enabled with retrieval** (parked S3/S4 gap RESOLVED 2026-08-17). The
      shell path resolves cart line-items by id via a bounded live Storefront fetch
      (`GroundingPort.getProductsByIds` over the existing `nodes(ids:)`, capped at `MAX_CART_LINE_ITEMS`=30
      ids — never the full catalog), so the cart block renders instead of silently dropping. A fetch failure
      fail-closes to no cart block and flags `cart:byid_unavailable` (audited), never a wrong cart. Enabling
      `CART_LINE_ITEMS` for a tenant remains a per-tenant §5 step like any serving flag.

0. **Resolve the §3-rule-4 statutory-erasure decision (OPEN — see HITL-POLICY §8).** As built, `shop/redact`
   + `app/uninstalled` erase the catalog corpus **unconditionally** (design A); the alternative (B) is to
   defer it under an armed kill like the memory/traffic erasure. This is a named-owner values call
   (statutory-erasure-first vs a strict "no code path an operator can't stop" reading). Pick one and record
   it in HITL-POLICY §8 **before** `CATALOG_WEBHOOKS` is enabled. No live exposure until then (dark).
1. **Deploy / enable the infra (gcloud + env — owner applies).** Deploy the scheduled backstop
   (`palup-catalog-index`, the runbook above), and set on the serving service `VECTOR_ANN=true`,
   `CATALOG_WEBHOOKS=true`, `PRODUCT_FACTS_HYDRATION=true` (+ `PRODUCT_FACTS_MAX_AGE_MS` if not the 15-min
   default), then redeploy `palup-widget-staging`. These flip NOTHING for shoppers on their own —
   per-tenant serving still requires the two-gate `catalog:enable` in Step 5.
2. **Build the tenant's corpus.** `pnpm catalog:index --reindex` for the tenant (or run the scheduled job
   once) to embed its whole catalog into pgvector and rebuild the ledger, and populate `ProductFactsPort`.
   The FIRST run embeds 100% of the catalog (one-time metered Vertex spend — no prior content-hashes to diff).
3. **Produce the evidence, on real Vertex + real pgvector, at the tenant's scale.** With `VECTOR_ANN=true` +
   `DATABASE_URL` set to the §5 Cloud SQL instance, and `RETRIEVAL_TENANT=<id>` (+ `RETRIEVAL_CORPUS_SIZE=<n>`
   or `RETRIEVAL_CORPUS_FILE=<path>` for a scale/real corpus), run `pnpm eval:retrieval` and
   `pnpm shadow:retrieval`. Each writes one structured artifact —
   `reports/retrieval-promotion-evidence-<tenant>-<stamp>.json`
   (`packages/widget-backend/src/retrieval-promotion-evidence.ts`) — recording model, dimension, corpus size,
   recall@k, no-wrong-product rate, and shadow violation counts. **PASS bar:** `eval:retrieval` exits 0
   (recall@k above floor + no wrong product) AND `shadow:retrieval` reports **zero** fabricated/stale/
   missing-product violations. (Both CLIs require real Vertex creds — `GOOGLE_CLOUD_PROJECT` + ADC.)
4. **Review the artifact.** The named owner reads the JSON before flipping anything — a passing exit code
   alone is not the bar; the retained artifact under `reports/` (gitignored operator evidence) is.
5. **Flip the platform master once, then the tenant:**
   ```bash
   pnpm catalog:enable --scope platform --on --reason "jason: platform master, <date>"
   pnpm catalog:enable --scope tenant:<id> --on --reason "jason: promoting after eval/shadow evidence reports/retrieval-promotion-evidence-<tenant>-<stamp>.json"
   ```
   Both writes are audited atomically (`catalog-retrieval-enablement.ts`); the CLI reads the resulting state
   back and prints `effective=true` only once both the platform master and the tenant opt-in are on.
   **`--reason` is written verbatim to the immutable Audit Log — never put a secret, token, or credential
   in it.**
4. **Rollback — two independent levers:**
   - **Instant, retrieval-only:** `pnpm kill:arm --scope agent:catalog-retrieval` degrades EVERY
     tenant's retrieval to the full-catalog path immediately, with no code change. This scope is
     platform-wide-but-retrieval-only — `matchedKill` has no combined tenant+agent-type scope, so
     `--scope tenant:<id>` is **not** a retrieval-only rollback for one merchant; it matches the same
     tenant-scoped check the ordinary shopper kill uses and halts that tenant's serving entirely.
   - **Un-enable one tenant (no kill involved):** `pnpm catalog:enable --scope tenant:<id> --off --reason "…"`
     turns retrieval back off for just that tenant, leaving every other tenant and the rest of that
     tenant's serving untouched.

## Local

```bash
pnpm backend        # http://127.0.0.1:8787 (mock model; set the Vertex env for real Gemini)
docker build -t palup-widget:staging .   # requires a running Docker daemon
```

## Live-judge-on-merge (eval-quality.yml)

Auto-runs the live 190-case judge when a model-dependent change lands on `main`, and **opens an issue
if quality regresses** — so drift surfaces itself. GCP auth is **Workload Identity Federation (no
long-lived key)**, reusing the secrets `scripts/setup-staging.sh` sets. **Dormant until enabled:**

1. **Run `scripts/setup-staging.sh` once** — it sets the `GCP_WIF_PROVIDER`, `GCP_DEPLOY_SA`, and
   `GCP_PROJECT` secrets (the deploy SA already has `roles/aiplatform.user` for Vertex). *This also
   enables staging auto-deploy; if you want the judge WITHOUT deploy, run
   `gh variable set STAGING_ENABLED --body false` afterward.*
2. **Add the judge secret + on-switch:**
   ```bash
   gh secret   set ANTHROPIC_API_KEY --repo <owner>/<repo> --body "$ANTHROPIC_API_KEY"
   gh variable set JUDGE_ENABLED     --repo <owner>/<repo> --body true
   ```
   Optional variables: `GCP_LOCATION` (default `global`), `PALUP_MODEL`, `JUDGE_MODEL`
   (default `claude-sonnet-5` — balanced for the bulk run; Opus is reserved for gating).

The baseline lives in `.github/eval-baseline.json`; regenerate it after a real improvement
(`pnpm eval:full` → copy the byLayer rates). Regression tolerances absorb the judge's run-to-run variance.

## Cross-family judge (optional, related)

`pnpm eval:judge` defaults to an **advisory** same-family Gemini judge. For the **gating** cross-family
judge there are two paths:

**A) Anthropic API key (simplest — no GCP/Model Garden):**
```bash
export ANTHROPIC_API_KEY=...            # your key (never commit it)
JUDGE_FAMILY=anthropic pnpm eval:judge  # gates; uses Claude via the direct API
# optional: ANTHROPIC_MODEL=claude-sonnet-5 (or another current id; adapter default is claude-opus-4-8)
```

**B) Claude on Vertex** (if you'd rather stay in GCP) — enable a Claude model in Model Garden, then:
```bash
JUDGE_FAMILY=anthropic JUDGE_MODEL=<enabled-claude-id> ANTHROPIC_VERTEX_REGION=us-east5 pnpm eval:judge
```
(The harness prefers path A when `ANTHROPIC_API_KEY` is set.)
