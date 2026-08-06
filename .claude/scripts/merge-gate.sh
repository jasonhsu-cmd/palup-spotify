#!/usr/bin/env bash
# Merge gate. This repo has NO branch protection and allow_auto_merge=false, so `gh pr merge --auto`
# is rejected and THIS SCRIPT IS THE ENTIRE GATE. `mergeStateStatus: CLEAN` means "no conflicts", NOT
# "checks passed" — never treat it as a pass signal.
#
# Kept in the repo (not session tmp) because the previous copy vanished with a session and had to be
# rebuilt from memory — a gate you can lose is a gate you will eventually skip.
#
# usage: .claude/scripts/merge-gate.sh <pr-number>
#        THRESHOLD_REVIEWED="<what you checked>" .claude/scripts/merge-gate.sh <pr>   # see below
set -uo pipefail
PR="${1:?usage: merge-gate.sh <pr>}"
R="${MERGE_GATE_REPO:-jasonhsu-cmd/palup-spotify}"

# The five gate steps ci.yml must actually run. HARDCODED ON PURPOSE — never derived from the PR's own
# ci.yml, or a PR that deletes a gate step would be measured against its own weakened definition.
EXPECT=(
  "Typecheck"
  "Unit + port-contract tests"
  "Self-improvement eval gate (safety floor + no-regression)"
  "Application E2E (blocking pre-promotion gate)"
  "Control-plane self-improvement E2E (mock)"
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

RUN=$(gh api "repos/$R/actions/runs?event=pull_request&head_sha=$HEAD&per_page=100" \
      --jq '[.workflow_runs[] | select(.path==".github/workflows/ci.yml")] | sort_by(.run_number) | last')
[ -n "$RUN" ] && [ "$RUN" != null ] || die "no ci.yml run for head $HEAD (absent, not merely pending)"

read -r RSTATUS RCONCL RID RBASE <<<"$(jq -rn --argjson r "$RUN" \
  '[$r.status, ($r.conclusion//"null"), $r.id, ($r.pull_requests[0].base.sha//"null")]|@tsv')"
echo "ci run $RID: status=$RSTATUS conclusion=$RCONCL base=$RBASE"

[ "$RSTATUS" = completed ] || die "ci is '$RSTATUS' — not completed"
# ONLY success. skipped/neutral/cancelled/timed_out/action_required are NOT passes.
[ "$RCONCL" = success ] || die "ci conclusion is '$RCONCL', not success"

# Freshness oracle: GitHub records the base the run was computed against. If main has moved, the green
# proves the PR passed against an OLDER main, not against what we are merging into.
[ "$RBASE" = "$MAIN" ] || die "STALE GREEN — ci ran against base $RBASE but main is now $MAIN. Update the branch and let ci re-run."

STEPS=$(gh api "repos/$R/actions/runs/$RID/jobs" --jq '.jobs[].steps[] | "\(.name)\t\(.conclusion)"')
for s in "${EXPECT[@]}"; do
  line=$(printf '%s\n' "$STEPS" | grep -F -m1 "$s	") || die "gate step MISSING from the run: '$s'"
  [ "${line##*	}" = success ] || die "gate step '$s' concluded '${line##*	}'"
  echo "  ok  $s"
done

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

MAIN2=$(gh api "repos/$R/git/ref/heads/main" --jq .object.sha)
[ "$MAIN2" = "$MAIN" ] || die "main moved mid-check ($MAIN -> $MAIN2); re-run the gate"

echo "GATE PASS #$PR — merging at $HEAD"
gh pr merge "$PR" -R "$R" --squash --delete-branch --match-head-commit "$HEAD"
