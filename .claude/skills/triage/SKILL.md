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
