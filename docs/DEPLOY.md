# Deploy & scheduler (staging)

Staging **auto-deploys on merge to `main`**; **production is never auto-deployed** (locked decision,
`docs/design/build-automation.md` §1). Everything here is **inactive until you configure GCP↔GitHub
auth** — the workflows are guarded by the `STAGING_ENABLED` repo variable so `main` stays green until
then.

> Status: the container + workflows are authored and the app runs locally, but the **Docker image build
> and the actual Cloud Run deploy are unverified from this environment** (no Docker daemon; cloud deploys
> require the setup below, which only a project owner can do).

## One-time setup

**Fastest — run the script** (as a project owner with `gcloud` + `gh` authenticated):

```bash
GCP_PROJECT=palup-jason GITHUB_REPO=jasonhsu-cmd/palup-spotify bash scripts/setup-staging.sh
```

It does everything below (WIF pool/provider restricted to your repo, deploy SA + roles, and the GitHub
secrets/variables incl. `STAGING_ENABLED=true`). The manual equivalent:

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
- **`.github/workflows/drift-check.yml`** — **manual** ("Run workflow"), no schedule: a live-model smoke
  + the cross-family judge (guarded by `STAGING_ENABLED` / `JUDGE_ENABLED`). The offline eval is
  deterministic and already runs in CI on every PR, so it isn't re-run on a timer; trigger this only to
  check the live model (e.g. after Google updates the `gemini-2.5-flash` alias).

## Local

```bash
pnpm backend        # http://127.0.0.1:8787 (mock model; set the Vertex env for real Gemini)
docker build -t palup-widget:staging .   # requires a running Docker daemon
```

## Live-judge-on-merge (eval-quality.yml)

Auto-runs the live 190-case judge when a model-dependent change lands on `main`, and **opens an issue
if quality regresses** — so drift surfaces itself. **Dormant until you add:**

- **Variable** `JUDGE_ENABLED = true` (turns the job on).
- **Variable** `GCP_PROJECT` (e.g. `palup-jason`). Optional: `GCP_LOCATION` (default `global`), `PALUP_MODEL`, `JUDGE_MODEL` (default `claude-haiku-4-5-20251001` — fast/cheap for the bulk run).
- **Secret** `ANTHROPIC_API_KEY` — the cross-family judge.
- **Secret** `GCP_SA_KEY` — a Google service-account key JSON with `roles/aiplatform.user` (Vertex).

```bash
# one-time, as a repo admin with gh authenticated:
gh variable set JUDGE_ENABLED --repo <owner>/<repo> --body true
gh variable set GCP_PROJECT   --repo <owner>/<repo> --body palup-jason
gh secret   set ANTHROPIC_API_KEY --repo <owner>/<repo>            # paste the key when prompted
gh secret   set GCP_SA_KEY        --repo <owner>/<repo> < sa-key.json
```
The baseline lives in `.github/eval-baseline.json`; regenerate it after a real improvement
(`pnpm eval:full` → copy the byLayer rates). Regression tolerances absorb the judge's run-to-run variance.

## Cross-family judge (optional, related)

`pnpm eval:judge` defaults to an **advisory** same-family Gemini judge. For the **gating** cross-family
judge there are two paths:

**A) Anthropic API key (simplest — no GCP/Model Garden):**
```bash
export ANTHROPIC_API_KEY=...            # your key (never commit it)
JUDGE_FAMILY=anthropic pnpm eval:judge  # gates; uses Claude via the direct API
# optional: ANTHROPIC_MODEL=claude-haiku-4-5-20251001 (default) or another current id
```

**B) Claude on Vertex** (if you'd rather stay in GCP) — enable a Claude model in Model Garden, then:
```bash
JUDGE_FAMILY=anthropic JUDGE_MODEL=<enabled-claude-id> ANTHROPIC_VERTEX_REGION=us-east5 pnpm eval:judge
```
(The harness prefers path A when `ANTHROPIC_API_KEY` is set.)
