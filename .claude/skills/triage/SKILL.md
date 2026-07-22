---
name: triage
description: >-
  Load on a scheduled/automation run to discover and triage build-time work — read CI failures, open
  coverage-matrix rows, failing evals, and dependency/security alerts, then write findings + status
  to the durable state file so the loop is resumable. Use as the heartbeat of the autonomous build
  loop (`docs/design/build-automation.md`).
---

# Triage skill — the loop's discovery + memory

The loop forgets between runs; the repo doesn't. This skill turns a scheduled run into a **resumable**
loop by surfacing work and persisting it **outside the conversation**.

## On each run

1. **Discover** — gather, don't guess:
   - CI/build/test failures since the last run (read the actual output; don't infer).
   - Open **coverage-matrix rows** not yet implemented (`docs/design/ui-backend-coverage-matrix.md`)
     and unmet **go/no-go conditions** (`docs/design/README.md`).
   - Failing/regressed evals; dependency + license-scan + security alerts (`oss-and-licensing.md`).
2. **Write to the state file (the spine).** Append/update findings in the durable board (markdown
   file or issue tracker — *not* the conversation), each with: id, source, **an explicit
   machine-checkable acceptance criterion**, risk, status (`open` / `in-progress` / `parked` /
   `done`), and a pointer to the governing spec + ADR. Never overwrite history; status transitions are
   auditable.
3. **Select risk-first** — ports + data model + runtime skeleton first, then the cart-recovery wedge,
   then screen-group by screen-group. Hand each selected item to the orchestrator as a `/goal` with
   its acceptance criterion.
4. **Resume, don't repeat.** Read the state file first; pick up where the last run stopped; never
   silently re-do a `done` item or drop a `parked` one (parked items carry a diagnostic).

## Rules

- **Findings are evidence, not claims** — cite the CI line / file / eval that produced each. No
  fabricated failures (honesty rules).
- **Every item needs a verifiable acceptance criterion** before it's dispatched; if it can't get one,
  route it to `solution-architect`, don't start it.
- **This skill does not fix or deploy** — it surfaces and records work. Fixing is the builders'
  job (up to a PR); merge/promote stay human (`build-automation.md`).
- Anything the loop can't handle lands in the state file's triage inbox for a human.

## Memory discipline — make the state file *compound*, not accumulate

The state file's "lessons learned" must be **verified rules, not a pile of guesses.** For anything the
loop gets wrong, climb this progression before moving on:

1. **Fail** — document the failure (what, where, the exact error/CI line).
2. **Investigate** — figure out *why* before proceeding; don't just note "maybe X?".
3. **Verify** — turn the diagnosis into a **checked fact** (a command/test confirms it).
4. **Distill** — rewrite it as a **general rule** ("PowerShell hits a TLS 1.2 issue on this runner —
   use bash"), not a one-off note.
5. **Consult** — on future runs, **read the rule instead of re-deriving it.**

Write distilled rules (not open guesses) to the state file so each cycle gets smarter, not just
longer. This is explicit, task-specific memory instruction — don't assume the model does it unprompted;
weaker models stall at step 1 (a list of guesses they never consult). Rules follow the same honesty
bar as everything else: a rule is only "distilled" once it's **verified**, and it carries its evidence.

## Never do (hard constraints)

- **Never autonomously touch or loop** authentication, payments/billing, pricing/margin, agent-
  autonomy/governance code, architecture, or production — **escalate to a human** (this is the HITL
  boundary, `docs/HITL-POLICY.md` / `CLAUDE.md` §3, and the "never looped" list in
  `docs/design/build-automation.md` §1a).
- **Never disable or delete a failing test** to make a gate pass — file it as an escalation instead.
- **Never modify CI/CD config, permissions, or secrets** without human approval.
- **Never dispatch an item without an objective acceptance criterion**, and never mark an item `done`
  on a maker's say-so — only on the objective gate (build-automation §1).
- **Never fabricate a finding** — every item cites the CI line / file / eval that produced it.
