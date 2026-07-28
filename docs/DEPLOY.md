# Deploy & scheduler (staging)

Staging **auto-deploys on merge to `main`**; **production is never auto-deployed** (locked decision,
`docs/design/build-automation.md` §1). Everything here is **inactive until you configure GCP↔GitHub
auth** — the workflows are guarded by the `STAGING_ENABLED` repo variable so `main` stays green until
then.

> Status: the container + workflows are authored and the app runs locally, but the **Docker image build
> and the actual Cloud Run deploy are unverified from this environment** (no Docker daemon; cloud deploys
> require the setup below, which only a project owner can do).

## One-time setup

1. **Enable APIs** in your GCP project: Cloud Run, Cloud Build, Artifact Registry, Vertex AI.
2. **Workload Identity Federation** (no long-lived keys): create a WIF pool + provider for GitHub, and a
   deploy service account with `roles/run.admin`, `roles/cloudbuild.builds.editor`,
   `roles/artifactregistry.writer`, `roles/iam.serviceAccountUser`, and `roles/aiplatform.user`
   (so the running service can call Vertex).
3. **GitHub repo → Settings:**
   - **Variables:** `STAGING_ENABLED=true`, optionally `GCP_REGION` (default `us-central1`).
   - **Secrets:** `GCP_PROJECT`, `GCP_WIF_PROVIDER` (full provider resource name), `GCP_DEPLOY_SA`
     (deploy SA email).

## What runs

- **`.github/workflows/deploy-staging.yml`** — on push to `main`: `gcloud run deploy` from source, then a
  **post-deploy health smoke gate** (`/health` returns `{"ok":true}`). The service gets
  `GOOGLE_CLOUD_PROJECT`/`LOCATION`/`PALUP_MODEL`, so it serves the **real Gemini** model.
- **`.github/workflows/scheduled-eval.yml`** — every 6h: the deterministic **eval gate** (always), plus a
  **live-model smoke** when `STAGING_ENABLED`. Reports upload as an artifact.

## Local

```bash
pnpm backend        # http://127.0.0.1:8787 (mock model; set the Vertex env for real Gemini)
docker build -t palup-widget:staging .   # requires a running Docker daemon
```

## Cross-family judge (optional, related)

`pnpm eval:judge` defaults to an **advisory** same-family Gemini judge. For the **gating** cross-family
judge, **enable a Claude model in your project's Model Garden** (accept Anthropic terms), then:

```bash
JUDGE_FAMILY=anthropic JUDGE_MODEL=<enabled-claude-id> ANTHROPIC_VERTEX_REGION=us-east5 pnpm eval:judge
```
