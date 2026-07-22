# Design Spec — Autonomous Build Automation (build-time orchestration)

_How Claude Code orchestrates the `.claude/` **build-time** subagents to develop, test, fix, and ship
PalUp continuously — within the governance rules. This is the **build-time plane** (ADR-0002); it
never becomes a run-time self-deploy path._

**Locked decisions (this session):**
1. **Auto-deploy to staging only; production is human-initiated.** Full automation runs up to a
   staging deploy; promotion to prod is a human action (progressive canary behind flags, auto-rollback).
2. **OSS frameworks are vet-then-adopt.** Backbone is the repo's own `.claude/` agents; external
   frameworks are evaluated, license/security-cleared, pinned, and wrapped behind ports before use,
   and never granted HITL-bypassing autonomy.

**Prime invariant (non-negotiable, `CLAUDE.md` §2/§3, ADR-0002/0003):** build-time agents **open PRs;
humans merge.** No agent path deploys to production. The loop below is maximal automation **up to the
human merge/promotion gate** — not around it.

## 1. The continuous loop

```
work-item → orchestrator dispatch
  → solution-architect (design note + task list; flags HITL/portability/plane)
  → backend-builder ∥ frontend-builder (parallel where independent)
  → test-engineer (unit/integration/port-contract/governance tests; coverage bar)
  → security-reviewer (blocks on auth/creds/payments/customer-data/autonomy/isolation)
  → /governance-check (HITL boundary + no-self-deploy + portability)
  → fact-checker (re-derive every claim from primary sources; UNVERIFIABLE by default)
  → OPEN PR (states plane touched + HITL crossing + named human owner)
  ─────────────── human merges ───────────────
  → CI: build + SAST/DAST + license-scan(oss-and-licensing) + SBOM + eval gate
  → AUTO-DEPLOY to STAGING (behind flags)
  ─────────────── human promotes ───────────────
  → progressive canary → full (release-manager) → monitor → auto-rollback on regression
```

- **agent-evolution-steward** additionally gates any change to **run-time** agent behavior (it must
  walk the evolution pipeline, `governance-subsystems.md` §4).
- The two human gates (merge, promote) are the only non-automated steps and are **required**.

