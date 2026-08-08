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
