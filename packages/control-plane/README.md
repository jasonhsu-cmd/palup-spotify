# @palup/control-plane — self-improvement dashboard

An interactive dashboard over the governed evolution engine: propose → evaluate → **GATE** → human
approve → promote → monitor → auto-rollback, with a champion card, per-candidate gate reasons,
promotion history, immutable audit log, and a kill switch.

## Run

```bash
pnpm monitor            # mock mode — instant preset scores, works offline (good for the UI flow)
# open http://127.0.0.1:8990
```

**Live mode** — measures each candidate policy for REAL by running a quality suite through the live
Gemini agent and grading it with the cross-family judge (Claude/Opus). Requires GCP creds + a key:

```bash
CP_MODE=live \
  GOOGLE_CLOUD_PROJECT=... GOOGLE_CLOUD_LOCATION=global PALUP_MODEL=gemini-3.5-flash \
  ANTHROPIC_API_KEY=... \
  pnpm monitor
```

In live mode, clicking **Evaluate** kicks off grading (~15–30s per policy) in the background — the
candidate shows **evaluating…** and the dashboard updates by polling when the verdict lands. Mock mode
is instant.

Verified live: a "warm, needs-first, concise" candidate scored **1.0** and passed the gate (awaiting
approval), while a "push the expensive option + urgency" candidate scored **0.5** and was **blocked**
(quality regressed) — real differentiation from the live model + judge, not preset scores.

## API

`GET /api/state` · `POST /api/seed` · `POST /api/evaluate/:id` · `POST /api/approve/:id` ·
`POST /api/reject/:id` · `POST /api/promote/:id` · `POST /api/kill` · `POST /api/unkill` ·
`POST /api/monitor` (simulate a live regression → auto-rollback).
