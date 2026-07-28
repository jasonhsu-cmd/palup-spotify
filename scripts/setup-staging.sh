#!/usr/bin/env bash
# One-time setup for staging auto-deploy: Workload Identity Federation (no keys) + deploy service
# account + GitHub secrets/variables. Run as a project OWNER with gcloud + gh authenticated.
#
#   GCP_PROJECT=palup-jason GITHUB_REPO=jasonhsu-cmd/palup-spotify bash scripts/setup-staging.sh
#
# Idempotent-ish: "already exists" errors are tolerated. See docs/DEPLOY.md.
set -euo pipefail

PROJECT="${GCP_PROJECT:-$(gcloud config get-value project 2>/dev/null)}"
REPO="${GITHUB_REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null)}"
REGION="${GCP_REGION:-us-central1}"
POOL="github-pool"
PROVIDER="github-provider"
SA="palup-deploy"
SA_EMAIL="${SA}@${PROJECT}.iam.gserviceaccount.com"

echo ">> project=$PROJECT repo=$REPO region=$REGION"

echo ">> [1/5] enabling APIs"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  iamcredentials.googleapis.com aiplatform.googleapis.com --project "$PROJECT"

echo ">> [2/5] deploy service account + roles"
gcloud iam service-accounts create "$SA" --project "$PROJECT" --display-name "PalUp deploy" 2>/dev/null || true
for ROLE in roles/run.admin roles/cloudbuild.builds.editor roles/artifactregistry.writer \
            roles/iam.serviceAccountUser roles/aiplatform.user; do
  gcloud projects add-iam-policy-binding "$PROJECT" \
    --member "serviceAccount:$SA_EMAIL" --role "$ROLE" --condition=None >/dev/null
done

echo ">> [3/5] workload identity pool + provider (restricted to $REPO)"
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')
gcloud iam workload-identity-pools create "$POOL" --project "$PROJECT" --location=global \
  --display-name="GitHub pool" 2>/dev/null || true
gcloud iam workload-identity-pools providers create-oidc "$PROVIDER" \
  --project "$PROJECT" --location=global --workload-identity-pool="$POOL" \
  --display-name="GitHub provider" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" \
  --attribute-condition="assertion.repository=='${REPO}'" \
  --issuer-uri="https://token.actions.githubusercontent.com" 2>/dev/null || true

WIF_PROVIDER="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/providers/${PROVIDER}"

echo ">> [4/5] allow the GitHub repo to impersonate the deploy SA"
gcloud iam service-accounts add-iam-policy-binding "$SA_EMAIL" --project "$PROJECT" \
  --role roles/iam.workloadIdentityUser \
  --member "principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/attribute.repository/${REPO}"

echo ">> [5/5] GitHub secrets + variables"
gh secret set GCP_PROJECT --repo "$REPO" --body "$PROJECT"
gh secret set GCP_WIF_PROVIDER --repo "$REPO" --body "$WIF_PROVIDER"
gh secret set GCP_DEPLOY_SA --repo "$REPO" --body "$SA_EMAIL"
gh variable set STAGING_ENABLED --repo "$REPO" --body "true"
gh variable set GCP_REGION --repo "$REPO" --body "$REGION"

echo ">> done. WIF provider: $WIF_PROVIDER"
echo ">> the next merge to main will auto-deploy the widget backend to Cloud Run (staging)."
