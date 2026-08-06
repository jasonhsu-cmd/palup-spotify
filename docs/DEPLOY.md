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
> (`GOOGLE_CLOUD_LOCATION=global`, `PALUP_MODEL=gemini-2.5-flash`). Reply content is asserted **structurally**
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
> - **The Storefront token is still `SecretsPort`.** Serving reads `shopify_storefront_token` from
>   `PALUP_SECRETS` — *not* the encrypted delegate credential an install stores. **A merchant who installs
>   themselves therefore gets the built-in FIXTURE catalog, not their own products,** until an operator
>   provisions that secret for their tenant. There is exactly one source of truth for the token today.
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

`AUDIT_HMAC_SECRET` is **optional** and defaults to `SHOPPER_TOKEN_SECRET`. It is the keyed-HMAC key for
audit `subjectRef`s, so a low-entropy numeric customer id is never recorded as a bare hash. Provision it
separately only if you want key separation from the shopper-token secret.

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

## What the staging deploy actually passes (D3)

`--set-secrets` and `--set-env-vars` **replace the whole set on every deploy**, so anything not listed in
`.github/workflows/deploy-staging.yml` is dropped on the next merge. Track B repeatedly documented env vars
here and passed none of them; `packages/widget-backend/test/deploy-staging-env.test.ts` is now a unit test
over that workflow file so the list cannot silently lose an entry again. (It proves the *list*, not the
deploy — only a real deploy proves that.)

**Always passed** — `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`, `PALUP_MODEL`,
`PALUP_REQUIRE_DATABASE_URL`, `WIDGET_AUTH_REQUIRED`, `WIDGET_EMBED_KEYS`, `SHOPIFY_STORES`, and (new in D3)
`MERCHANT_REGION` + `MERCHANT_GROUNDING_MODE`. Secrets: `DATABASE_URL`, `WIDGET_TOKEN_SECRET`,
`PALUP_SECRETS`.

**Optional, driven by repo variables** (`Settings → Secrets and variables → Actions → Variables`). Each is
appended only when set, so an unset one never produces an empty env pair:

| repo variable | effect |
|---|---|
| `MERCHANT_REGION` / `MERCHANT_GROUNDING_MODE` | the D2 fallback for tenants with no row. Default `us` / `full` — the same values the code already assumed, now visible instead of implied |
| `SHOPIFY_APP_CLIENT_ID`, `SHOPIFY_INSTALL_REDIRECT_URI`, `SHOPIFY_INSTALL_REGION` | **all three or none.** A partial set **fails the deploy** with a `::error::` rather than leaving `/shopify/*` silently 404. An invalid `SHOPIFY_INSTALL_REGION` also fails the deploy |
| `SHOPIFY_INSTALL_SCOPES`, `SHOPIFY_DELEGATE_SCOPES` | optional overrides of the code defaults |
| `AUDIT_HMAC_SECRET_NAME` | the **name of an existing Secret Manager secret**, which is then mounted as `AUDIT_HMAC_SECRET` |

**What an operator must create before any of this does anything.** These are *not* provisioned by this
change and the deploy does not create them:

1. **`shopify_app_client_secret`** inside the existing `palup-secrets` payload, under the app-scoped
   pseudo-tenant: `{"__shopify_app__":{"shopify_app_client_secret":"…"}}`. Until it exists, `/shopify/*`
   stays **404 even with all three env vars set** — both C1's install gate and C2's webhook gate read it.
   It is a JSON entry in a secret that is already mounted, so there is nothing to add to the workflow.
2. **`MEMORY_ENCRYPTION_KEY__merchant-cred`** per installing tenant, in the same `palup-secrets` payload.
   Also nothing to add to the workflow. Missing ⇒ the install callback returns **502** and stores nothing.
3. **An `AUDIT_HMAC_SECRET` secret**, only if you want a keyed subject ref in GDPR-erasure audit rows.
   Without it those rows record the literal `unreferenced (no AUDIT_HMAC_SECRET configured)` — a
   documented degradation, not a crash, which is why the workflow does **not** hard-code a mount for it: a
   `--set-secrets` reference to a secret that does not exist makes `gcloud run deploy` itself fail and
   would break **every** merge until someone created it.
4. **The `pl_merchant` grants** (`GRANT SELECT, INSERT, UPDATE … TO palup_app`, deliberately no `DELETE`) —
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
  stored in the clear) and a `write.refused` audit entry records it. **None of this is reachable in
  production yet**: cross-visit memory itself stays fully OFF behind `MEMORY_ADR_ACCEPTED` (hardcoded
  `false`, `packages/widget-memory/src/flag.ts`) until a separately-governed PR flips it with named-owner +
  `security-reviewer` + LEGAL sign-off (ADR-0015 Status note) — so `MEMORY_ENCRYPTION_KEY` is go-live prep,
  not yet something staging needs provisioned.
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
  deterministic and already runs in CI on every PR, so it isn't re-run on a timer; trigger this only to
  check the live model (e.g. after Google updates the `gemini-2.5-flash` alias).

## Retention sweep (B4) — the job that makes expiry real

`sweepAllSubjects` and the `pnpm sweep` entrypoint are **built and tested; nothing schedules them.** Until
something does, retention is enforced only *opportunistically*, on a returning shopper's own `/chat` turn —
so a shopper who never comes back is **never physically reclaimed**, which is precisely the gap
`MEMORY-GO-LIVE-CHECKLIST.md` B4 exists to close. Expiry that nothing runs is aspirational, and
ADR-0015 Inv 4 says it must not be.

**Schedule this BEFORE flipping `MEMORY_ADR_ACCEPTED`.** With memory off nothing is ever written, so the
job simply reports zeros — there is no reason to wait, and §D step 7 asks for it in that order so the
mechanism is proven before the first real write exists to depend on it.

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
#    pnpm is on PATH in the runtime image (Dockerfile: corepack enable, PNPM_HOME=/pnpm).
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

# 3. Schedule daily once step 2 looks right
gcloud scheduler jobs create http palup-retention-sweep-daily \
  --location us-central1 --schedule "17 3 * * *" --time-zone UTC \
  --uri "https://us-central1-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/palup-jason/jobs/palup-retention-sweep:run" \
  --http-method POST --oauth-service-account-email "$RUN_INVOKER_SA"
```

> **Not verified in this session:** the exact `gcloud run jobs deploy` flag list. This session denies
> `gcloud * deploy *` (settings.json — the guard that stops an agent deploying anything), which also blocks
> reading that subcommand's `--help`. The flags above match SDK 532.0.0's documented surface and the
> secret/instance names ARE verified against the live service, but treat step 1 as "run it once and read
> the error" rather than known-good. Steps 2–3 use no denied verb and are ordinary.

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
