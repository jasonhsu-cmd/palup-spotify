// GOVERNANCE-RULES GUARD — the pure decision logic behind merge-gate.sh's "does this PR touch the
// rules that govern the two-plane agent architecture" check (CLAUDE.md §3 NN#1/#2, docs/HITL-POLICY.md).
//
// WHY THIS IS SEPARATE FROM THE EXISTING NO-WEAKENING CHECKS IN merge-gate.sh: those checks (workflow
// gate-step deletion, eval threshold edits, MEMORY_ADR_ACCEPTED, HITL-POLICY text removal) each detect a
// SPECIFIC weakening pattern in a diff. This guard is coarser and stricter on purpose — it does not try to
// tell "safe edit" from "unsafe edit" within a governance-rules file; it refuses ANY change to one of a
// small, precise set of files unless a human explicitly says GOVERNANCE_HUMAN_APPROVED=1. The file list is
// the whole contract, so it is kept short and exact-matched (never a directory prefix or glob) to avoid
// over-blocking routine work — see the "MUST NOT refuse" list below.
//
// Kept as a pure, dependency-free function (files in, decision out) so it is testable without a live `gh`
// call or a git checkout — merge-gate.sh shells out to the CLI wrapper at the bottom of this file with the
// PR's changed-file list on stdin.

/**
 * The exact set of files whose RULES bind both agent planes (CLAUDE.md §2-§3). Deliberately small and
 * exact-matched — NOT a directory prefix — because over-blocking (e.g. all of docs/, all of
 * packages/eval/) is its own failure mode: it would force a human merge for routine doc fixes or eval-case
 * additions that are not governance-rules changes at all.
 *
 * - CLAUDE.md — the operating manual itself: the non-negotiables (§3), the plane split (§2), the dev loop
 *   and merge-authority policy (§4).
 * - docs/HITL-POLICY.md — the exact HITL boundary list CLAUDE.md §3 NN#1 defers to.
 * - .claude/scripts/merge-gate.sh — the gate itself. Editing the gate needs the same human eye as editing
 *   the rules it enforces (and IS self-referential: this very file's diff trips this exact check).
 * - packages/eval/src/run.ts — "the self-improvement GATE" per its own header comment: runCandidate +
 *   evaluate() are the real gate packages/eval/test/gate.test.ts exercises (not a reconstruction).
 * - packages/evolution/src/engine.ts — "the governed self-improvement pipeline" per its own header comment:
 *   propose -> evaluate -> gate -> human approve -> promote, i.e. the evolution-pipeline gate CLAUDE.md §3
 *   NN#2 requires.
 *
 * Explicitly NOT here (by design, not oversight):
 * - docs/adr/*.md — ADR status reconciles are ordinary, auto-mergeable doc updates (e.g. #410 on
 *   docs/adr/0018). An ADR records a decision; it does not enforce one the way the files above do.
 * - docs/AGENT-GOVERNANCE.md — merge-gate.sh's existing check 4 already gates text REMOVAL from it with
 *   POLICY_REVIEWED, a lighter-touch mechanism than an outright refuse; duplicating it here would make an
 *   additive amendment (already allowed) into a full refuse.
 * - packages/eval/src/suites.ts, packages/eval/src/floor.ts, packages/eval/cases/*.json, and the rest of
 *   packages/eval / packages/evolution — ordinary eval-case/data additions and non-gate code, already
 *   covered (for numeric threshold edits specifically) by merge-gate.sh's existing THRESHOLD_REVIEWED check.
 */
const GOVERNANCE_RULES_FILES: ReadonlySet<string> = new Set([
  "CLAUDE.md",
  "docs/HITL-POLICY.md",
  ".claude/scripts/merge-gate.sh",
  "packages/eval/src/run.ts",
  "packages/evolution/src/engine.ts",
]);

/** True iff `path` is one of the exact governance-rules files above. */
export function isGovernanceRulesFile(path: string): boolean {
  return GOVERNANCE_RULES_FILES.has(path);
}

/** The subset of `files` that are governance-rules files, in their original order. */
export function findGovernanceRuleChanges(files: readonly string[]): string[] {
  return files.filter(isGovernanceRulesFile);
}

export interface GovernanceGateDecision {
  /** true iff the merge must be refused (a governance-rules file changed and no human approval was given). */
  refuse: boolean;
  /** the governance-rules files the PR touches (empty when refuse is false because nothing matched). */
  matched: string[];
}

/**
 * The single decision merge-gate.sh acts on: refuse unless (a) no governance-rules file is touched, or
 * (b) a human has set GOVERNANCE_HUMAN_APPROVED=1. Never a silent bypass — `matched` is always returned so
 * the caller can name the file(s) in its refusal message, even when `humanApproved` allows the merge.
 */
export function decideGovernanceGate(files: readonly string[], humanApproved: boolean): GovernanceGateDecision {
  const matched = findGovernanceRuleChanges(files);
  return { refuse: matched.length > 0 && !humanApproved, matched };
}

// ── CLI wrapper — the only part merge-gate.sh actually runs ────────────────────────────────────────────
// Reads newline-separated changed-file paths from stdin (merge-gate.sh already has this as `$FILES` from
// `gh pr diff --name-only`), reads GOVERNANCE_HUMAN_APPROVED from the environment, and:
//   - prints each matched governance-rules file to stdout (one per line), for the caller's refusal message
//   - exits 0 if the gate ALLOWS the merge, exits 1 if it must REFUSE
// Deliberately thin and untested directly (stdin/env plumbing only) — all the actual decision logic above
// is pure and covered by packages/eval/test/governance-guard.test.ts.
if (import.meta.url === `file://${process.argv[1]}`) {
  const chunks: Buffer[] = [];
  process.stdin.on("data", (c: Buffer | string) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c, "utf8")));
  process.stdin.on("end", () => {
    const files = Buffer.concat(chunks)
      .toString("utf8")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    const humanApproved = process.env.GOVERNANCE_HUMAN_APPROVED === "1";
    const { refuse, matched } = decideGovernanceGate(files, humanApproved);
    for (const f of matched) process.stdout.write(f + "\n");
    process.exit(refuse ? 1 : 0);
  });
}