**Every work-item is a `/goal`, not an open prompt.** Each item enters the loop with an **explicit,
machine-checkable acceptance criterion** (e.g. "port-contract tests for `storage` pass; coverage ≥ bar;
`/governance-check` clean") drawn from its coverage-matrix row + port contract test + the go/no-go
conditions. **"Done" is graded by a *different* agent** (`fact-checker` / `test-engineer`), never by
the builder that wrote the code — the maker-≠-checker split applied to the stop condition itself, and
the enforcement of the honesty rule "green ≠ correct." The criterion must be an **objective machine
gate** (test / build / type-check / lint → pass|fail), **not a second agent's opinion** — a verifier
that only has an opinion is two optimists agreeing, the "Ralph Wiggum" quiet-failure (the maker emits
"done" on a half-done job and the loop exits). The checker *interprets the gate*; it does not
substitute judgment for it. An item with no objective criterion is not started; it goes back to
`solution-architect` to get one. For richer items the criterion is a **rubric** — a small file of N
explicit checkable criteria (e.g. "contract tests pass **and** coverage ≥ bar **and**
`/governance-check` clean **and** no cross-tenant path **and** audit entry present") — and the
independent grader must confirm **every** criterion before the item may stop; the grader runs in a
**fresh context window**, not the maker's.

**Builders are spec-anchored — no guessing (kills "intent debt").** A builder prompt must **read the
governing spec + ADR + its coverage-matrix row before writing**, and is instructed **not to re-derive
or guess** intent the design already fixed. The design docs are the written-down intent the loop reads
every cycle; an agent that starts cold fills gaps with confident guesses unless pointed at the source.
The loop **rereads the governing spec + the `CLAUDE.md` §3 non-negotiables at the start of every
cycle** — long sessions silently drop "don't do X" constraints (goal drift; they vanish around turn
47), so session memory is never trusted to carry them.

## 1a. Loop-eligibility test — what may and may not be looped

Not every task earns a loop; the wrong ones cost more than they return. A task is loop-eligible **only
if all hold**: (1) it **recurs** (roughly weekly+), (2) an **objective automated gate** can reject bad
output, (3) the agent can **run the code it changes** (repro env), (4) there is a **hard stop**
(token/iteration/time budget), and (5) a **human reviews before any irreversible action** (merge,
deploy, dependency/permission change). Miss one → keep it a manual, human-driven task.

- **Loop-eligible (good first loops):** CI-failure triage, dependency-bump PRs, lint/type-fix passes,
  flaky-test reproduction, and coverage-matrix implementation on **well-tested slices with a real
  gate**.
- **Never looped (human-driven or full governed pipeline only):** **authentication, payments/billing,
  architecture, pricing/margin, production deploys, agent-autonomy/governance changes, and any task
  where "done" is a judgment call.** This list *is* the HITL boundary (`docs/HITL-POLICY.md`,
  `CLAUDE.md` §3) — the loop is confined to repetitive, machine-checkable work, never to money, model,
  autonomy, or design judgment.

## 2. How "24/7" is realized (without unattended prod risk)

- A **scheduler** (CronCreate / scheduled wakeups / background agents) wakes the orchestrator on a
  cadence and on events (CI result, new failing test, triaged bug, dependency alert).
- **Discovery/triage is a skill, and findings go to a durable state file (the loop's memory).** A
  scheduled run invokes the `triage` skill (`.claude/skills/triage/`) that reads CI failures, open
  coverage-matrix rows, failing evals, and dependency/security alerts, and writes findings + status to
  a **state file outside the conversation** (a markdown board / issue tracker). The agent forgets
  between runs; the repo doesn't — so tomorrow's run **picks up where today's stopped**, and no item
  is silently re-done or dropped. The state file is the spine; the conversation is disposable.
- **Work-item selection is risk-first** off the state file + `ui-backend-coverage-matrix.md` and the
  go/no-go conditions: ports + data model + runtime skeleton first, then the cart-recovery wedge, then
  screen-group by screen-group.
- **Parallel builders run in isolated worktrees** (`isolation: worktree`) so concurrent
  `backend-builder ∥ frontend-builder` work can't collide on files; each helper gets a fresh checkout
  that cleans itself up.
- Runs are **bounded, idempotent, and resumable** (mirrors the run-time budget discipline): a stuck or
  failing item parks in the state file with a diagnostic and does not block the queue.
- **Autonomous bug-fixing** is in-scope up to a PR: detect (CI/eval/monitor) → reproduce → fix →
  test → PR. It never hotfixes prod directly.
- **What runs unattended:** develop/test/fix/review/PR + CI + staging deploy. **What waits for a
  human:** PR merge and prod promotion. Overnight, work accumulates as green, staged PRs ready for
  morning review — not as prod changes.

## 2a. Memory model — three durable layers (don't conflate them)

The loop forgets between runs; persistence lives on disk in three distinct layers:

| Layer | Writer | Holds | Scope / sync |
|---|---|---|---|
| `CLAUDE.md` (+ `CLAUDE.local.md`) | you / team | **instructions** — how to work, the §3 non-negotiables | git-shared (`.local` = local) |
| `MEMORY.md` + topical files (`~/.claude/projects/<project>/memory/`) | Claude | **knowledge & lessons** — decisions, dead-ends, gotchas, and *why* | **local-only, per machine — NOT synced** |
| state file + `VISION.md` (in the repo) | the loop | **task state** (done/next/parked) + **standing spec** | git-shared |

Rules:
- **Team/CI durable memory is the committed state file / `VISION.md`, not `MEMORY.md`.** Auto-memory
  is per-developer-machine and does **not** travel to teammates or CI runners — so anything the loop or
  a teammate must rely on goes in the repo, not auto-memory.
- **Two-layer `MEMORY.md`:** keep it a short **index**; push detail to on-demand **topical files**
  (`debugging.md`, `design-conventions.md`) that load only when opened. Durable knowledge stays on
  disk, **off the live context window**, so session compaction doesn't lose it — it's *reloaded on
  demand*, not "compressed less."
- **Don't duplicate the repo.** Store only long-term knowledge **not derivable from `docs/`** — the
  ADRs/specs/go-no-go already hold this project's decisions. Good `MEMORY.md` content: recurring
  dead-ends, environment gotchas, and *why* a path was rejected.
- **Explain why, not just what** (reasoning outlives implementation) and **record dead-ends** so the
  loop doesn't re-walk them — the same `fail→investigate→verify→distill→consult` discipline as the
  `triage` skill's state file.
- **Curate:** small-high-signal beats large-noisy; review periodically; delete resolved/obsolete/
  duplicate entries.
- **Build-time ≠ run-time memory.** This layer is the *build* agents' memory. The *product's* run-time
  agent memory (per-tenant `agent_memory` + vector store) is a separate system — **ADR-0009** — never
  conflate them.

## 3. Reliability, accuracy, consistency controls

- **Every change passes all gates** (tests + coverage bar + security-reviewer + governance-check +
  eval) before a PR is even opened; red gates block, they don't warn.
- **Adversarial verification** on non-trivial changes (independent reviewer/tester agents that try to
  refute the change), and **contract tests per port** so adapters stay behavior-equivalent. This is
  the natural home for **`ultracode` / Workflow orchestration** (fan-out → adversarially-verify →
  synthesize) — reserved for high-stakes design/review/migration per the effort-tiering rule in
  `CLAUDE.md` §4; routine implementation stays on default effort.
- **Small, reversible diffs** (minimal-change discipline); every change flag-gated and auditable.
- **No-prod-self-deploy invariant** is asserted in CI and by `security-reviewer`/`release-manager`.
- **Determinism where possible:** pinned deps, pinned tool/agent versions, reproducible builds, SBOM.
- **Cost/rate discipline:** the orchestration itself is metered; a runaway loop trips a budget/step
  ceiling and parks (mirrors the run-time unbounded-consumption ceiling).
- **Loop health metric: cost per *accepted* change** (not tokens spent or PRs opened). If the
  accepted-change rate falls below ~50%, the loop is generating review work it was meant to remove —
  pause and fix the gate/skill, don't scale it. Ties to `cost-optimization.md`.
- **Build small, in order:** get one manual run reliable → capture it as a skill → wrap it in a loop →
  then schedule it. Don't schedule an unproven loop.

### 3a. Honesty layer (anti-hallucination), per `CLAUDE.md` "Honesty rules"

Deterministic external checks beat model self-discipline, so the loop pins claims to machine-checked
reality wherever it can:

- **Honesty hooks (deterministic).** `PostToolUse` runs a type-check/lint on the **changed package
  only** (not whole-project on every write — that's slow, noisy, and trains around it); the hard gate
  is a **`Stop`/pre-commit hook that runs the affected test + build suite** and returns real output to
  the session. This extends the existing `.claude/hooks/governance-precheck.js` pattern. **Activates
  once code + a toolchain exist (task #36)** — dead hooks that can't run are not wired in before then.
- **`fact-checker` in the loop.** Runs **before a PR opens and before any user-facing summary**;
  re-derives every claim (code, tests/builds, library/vendor, world facts) from primary sources,
  defaults to UNVERIFIABLE, and never rubber-stamps (independent of the writer's context).
- **Green ≠ correct.** A passing hook/test proves a symbol exists or code compiled — not that logic is
  right or a test is meaningful. A green check is evidence, not a license to claim "done"; vacuous/
  mocked tests are flagged, not counted.
- **Calibrated reporting.** Agents state verification status ("confirmed `file:line`" vs "unverified")
  and coverage limits (what was actually checked); no silent partial/ truncated results.
- Honest scope note: this makes fabrication cheaper to catch, **not zero** — the value is early,
  automatic catching, not a guarantee.

### 3b. Security tax (an unattended loop is an unattended attack surface)

A loop opens PRs faster than a human can read them, so the loop's own gate — not just merge CI — must
carry security checks:

- **Security in the loop gate:** SAST + dependency audit + **secret scanning** + license scan
  (`oss-and-licensing.md`) run before a PR opens, not only at merge. Insecure/secret-leaking code must
  fail the gate automatically.
- **Skills/plugins are injection vectors** — **audit the source of any skill/plugin before it's
  installed or auto-loaded** (a malicious description is prompt injection the loop would inherit). This
  is the OSS vet-then-adopt rule (§4) applied to skills, not just code deps.
- **No verbose logging in loops** — long unattended runs scatter secrets across logs no one watches;
  keep loop logging sanitized (secrets via the port only, never to logs — `security-data-path.md`).
- **Re-audit loop permissions every 30 days** — a read-only loop that got "just one" write scope for
  convenience, never re-checked, is scope creep; least-privilege is re-verified on a cadence.

## 4. OSS framework adoption workflow (vet-then-adopt)

For each candidate (`wshobson/agents`, `obra/superpowers`, `msitarzewski/agency-agents`,
`addyosmani/agent-skills`, `superdesigndev/superdesign`, or better alternatives found via
WebSearch/WebFetch):

1. **Evaluate** — fitness, quality, maintenance, popularity/rating (verified by actually searching,
   not assumed), and overlap with the built-in agents.
2. **License-clear** — against `oss-and-licensing.md`; Allow-tier auto-clears, Flag/Deny needs legal.
3. **Security-review** — `security-reviewer` audits the vendored code; no secrets/exfil/backdoor;
   pin the exact version; preserve attribution/NOTICE.
4. **Wrap** — behind PalUp's ports/policies; **never grant autonomy that bypasses HITL** or lets an
   external skill reach prod. (`ARCHITECTURE.md` §4.5)
5. **Adopt as a vendored building block** — recorded in the SBOM; upgrades re-trigger the gate.

The repo's own subagents/commands are the backbone and need no external dependency to start.

## 5. Prerequisites before the loop can actually run (honest blockers)

The harness is designed; it **cannot operate yet** until these exist (mostly human/infra setup):

- [ ] **Repo scaffolding** — monorepo (`packages/…`), TypeScript/build config, test runner, lint.
- [ ] **Git remote + CI/CD** — the pipeline (`compute-and-delivery.md` §5) with the gates wired.
- [ ] **A staging environment + cloud project + credentials** (via the `secrets` port) — there is no
      staging to auto-deploy to today.
- [ ] **Engine picks** — `storage` (ADR-0004 → prefer YugabyteDB) and `vector` (ADR-0009), license-cleared.
- [ ] **Human sign-offs already flagged** (`design/README.md`) — security (isolation/PII, Shopify
      token, API-key scope), legal (instruments + flagged OSS licenses).
- [ ] **Scheduler/runtime** for the 24/7 cadence (CronCreate/background agents) — armed only after the
      above, and only for the develop→staging portion.

## 6. Invariants (tests / `release-manager` + `security-reviewer`)

1. No build-time agent path deploys to production; prod requires human merge + human promotion.
2. No PR opens without green tests + coverage + security-review + governance-check + eval.
3. Run-time agent-behavior changes additionally walk the evolution pipeline (steward-gated).
4. Every adopted OSS component is license-cleared, security-reviewed, pinned, port-wrapped, and never
   HITL-bypassing.
5. The orchestration is metered; a runaway loop parks on a budget/step ceiling.
6. Every autonomous action (commit, PR, staging deploy) is audited with an actor + reversal path.
7. No PR opens or summary ships without a `fact-checker` pass; claims of "tests/build passed" require
   the command to have actually run this session (green ≠ correct); no completeness claim without
   stated coverage.

## 7. Honest bottom line

This gives you **maximal, continuous automation — develop, test, fix, review, PR, and deploy-to-
staging — with two human gates (merge, promote) that your own governance requires and that separate
PalUp from OpenClaw.** "Flawless end-to-end, human-out-of-the-loop-to-prod" is intentionally **not**
built: it violates `CLAUDE.md` §2/§3 and is the failure mode the product exists to prevent. The loop
can turn on once §5's prerequisites are in place; the natural first work-item is bootstrapping
`packages/` and the first vertical slice (cart-recovery wedge), which the agents deliver as the first
reviewable PR.
