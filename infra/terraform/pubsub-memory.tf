# ── #126 (async memory-write queue) — durable Pub/Sub queue for the memory-write path ──────────────────
# The widget backend PUBLISHES a memory-write message per /chat turn (memory-write-queue.ts); Pub/Sub PUSHES
# it to the OIDC-verified route (routes/pubsub-push-memory.ts) which calls the SAME memoryService.remember()
# every inline caller uses today. Mirrors pubsub.tf's catalog-reconcile pattern (topic + DLQ + push SA + push
# subscription + OIDC + IAM) with two additions, because the message body carries a RAW SHOPPER TURN
# (message + reply — the exact text remember()'s own consent gate may classify as Art-9 special-category
# data): CMEK encryption at rest (`kms_key_name`) on both topics, and a SHORT `message_retention_duration` so
# a replayable backlog cannot sit around (encrypted or not) indefinitely once delivered and acked.
#
# NEVER auto-applied; `terraform apply` is a human action (§3/§5). The env the backend reads to switch onto
# this path (MEMORY_PUBSUB_TOPIC / MEMORY_PUBSUB_PUSH_SERVICE_ACCOUNT / MEMORY_PUBSUB_PUSH_AUDIENCE) is set
# on the Cloud Run service SEPARATELY at deploy (deploy-staging.yml's MEMORY_PUBSUB_AUDIENCE-gated block) —
# creating this infra does not by itself register the push route, and the route registering does not by
# itself enable memory (memoryServiceEnabled — the ADR-0015 double gate, MEMORY_ADR_ACCEPTED — is a SEPARATE,
# human-only flip; see docs/MEMORY-GO-LIVE-CHECKLIST.md).

# The topic the backend publishes to. `MEMORY_PUBSUB_TOPIC` on the service = this topic's short name.
resource "google_pubsub_topic" "memory_write" {
  name         = "memory-write"
  kms_key_name = var.memory_pubsub_kms_key_name
  # PII/Art-9 in flight — bound how long an unacked/backlogged message can sit, unlike the non-PII
  # catalog-reconcile topic (which has no retention override, i.e. the 31-day API default).
  message_retention_duration = "86400s" # 24h
}

# Dead-letter topic: a message that fails `max_delivery_attempts` times lands here instead of retrying
# forever. There is deliberately NO scheduled backstop for a dead-lettered memory write (unlike catalog's
# poll job) — a dropped fact degrades gracefully (the shopper is simply not remembered next visit), so this
# is inspected operationally rather than auto-replayed.
resource "google_pubsub_topic" "memory_write_dlq" {
  name                       = "memory-write-dlq"
  kms_key_name               = var.memory_pubsub_kms_key_name
  message_retention_duration = "86400s"
}

# The identity Pub/Sub PUSHES AS for this route. The route accepts a token ONLY from this SA
# (expectedServiceAccount), so being Google-signed is necessary but not sufficient — and it is a DEDICATED
# SA, distinct from the catalog route's `pubsub-catalog-push`, so a compromise of one push identity cannot
# forge deliveries to the other route. `MEMORY_PUBSUB_PUSH_SERVICE_ACCOUNT` on the service = this SA's email.
resource "google_service_account" "pubsub_memory_push" {
  account_id   = "pubsub-memory-push"
  display_name = "Pub/Sub → memory-write push identity"
}

resource "google_pubsub_subscription" "memory_write_push" {
  name  = "memory-write-push"
  topic = google_pubsub_topic.memory_write.id

  # Ordered per publish orderingKey (ctx.anonId — memory-write-queue.ts sets `tenantKey` to the SUBJECT, not
  # the tenant, per ADR-0006 §Decision.4: two turns for the same shopper must land in order even if their
  # distilled facts race).
  enable_message_ordering = true
  ack_deadline_seconds    = 120

  push_config {
    # `MEMORY_PUBSUB_PUSH_AUDIENCE` on the service MUST equal this exact URL (the OIDC audience the route
    # checks) — the audience DIFFERS from the catalog route's; the two are never interchangeable.
    push_endpoint = var.memory_pubsub_push_endpoint
    oidc_token {
      service_account_email = google_service_account.pubsub_memory_push.email
      audience              = var.memory_pubsub_push_endpoint
    }
  }

  dead_letter_policy {
    dead_letter_topic     = google_pubsub_topic.memory_write_dlq.id
    max_delivery_attempts = 5
  }
  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "600s"
  }
}

# ── IAM ───────────────────────────────────────────────────────────────────────────────────────────────
# The backend's runtime SA may publish to the topic.
resource "google_pubsub_topic_iam_member" "backend_publish_memory" {
  topic  = google_pubsub_topic.memory_write.name
  role   = "roles/pubsub.publisher"
  member = "serviceAccount:${var.backend_service_account}"
}

# The push SA may invoke the Cloud Run service. NOTE (same as pubsub.tf): the backend deploys
# `--allow-unauthenticated`, so this run.invoker grant provides NO enforcement for the push endpoint — the
# route's OWN OIDC check (routes/pubsub-push-memory.ts — signature + audience + the exact push-SA email) is
# the SOLE control. Kept for correctness/least-change, not as the security boundary.
resource "google_cloud_run_v2_service_iam_member" "memory_push_invoker" {
  name     = var.cloud_run_service_name
  location = var.region
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.pubsub_memory_push.email}"
}

# The Pub/Sub service agent may mint OIDC tokens AS the push SA (required for push oidc_token).
resource "google_service_account_iam_member" "pubsub_memory_agent_token_creator" {
  service_account_id = google_service_account.pubsub_memory_push.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:service-${var.project_number}@gcp-sa-pubsub.iam.gserviceaccount.com"
}
