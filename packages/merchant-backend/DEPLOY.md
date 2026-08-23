# merchant-backend — staging deploy recipe

**This is a human/enablement step. Nothing in the F3 build plan runs this deploy.** It documents the
recipe so an operator can enable staging when F3 is ready to be exercised against a real Shopify shop;
production is deferred (staging-first, per `docs/DEPLOY.md`'s standing "staging auto-deploys, production
never auto-deploys" rule — this service isn't wired into `deploy-staging.yml` yet, so even staging is a
manual `gcloud run deploy` until someone adds that CI wiring).

## What this service is

The F3 merchant-plane Cloud Run service (`packages/merchant-backend`): the merchant console's backend,
distinct from the shopper-facing `palup-widget-staging` (widget-backend) and the IAM-gated
`palup-control-staging` (control-plane, operator-only). See `docs/adr/0002-two-plane-agent-architecture.md`
for why these stay separate services with separate ingress postures.

## Build

Local sanity build (optional — `gcloud run deploy --source` below builds via Cloud Build using the same
Dockerfile and does not require this step):

```bash
docker build -f Dockerfile.merchant-backend .
```

## Ingress posture — PUBLIC, unlike control-plane

Deploy with **`--allow-unauthenticated`**. This is deliberate and differs from `palup-control-staging`
(`--no-allow-unauthenticated`, IAM-gated operator surfaces): the merchant console is reached by a
merchant's browser via the embedded Shopify admin App Bridge flow, so Cloud Run IAM cannot be the gate —
there is no `run.invoker` credential a merchant's browser can present. **Auth is the app-level PalUp
session token** (F2's `requireMerchant` preHandler, `@palup/identity-shopify`): every route except
`/health` fail-closes to 401 without a valid bearer session token (verified structurally by
`test/route-protection.test.ts`, which enumerates every registered route). Cloud Run IAM staying open here
is correct, not a gap — it mirrors `palup-widget-staging`'s own posture (open edge, app-level gate) for
the identical reason: the caller is an end-user's browser, not an operator's authenticated shell.

## Shared state — same Cloud SQL as widget-backend

`DATABASE_URL` **must** point at the SAME Cloud SQL instance widget-backend uses
(`palup-jason:us-central1:palup-staging`, Secret Manager secret `palup-staging-database-url` — see
`docs/DEPLOY.md`'s Cloud SQL section), not a separate one. This is load-bearing for NN #4 (the kill
switch): `RuntimeStatePort` is how an operator's `pnpm kill:arm` halt propagates to every serving
instance, and merchant-backend's `buildServer()` composition root (Task 4) constructs the SAME
`PostgresRuntimeStore`/`PostgresMerchantRegistry` adapters against whatever `DATABASE_URL` it's given —
point it at a different database and a halt armed against the shared store would not be visible here.

⚠️ **Single-use session-token exchange (the jti replay guard) is currently IN-MEMORY / per-instance
only** — there is no durable/shared `JtiReplayGuard` adapter yet (`createInMemoryJtiGuard()`,
`@palup/identity-shopify`, wired in `packages/merchant-backend/src/server.ts`). Unlike `DATABASE_URL`
above, this guard does NOT ride the shared Cloud SQL store, so it is NOT consistent across multiple Cloud
Run instances. Until a durable adapter lands, pin the service to `--max-instances 1`, OR accept that a
session token could be replayed once per additional instance within its short validity window. Do NOT
scale this service beyond one instance for production without a durable guard.

## Shopify app secret — via the secrets port, never env-inline

The Shopify app client secret and the PalUp session-signing secret are read through the **secrets port**
(`createEnvSecrets()`, `@palup/platform-ports`) under the SAME `PALUP_SECRETS` Secret Manager secret and
scope/name convention widget-backend already uses (`__shopify_app__` / `shopify_app_client_secret`,
`palup_merchant_session_secret` — see `packages/identity-shopify/src/identity.ts`). Mount it exactly as
widget-backend does: `--set-secrets "PALUP_SECRETS=palup-secrets:latest"`. **Never** pass either secret as
a literal `--set-env-vars` value — that would put it in the Cloud Run revision's plaintext config and in
`gcloud` command history.

`SHOPIFY_APP_CLIENT_ID` is **not** a secret (it ships in the URL during the OAuth/App Bridge flow, same
convention as widget-backend's `SHOPIFY_APP_CLIENT_ID` — see `docs/DEPLOY.md`'s Shopify install section),
so it is passed as a plain `--set-env-vars` value.

## The recipe

```bash
gcloud run deploy palup-merchant-staging \
  --source . --dockerfile Dockerfile.merchant-backend \
  --region us-central1 --project palup-jason \
  --allow-unauthenticated \
  --set-cloudsql-instances palup-jason:us-central1:palup-staging \
  --set-secrets "DATABASE_URL=palup-staging-database-url:latest,PALUP_SECRETS=palup-secrets:latest" \
  --set-env-vars "HOST=0.0.0.0,PALUP_REQUIRE_DATABASE_URL=true,SHOPIFY_APP_CLIENT_ID=<the app's OAuth client id>"
```

Notes:
- `--set-secrets`/`--set-env-vars` **replace the whole set on every deploy** (same gotcha `docs/DEPLOY.md`
  calls out for widget-backend) — always pass the full list, not just what changed.
- `PALUP_REQUIRE_DATABASE_URL=true` makes `createRuntimeStore()` (Task 4's composition root) refuse to
  boot without `DATABASE_URL` rather than silently falling back to a per-process in-memory store that an
  operator kill would never reach — the same fail-fast widget-backend and control-plane already use.
  `HOST=0.0.0.0` is required for Cloud Run's health check to reach the process (`server.ts` already
  defaults to `0.0.0.0`, but this is set explicitly so the deploy doesn't depend on that default).
- The runtime service account needs `roles/cloudsql.client` (to reach the shared instance) and
  `roles/secretmanager.secretAccessor` on both `palup-staging-database-url` and `palup-secrets` — the
  same grants widget-backend's service account already has; grant them to whichever SA runs this service
  too if it's a distinct one.
- Post-deploy smoke: `GET /health` → `{"ok":true}`; an unauthenticated `GET /me` → `401`. There is no
  automated post-deploy gate for this service yet (unlike widget-backend's `deploy-staging.yml` smoke) —
  verify both by hand until this deploy is wired into CI.

## Status

Staging-only, human-enablement, not yet wired into `deploy-staging.yml`. Production is not addressed by
this document — see `docs/DEPLOY.md` for the standing "production is never auto-deployed" rule, which
applies here unchanged. This service is also currently **inert** in the sense that W1–W7 haven't mounted
any real merchant-console routes yet (only `/health`, `/me`, and the `/_probe/money` RBAC probe exist) —
deploying it stands up chassis + auth with nothing behind it yet.
