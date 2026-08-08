# ── P4 (go-live checklist) — durable async catalog-reconcile queue over Pub/Sub ───────────────────────
# The widget backend PUBLISHES a reconcile message per catalog/inventory webhook; Pub/Sub PUSHES it to the
# OIDC-verified route (routes/pubsub-push.ts) which re-derives the tenant's facts. This is the durable
# replacement for the in-memory (synchronous) queue — the A3-part-2 security review's finding B.
#
# NEVER auto-applied; `terraform apply` is a human action (§3/§5). The env the backend reads to switch onto
# this path (PUBSUB_CATALOG_TOPIC / PUBSUB_PUSH_SERVICE_ACCOUNT / PUBSUB_PUSH_AUDIENCE) is set on the Cloud
# Run service SEPARATELY at deploy — creating this infra does not by itself enable CATALOG_WEBHOOKS.

# The topic the backend publishes to. `PUBSUB_CATALOG_TOPIC` on the service = this topic's short name.
resource "google_pubsub_topic" "catalog_reconcile" {
  name = "catalog-reconcile"
}

# Dead-letter topic: a message that fails `max_delivery_attempts` times lands here instead of retrying
# forever (the scheduled poll job is the backstop that catches whatever dead-letters).
resource "google_pubsub_topic" "catalog_reconcile_dlq" {
  name = "catalog-reconcile-dlq"
}

# The identity Pub/Sub PUSHES AS. The route accepts a token ONLY from this SA (expectedServiceAccount), so
# being Google-signed is necessary but not sufficient. `PUBSUB_PUSH_SERVICE_ACCOUNT` on the service = this
# SA's email.
resource "google_service_account" "pubsub_push" {
  account_id   = "pubsub-catalog-push"
  display_name = "Pub/Sub → catalog-reconcile push identity"
}

resource "google_pubsub_subscription" "catalog_reconcile_push" {
  name  = "catalog-reconcile-push"
  topic = google_pubsub_topic.catalog_reconcile.id

  # Ordered per publish orderingKey (tenantKey), matching the QueuePort contract.
  enable_message_ordering = true
  # A re-index can take a while; give the push request room before Pub/Sub re-delivers.
  ack_deadline_seconds = 600

  push_config {
    # `PUBSUB_PUSH_AUDIENCE` on the service MUST equal this exact URL (the OIDC audience the route checks).
    push_endpoint = var.pubsub_push_endpoint
    oidc_token {
      service_account_email = google_service_account.pubsub_push.email
      audience              = var.pubsub_push_endpoint
    }
  }

  dead_letter_policy {
    dead_letter_topic     = google_pubsub_topic.catalog_reconcile_dlq.id
    max_delivery_attempts = 5
  }
  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "600s"
  }
}

# ── IAM ───────────────────────────────────────────────────────────────────────────────────────────────
# The backend's runtime SA may publish to the topic.
resource "google_pubsub_topic_iam_member" "backend_publish" {
  topic  = google_pubsub_topic.catalog_reconcile.name
  role   = "roles/pubsub.publisher"
  member = "serviceAccount:${var.backend_service_account}"
}

# The push SA may invoke the Cloud Run service. NOTE: the backend deploys `--allow-unauthenticated` (it
# must — /chat is public), so this run.invoker grant provides NO enforcement for the push endpoint: it is
# internet-reachable by anyone, and the route's OWN OIDC check (routes/pubsub-push.ts — signature +
# audience + the exact push-SA email) is the SOLE control. This grant is kept for correctness/least-change,
# not as the security boundary; the boundary is the code.
resource "google_cloud_run_v2_service_iam_member" "push_invoker" {
  name = var.cloud_run_service_name
  # `location` is optional (inferable) but the provider sets `region`, not `location`, so a v2 Cloud Run IAM
  # member can't reliably infer it — set it explicitly to the service's region to avoid an apply-time
  # "location could not be determined" error.
  location = var.region
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.pubsub_push.email}"
}

# The Pub/Sub service agent may mint OIDC tokens AS the push SA (required for push oidc_token).
resource "google_service_account_iam_member" "pubsub_agent_token_creator" {
  service_account_id = google_service_account.pubsub_push.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:service-${var.project_number}@gcp-sa-pubsub.iam.gserviceaccount.com"
}
