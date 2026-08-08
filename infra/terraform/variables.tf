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
