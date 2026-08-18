variable "project_id" {
  description = "GCP project id the widget backend + catalog-index job run in."
  type        = string
}

variable "region" {
  description = "Default region (unused by the monitoring resources here, but kept for a consistent provider config)."
  type        = string
  default     = "us-central1"
}

variable "notification_channel_ids" {
  description = <<-EOT
    Monitoring notification channel resource ids the P3 alert routes to, e.g.
    ["projects/<project>/notificationChannels/<id>"]. Empty ⇒ the alert policy is created but pages
    nobody (log-only); list channels with `gcloud beta monitoring channels list`.
  EOT
  type        = list(string)
  default     = []
}

# ── P4 (Pub/Sub) ──────────────────────────────────────────────────────────────────────────────────────
variable "project_number" {
  description = "GCP project NUMBER (not id) — for the Pub/Sub service agent identity that mints push OIDC tokens."
  type        = string
}

variable "pubsub_push_endpoint" {
  description = "Full HTTPS URL of the OIDC push route on the backend, e.g. https://<service>/internal/pubsub/catalog-reconcile. MUST equal PUBSUB_PUSH_AUDIENCE set on the service (the route checks it as the OIDC audience)."
  type        = string
}

variable "backend_service_account" {
  description = "Email of the widget backend's runtime service account (granted publish on the topic)."
  type        = string
}

variable "cloud_run_service_name" {
  description = "Name of the backend Cloud Run v2 service (the push SA is granted run.invoker on it)."
  type        = string
}

# ── #126 (Pub/Sub memory-write queue) ────────────────────────────────────────────────────────────────
variable "memory_pubsub_push_endpoint" {
  description = "Full HTTPS URL of the OIDC push route for the memory-write queue, e.g. https://<service>/internal/pubsub/memory-write. MUST equal MEMORY_PUBSUB_PUSH_AUDIENCE set on the service (the route checks it as the OIDC audience). A SEPARATE endpoint/audience from pubsub_push_endpoint (the catalog route) — the two routes and their verifiers are never interchangeable."
  type        = string
}

variable "memory_pubsub_kms_key_name" {
  description = "Full resource name of an EXISTING Cloud KMS CryptoKey (e.g. projects/<p>/locations/<loc>/keyRings/<ring>/cryptoKeys/<key>) used as the CMEK key for the memory-write topic + its DLQ. OPTIONAL — empty (\"\", the default) leaves the topics WITHOUT CMEK, the posture for internal STAGING (synthetic test traffic only). Set a real key for PRODUCTION, where the message body carries a raw shopper turn (PII / potential Art-9 special-category data). Provisioning the key is a human, out-of-band step; this variable only wires it in."
  type        = string
  default     = ""
}
