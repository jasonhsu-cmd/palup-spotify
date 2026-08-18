terraform {
  required_version = ">= 1.5"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 5.0"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

# ── P3 (go-live checklist) — A3 producer failure alert ────────────────────────────────────────────────
# The producer logs a stably-keyed marker on a facts write/audit failure. This turns that marker into a
# metric + a page. The filter matches the marker TEXT across both places the producer runs — the
# `catalog-index` Cloud Run Job (poll path) and the widget backend Cloud Run Service (webhook reconcile) —
# rather than constraining a single resource.type, so neither path can fail silently.

resource "google_logging_metric" "product_facts_producer_failures" {
  name        = "product_facts_producer_failures"
  description = "A3 catalog producer failed to write or audit Tier-2 price/availability facts."

  # `=~` is a RE2 regex over the log entry's text payload. Matches both `product_facts_upsert_failed`
  # (facts not written) and `product_facts_audit_failed` (written but the §5 record did not land).
  filter = "severity=ERROR AND textPayload =~ \"ALERT product_facts_(upsert|audit)_failed\""

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
    labels {
      key         = "failure_kind"
      value_type  = "STRING"
      description = "upsert or audit"
    }
  }
  # Pull the failure kind out of the marker so the alert/dashboard can distinguish an unwritten refresh
  # from an unaudited write.
  label_extractors = {
    "failure_kind" = "REGEXP_EXTRACT(textPayload, \"product_facts_(upsert|audit)_failed\")"
  }
}

resource "google_monitoring_alert_policy" "product_facts_producer_failures" {
  display_name = "A3 producer: Tier-2 price facts failing to write/audit"
  combiner     = "OR"

  documentation {
    content   = <<-EOT
      The A3 catalog producer emitted `ALERT product_facts_{upsert,audit}_failed`. Fresh Tier-2 price/
      availability facts are not being written (or not audited), so a promoted hydration path would serve
      increasingly stale prices — the D2 staleness ceiling then withholds them, degrading answers.
      Runbook: check the catalog-index Cloud Run Job logs / the backend Service logs for the tenant and
      error in the marker; the scheduled poll re-run is the backstop, so a single transient hit self-heals.
    EOT
    mime_type = "text/markdown"
  }

  conditions {
    display_name = "Any product_facts producer failure in 5m"
    condition_threshold {
      filter          = "resource.type=\"global\" AND metric.type=\"logging.googleapis.com/user/${google_logging_metric.product_facts_producer_failures.name}\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_DELTA"
      }
      trigger {
        count = 1
      }
    }
  }

  notification_channels = var.notification_channel_ids
}
