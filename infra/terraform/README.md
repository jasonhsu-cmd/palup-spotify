# infra/terraform

Versioned infrastructure that is **not** part of the application build and is **never auto-applied** —
`terraform apply` is a human action with GCP credentials, the same discipline as any promotion (CLAUDE.md
§3, HITL-POLICY §5). CI does not run Terraform.

## `monitoring.tf` — A3 producer failure alert (go-live precondition P3)

The A3 catalog producer emits a stably-keyed log marker when it fails to write or audit the Tier-2 price
facts (`[catalog] ALERT product_facts_{upsert,audit}_failed …`, `packages/widget-backend/src/jobs/
catalog-index.ts`). The code makes the failure **observable**; this Terraform makes it **page**, closing
the deploy half of P3 (`docs/A1B-A3-GO-LIVE-CHECKLIST.md`). It creates:

- a **log-based counter metric** matching the marker across both places the producer runs (the
  `catalog-index` Cloud Run **Job** on the poll path, and the webhook reconcile worker in the Cloud Run
  **Service**), and
- an **alert policy** that fires on any occurrence in a 5-minute window, routed to the notification
  channel(s) you pass in.

### Apply (human, with GCP creds)

**Note — `monitoring.tf` and `pubsub.tf` are ONE root module** sharing `variables.tf`, so a single
`terraform apply` covers BOTH P3 and P4, and P4's vars (`project_number`, `pubsub_push_endpoint`,
`backend_service_account`, `cloud_run_service_name`) have no defaults. To apply **P3 alone** (e.g. before
the backend is deployed), pass empty strings for those — `pubsub.tf` still plans its resources, so prefer
this only when you have not yet run pubsub.tf. Once the backend is up, apply both together (P4 section
below). Always `terraform plan` first.

```bash
cd infra/terraform
terraform init
terraform plan  -var="project_id=YOUR_PROJECT" ...      # ALWAYS plan first — it catches missing/invalid args
terraform apply \
  -var="project_id=YOUR_PROJECT" \
  -var='notification_channel_ids=["projects/YOUR_PROJECT/notificationChannels/CHANNEL_ID"]'
```

Get a notification channel id with `gcloud beta monitoring channels list`, or create one (email/PagerDuty/
Slack) first. Leave `notification_channel_ids=[]` to create the metric + policy without paging (log-only).

This does not enable `PRODUCT_FACTS_POLL`/`PRODUCT_FACTS_HYDRATION`/`CATALOG_WEBHOOKS` — those stay
env-flag, human-promoted (see the go-live checklist).

## `pubsub.tf` — P4 durable catalog-reconcile queue (go-live precondition P4)

Creates the `catalog-reconcile` topic + DLQ, the `pubsub-catalog-push` service account, an ordered push
subscription that POSTs to the backend's OIDC-gated route (`routes/pubsub-push.ts`), and the least-privilege
IAM. **Prerequisite: the backend must already be deployed to Cloud Run** — the push subscription needs the
service's real URL, and the smoke test below needs a live endpoint. Do P4 *after* the backend is up.

### Discover the var values (read-only gcloud)

```bash
PROJECT=$(gcloud config get-value project)
gcloud projects describe "$PROJECT" --format='value(projectNumber)'              # project_number
gcloud run services list --format='table(metadata.name, status.url)'             # cloud_run_service_name + URL
gcloud run services describe <SERVICE> --format='value(spec.template.spec.serviceAccountName)'  # backend_service_account
```

The push endpoint is `<service-url>/internal/pubsub/catalog-reconcile` (the route's `PUBSUB_PUSH_ROUTE`).

### Apply (human, with GCP creds)

```bash
cd infra/terraform
terraform init
terraform apply \
  -var="project_id=$PROJECT" \
  -var="project_number=<NUMBER>" \
  -var="pubsub_push_endpoint=https://<service-url>/internal/pubsub/catalog-reconcile" \
  -var="backend_service_account=<backend-runtime-sa-email>" \
  -var="cloud_run_service_name=<SERVICE>"
```

### Then register the push route via the DEPLOY PIPELINE (durable — a manual env-var set is wiped on the next merge)

The staging deploy (`.github/workflows/deploy-staging.yml`) runs `gcloud run deploy … --set-env-vars`, which
**replaces** the service env every merge — so a hand-set `gcloud run services update … PUBSUB_*` survives
only until the next deploy. The durable switch is a single repo variable the workflow reads:

```bash
gh variable set CATALOG_PUBSUB_AUDIENCE \
  --body "https://<service-url>/internal/pubsub/catalog-reconcile"
```

On the next deploy the workflow re-applies the three `PUBSUB_*` vars (topic + push-SA derived from the
project; audience = this variable) via a post-deploy `--update-env-vars`. This registers only the **consume**
route — it is decoupled from `CATALOG_WEBHOOKS` (server.ts), so the OIDC gate can be smoked before the
producer is on. `CATALOG_PUBSUB_AUDIENCE` MUST byte-equal the subscription's `oidc_token.audience` (the
endpoint URL) or every push 401s. Unset ⇒ the route stays 404 (inert). `CATALOG_WEBHOOKS` is a separate,
later human flip that turns on the **publish** side.

(For an immediate one-off smoke before the pipeline round-trips, you can `gcloud run services update <SERVICE>
--update-env-vars PUBSUB_CATALOG_TOPIC=catalog-reconcile,PUBSUB_PUSH_SERVICE_ACCOUNT=pubsub-catalog-push@$PROJECT.iam.gserviceaccount.com,PUBSUB_PUSH_AUDIENCE=<url>`
by hand — just know the next deploy drops it until the repo variable above is set.)

### Smoke test the OIDC gate BEFORE enabling `CATALOG_WEBHOOKS` (go-live P4)

`pnpm push:smoke` probes the deployed endpoint. The two always-on probes (no token, garbage token ⇒ 401)
need no creds; the two token probes need OIDC tokens you mint with gcloud (the script prints the exact
commands). It is side-effect-free — every probe sends a tenant-less envelope, so a valid token yields 204
(ack + drop) without running a reconcile.

```bash
URL=https://<service-url>/internal/pubsub/catalog-reconcile
PUSH_SMOKE_URL=$URL \
  WRONG_SA_TOKEN=$(gcloud auth print-identity-token) \
  PUSH_SA_TOKEN=$(gcloud auth print-identity-token \
    --impersonate-service-account=pubsub-catalog-push@$PROJECT.iam.gserviceaccount.com \
    --audiences="$URL") \
  pnpm push:smoke
```

Expect: anonymous 401, garbage 401, **wrong-token 401 (Google-signed ≠ authorized)**, push-SA 204.

Token caveats (a USER operator, not a service account):
- `WRONG_SA_TOKEN`: `gcloud auth print-identity-token` with **no** `--audiences` mints your plain user token
  (audience = the gcloud client, not the endpoint) → the route rejects it on audience → 401. The
  `--audiences` form only works for a service account (`Requires valid service account`), so don't use it here.
- `PUSH_SA_TOKEN`: impersonating the push SA needs `roles/iam.serviceAccountTokenCreator` on it FOR YOUR
  account (terraform grants that role to the Pub/Sub service agent, not you). Grant it, or skip the 204 probe.
- The **three 401s are the security gate** (no stranger / unverifiable / wrong-identity token can reach the
  reconcile); the 204 only confirms delivery, which a real Pub/Sub push also proves in the shadow stage.

The gate must pass in staging before `CATALOG_WEBHOOKS` is enabled in prod — the OIDC check is the sole
control on this internet-reachable route.
