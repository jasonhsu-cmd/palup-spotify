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

```bash
cd infra/terraform
terraform init
terraform apply \
  -var="project_id=YOUR_PROJECT" \
  -var='notification_channel_ids=["projects/YOUR_PROJECT/notificationChannels/CHANNEL_ID"]'
```

Get a notification channel id with `gcloud beta monitoring channels list`, or create one (email/PagerDuty/
Slack) first. Leave `notification_channel_ids=[]` to create the metric + policy without paging (log-only).

This does not enable `PRODUCT_FACTS_POLL`/`PRODUCT_FACTS_HYDRATION`/`CATALOG_WEBHOOKS` — those stay
env-flag, human-promoted (see the go-live checklist).
