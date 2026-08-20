#!/usr/bin/env bash
# Merge gate. This repo has NO branch protection and allow_auto_merge=false, so `gh pr merge --auto`
# is rejected and THIS SCRIPT IS THE ENTIRE GATE. `mergeStateStatus: CLEAN` means "no conflicts", NOT
# "checks passed" — never treat it as a pass signal.
#
# LOCAL GATE (owner decision 2026-08-07). GitHub CI (`ci.yml`) no longer runs on pull requests — it runs
# only on `push: main`, purely as the deploy gate. So this script RUNS THE SEVEN GATE STEPS LOCALLY against
# the PR head before merging, instead of reading a GitHub Actions run. Rationale: a GitHub Actions outage
# must not be able to block a merge, and CI minutes are reserved for the deploy path. Trust model is
# unchanged (no branch protection; the merger runs this honestly); what is lost is CI's clean room, so it
# checks out the PR head on a CLEAN working tree and runs there.
#
# Kept in the repo (not session tmp) because the previous copy vanished with a session and had to be
# rebuilt from memory — a gate you can lose is a gate you will eventually skip.
#
# usage: .claude/scripts/merge-gate.sh <pr-number>
#        THRESHOLD_REVIEWED="<what you checked>" .claude/scripts/merge-gate.sh <pr>   # see below
set -uo pipefail
PR="${1:?usage: merge-gate.sh <pr>}"
R="${MERGE_GATE_REPO:-jasonhsu-cmd/palup-spotify}"

# The seven gate steps. HARDCODED ON PURPOSE — never derived from the PR's own ci.yml, or a PR that
# deletes a gate step would be measured against its own weakened definition. Used TWICE below: to run the
# gate locally, and (by the no-weakening check) to guard against a PR deleting these names from ci.yml,
# which still runs them on push:main as the deploy gate.
EXPECT=(
  "Typecheck"
  "Unit + port-contract tests"
  "Self-improvement eval gate (safety floor + no-regression)"
  "Application E2E (blocking pre-promotion gate)"
  "Control-plane self-improvement E2E (mock)"
  "Embed round-trip E2E (mock)"
  "Storefront catalog E2E (mock, demo-tenant fixtures)"
  "pgvector ANN adapter (testcontainer)"
)

die() { echo "REFUSE #$PR: $*" >&2; exit 1; }

MAIN=$(gh api "repos/$R/git/ref/heads/main" --jq .object.sha) || die "cannot read main"
echo "main snapshot: $MAIN"

read -r BASE DRAFT STATE HEAD <<<"$(gh pr view "$PR" -R "$R" \
  --json baseRefName,isDraft,state,headRefOid \
  --jq '[.baseRefName,.isDraft,.state,.headRefOid]|@tsv')" || die "cannot read PR"
[ "$BASE"  = main  ]  || die "base is '$BASE', not main"
[ "$DRAFT" = false ]  || die "PR is a draft"
[ "$STATE" = OPEN  ]  || die "PR state is $STATE"
[ "${#HEAD}" -eq 40 ] || die "head sha is not a full 40-char sha — the API will not match a short sha"
echo "head: $HEAD"

# --- LOCAL execution of the seven gate steps against the PR head (replaces reading a GitHub CI run) -----
# A dirty tree would mean we test something other than the PR head — refuse rather than measure the wrong
# thing (the same failure class as the empty-diff bug guarded below).
[ -z "$(git status --porcelain)" ] || die "working tree is dirty — commit or stash before running the gate"

git fetch -q origin main || die "cannot fetch origin/main"
[ "$(git rev-parse origin/main)" = "$MAIN" ] || die "local origin/main is not the repo's main head — re-fetch and re-run"

# Check out the PR head locally. This MUTATES your checkout on purpose — you are merging this PR.
gh pr checkout "$PR" -R "$R" >/dev/null 2>&1 || die "cannot check out PR #$PR"
LOCALHEAD=$(git rev-parse HEAD)
[ "$LOCALHEAD" = "$HEAD" ] || die "checked-out head $LOCALHEAD != PR head $HEAD (a force-push during the gate?)"

# Freshness: the branch must contain CURRENT main, or a green proves nothing about what we merge into.
git merge-base --is-ancestor "$MAIN" HEAD || die "STALE — branch does not contain current main ($MAIN); rebase onto main and re-run"

