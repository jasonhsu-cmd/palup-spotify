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
> mints a short-TTL token from the built-in embed key `demo-embed-key` (→ tenant `demo`) via `/widget/token`
> and sends it as a `Bearer` on `/chat`; a request without a valid token now returns 401. This exact flow —
> flag on + only the demo tenant configured → 200 under `demo` — is asserted by `widget-tenant.test.ts`
> ("WIDGET_AUTH_REQUIRED=true: the DEMO still works via the default demo-embed-key"). For a **real second
> merchant**, add `WIDGET_EMBED_KEYS={"<their-embed-key>":"<their-tenant>"}` and give them that embed key +
> their own tenant id/store creds — no code change. (The Cloud Run edge staying `--allow-unauthenticated`
> is fine: the app-level widget-token check is the tenancy gate; the edge is open only so the public embed
> can reach `/widget/token` and `/`.)

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
- **Schema:** auto-created on boot — TWO idempotent migrations run against the SAME shared connection
  pool (state-postgres's `createRuntimeStore()`/`createVectorStore()` share one `pg.Pool` per process; see
  the vector-factory doc comment): `PostgresRuntimeStore.migrate()` (`rs_kv`/`rs_stream`/`rs_audit`) and
  `PostgresVectorStore.migrate()` (`vp_records` — the durable cross-visit-memory table, ADR-0015). No
  manual migration for either.
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