echo "running the gate LOCALLY at $LOCALHEAD (GitHub CI does not gate PRs — owner decision 2026-08-07)"
pnpm install --frozen-lockfile >/tmp/gate.log 2>&1 || { tail -25 /tmp/gate.log >&2; die "pnpm install --frozen-lockfile failed"; }
# Browsers for the E2E steps. Non-fatal: they are usually already present; --with-deps is skipped so no sudo.
pnpm exec playwright install chromium >>/tmp/gate.log 2>&1 || echo "  (playwright install warned — continuing; browsers likely already present)"
gate_step() {
  echo "  .. $1"
  if ! eval "$2" >/tmp/gate.log 2>&1; then tail -30 /tmp/gate.log >&2; die "LOCAL gate step FAILED: '$1'"; fi
  echo "  ok  $1"
}
gate_step "Typecheck" "pnpm typecheck"
gate_step "Unit + port-contract tests" "pnpm test"
gate_step "Self-improvement eval gate (safety floor + no-regression)" "pnpm eval"
gate_step "Application E2E (blocking pre-promotion gate)" "pnpm e2e"
gate_step "Control-plane self-improvement E2E (mock)" "pnpm e2e:monitor"
gate_step "Embed round-trip E2E (mock)" "pnpm e2e:embed"
gate_step "Storefront catalog E2E (mock, demo-tenant fixtures)" "pnpm e2e:storefront-catalog"
# Cannot pass vacuously: (a) refuses if Docker is unreachable rather than silently skipping every
# pgvector test, (b) forces PGVECTOR_TESTCONTAINER to a value that is NOT "off" so an inherited/local skip flag can never
# disable this REQUIRED step, and (c) greps its own output for a non-zero passed count — a testcontainer
# run that reports 0 tests executed (e.g. every file skipIf'd) fails the gate instead of reading green.
gate_step "pgvector ANN adapter (testcontainer)" '
  docker info >/dev/null 2>&1 || { echo "Docker is not reachable — required for the pgvector ANN adapter gate" >&2; exit 1; }
  # Colour breaks the vacuous-guard grep below: it matches a literal "Tests <n> passed", but the runners
  # ANSI escapes (e.g. "Tests \e[32m43 passed" — whose codes even CONTAIN digits, so a [^digit] skip cannot
  # absorb them) split "Tests" from the count and false-fail a genuinely green run. Fix: force PLAIN output
  # (NO_COLOR/FORCE_COLOR=0); and, as a belt if a tool ignores that, strip any residual escapes before the
  # grep — falling back to the raw output if perl is unavailable, so the strip can never itself cause a
  # false-fail. The strict [1-9] count still fails a 0-passed / vacuous run exactly as before.
  OUT=$(NO_COLOR=1 FORCE_COLOR=0 PGVECTOR_TESTCONTAINER=required pnpm test:pgvector 2>&1)
  STATUS=$?
  echo "$OUT"
  [ $STATUS -eq 0 ] || exit 1
  CLEAN=$(printf "%s\n" "$OUT" | perl -pe "s/\e\[[0-9;]*[A-Za-z]//g" 2>/dev/null)
  [ -n "$CLEAN" ] || CLEAN="$OUT"
  printf "%s\n" "$CLEAN" | grep -qE "Tests[[:space:]]+[1-9][0-9]*[[:space:]]+passed" \
    || { echo "pgvector suite reported zero passed tests — refusing a vacuous gate" >&2; exit 1; }
'

# The diff MUST be fetched. A transient failure once left this empty and every check below "passed" over
# nothing while still merging — an absent measurement reading as a pass. Retry, then refuse.
FILES=""; DIFF=""
for attempt in 1 2 3 4; do
  if FILES=$(gh pr diff "$PR" -R "$R" --name-only 2>/dev/null) && DIFF=$(gh pr diff "$PR" -R "$R" 2>/dev/null) && [ -n "$DIFF" ]; then break; fi
  echo "  (diff fetch attempt $attempt failed; retrying)" >&2
  FILES=""; DIFF=""; sleep 5
done
[ -n "$FILES" ] || die "could not fetch the PR file list — refusing to merge without the no-weakening checks"
[ -n "$DIFF" ]  || die "could not fetch the PR diff — refusing to merge without the no-weakening checks"

# 1. the workflow itself
if printf '%s\n' "$FILES" | grep -q '^\.github/workflows/'; then
  printf '%s\n' "$DIFF" | grep -E '^-' | grep -E "$(IFS='|'; echo "${EXPECT[*]}")" \
    && die "the PR DELETES a gate step from a workflow"
  printf '%s\n' "$DIFF" | grep -E '^\+' | grep -qE 'continue-on-error:\s*true|\|\|\s*true|if:\s*false' \
    && die "the PR makes a gate non-blocking (continue-on-error / '|| true' / if:false)"
fi

# 2. the eval floor. Only a NUMERIC ASSIGNMENT counts — matching the bare word "threshold" once fired on
#    code comments and a test asserting a module exports no threshold.
if printf '%s\n' "$FILES" | grep -qE '^packages/eval/|^packages/evolution/'; then
  printf '%s\n' "$DIFF" | grep -E '^-' | grep -q '"floor": *true' && die "the PR REMOVES a floor:true eval case"
  IDENT='minSafety|minOverall|minFairness|minCompliance|minDelta|[A-Za-z_]*[Tt]hreshold[A-Za-z_]*|MAX_CANARY_PCT'
  LOW=$(printf '%s\n' "$DIFF" | grep -E '^[-+]' | grep -vE '^[-+]{3}' \
        | grep -vE '^[-+][[:space:]]*(//|/\*|\*)' \
        | grep -E "($IDENT)[[:space:]]*[:=][[:space:]]*-?[0-9]" || true)
  if [ -n "$LOW" ]; then
    echo "!! a gate threshold NUMBER is touched — REVIEW BY HAND:"; printf '%s\n' "$LOW"
    # A PR may legitimately ADD a threshold that did not exist (that strengthens the gate). The check
    # cannot tell "added 99" from "lowered to 99", so it demands a reviewed override with a stated reason,
    # recorded here rather than being a silent bypass.
    if [ -n "${THRESHOLD_REVIEWED:-}" ]; then
      echo "   OVERRIDE ACCEPTED — reviewed: $THRESHOLD_REVIEWED"
    else
      die "a threshold constant is modified; review it and re-run with THRESHOLD_REVIEWED='<what you checked>'"
    fi
  fi
fi

# 3. the memory double gate is a human-only flip, never a build agent's
printf '%s\n' "$DIFF" | grep -E '^\+' | grep -qE 'MEMORY_ADR_ACCEPTED\s*=\s*true' \
  && die "the PR flips MEMORY_ADR_ACCEPTED — human-only, after legal sign-off"

# 4. governance policy must not LOSE text without a stated review (additive amendments are fine)
if printf '%s\n' "$FILES" | grep -qE '^docs/(HITL-POLICY|AGENT-GOVERNANCE)\.md$'; then
  REMOVED=$(printf '%s\n' "$DIFF" | grep -E '^-' | grep -vE '^-{3}' | grep -vE '^-\s*$' || true)
  if [ -n "$REMOVED" ]; then
    echo "!! governance policy text REMOVED — REVIEW BY HAND:"; printf '%s\n' "$REMOVED" | head -20
    [ -n "${POLICY_REVIEWED:-}" ] || die "governance text is removed; re-run with POLICY_REVIEWED='<what you checked>'"
    echo "   OVERRIDE ACCEPTED — reviewed: $POLICY_REVIEWED"
  fi
fi

# 5. governance RULES files — an exact, small, precise set (packages/eval/src/governance-guard.ts is the
# single source of truth for the list and the decision, tested in packages/eval/test/governance-guard.test.ts):
# CLAUDE.md, docs/HITL-POLICY.md, this gate script itself, and the two gate/pipeline modules (eval-gate
# run.ts, evolution engine.ts). Any OTHER change to these needs a human's explicit say-so via
# GOVERNANCE_HUMAN_APPROVED=1 — unlike checks 1-4 above (which detect a specific weakening PATTERN in the
# diff), this refuses on touching the file AT ALL, additive or not, because these files ARE the rules.
# docs/adr/* and ordinary code/docs are deliberately excluded (see the file list's own comments) so an ADR
# reconcile or routine PR is never forced through this gate.
GOV_OUT=$(printf '%s\n' "$FILES" | GOVERNANCE_HUMAN_APPROVED="${GOVERNANCE_HUMAN_APPROVED:-}" pnpm exec tsx packages/eval/src/governance-guard.ts)
GOV_STATUS=$?
if [ "$GOV_STATUS" -ne 0 ]; then
  die "touches governance rules ($(printf '%s' "$GOV_OUT" | tr '\n' ',' | sed 's/,$//')); set GOVERNANCE_HUMAN_APPROVED=1 to confirm a human authorized this merge."
elif [ -n "$GOV_OUT" ]; then
  echo "GOVERNANCE_HUMAN_APPROVED=1 — merging governance-rules change(s) with explicit human authorization: $(printf '%s' "$GOV_OUT" | tr '\n' ',' | sed 's/,$//')"
fi

MAIN2=$(gh api "repos/$R/git/ref/heads/main" --jq .object.sha)
[ "$MAIN2" = "$MAIN" ] || die "main moved mid-check ($MAIN -> $MAIN2); re-run the gate"

echo "GATE PASS #$PR — merging at $HEAD"
gh pr merge "$PR" -R "$R" --squash --delete-branch --match-head-commit "$HEAD"

# The PR branch we checked out is now deleted — land the operator back on fresh main, not a dangling ref.
git checkout -q main 2>/dev/null && git pull -q origin main 2>/dev/null || echo "  (note: check out main manually; the merged PR branch is gone)"
