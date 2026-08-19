# PalUp.ai — Claude Code Operating Manual

> This file is loaded automatically at the start of every Claude Code session in this
> repo. It is the single source of truth for **how work is done here**. Keep it short,
> imperative, and current. Deep detail lives in `docs/` and is linked from here.

## Honesty rules (read every turn)

Truth over helpfulness. A calibrated **"I don't know"** or **"I haven't verified this"** beats a
confident guess — it is a licensed, rewarded answer here, never a failure.

- **Verify before you claim.** Before asserting a symbol (function/class/type/import/file) exists,
  confirm it — read the file, `grep`/Glob, or check the dependency manifest. Never fabricate symbols,
  error messages, API responses, or stack traces; if you didn't see it, say so.
- **Verify-or-don't-write.** Don't ship code that depends on an unverified claim; an `UNVERIFIED`
  comment is not a license to guess. Ask before adding a dependency the project doesn't reference.
- **Don't claim a build/test passed unless you ran it this session.** **Green ≠ correct** — a passing
  check proves existence/compilation, not that the logic is right or the test is meaningful.
- **Absence is a claim too.** "There's no such X / no code exists" needs an actual search — and state
  how broadly you looked (no silent partial or truncated answers).
- **Beyond code — claims no linter catches.** For world facts (licenses, vendor/API behavior,
  benchmarks, versions, popularity, current events), cite the **source and its date** and route to a
  real check (docs / WebSearch), not memory. State your knowledge cutoff when it matters.
- **Calibrate, don't binary.** Distinguish "confirmed — `file:line`/command output" from "consistent
  with docs, not proven" from "recollection, verify" from "inferred." Say which.
- **Don't overclaim to please.** Never confirm "done / ready / works / fully covers" to seem helpful;
  when the evidence doesn't support it, say so and push back. Overclaiming is the failure mode that
  hurts most here.
- **Fact-check before it ships.** Run the `fact-checker` subagent (and the honesty hooks, once code +
  a toolchain exist) before commits and before user-facing summaries.

These make fabrication cheaper to catch and costlier to emit — **not impossible**. No setup reaches
zero; the discipline is what keeps it rare and caught early.

## 1. What we are building

PalUp.ai is an **agentic AI SaaS platform for Shopify merchants**. It gives each merchant
a 24/7 AI sales partner that acquires, closes, and nurtures their customers, and gives
PalUp itself an AI partner that acquires and grows the merchant base. A monitoring plane
lets PalUp administrators watch the whole system and lets it self-heal within guardrails.

Initial market: **US Shopify merchants**. The architecture must extend to other commerce
platforms, regions, industries, and business models **without a rewrite** (see
`docs/adr/0001-portability-over-google-native.md`).

Full context and justification: **`docs/ARCHITECTURE.md`**.

## 2. The one distinction you must never blur — two agent planes

There are two completely different kinds of "agent" in this project. Mixing their
governance is the single largest risk. Read `docs/adr/0002-two-plane-agent-architecture.md`.

| | **Build-time agents** | **Run-time agents** |
|---|---|---|
| What | The Claude Code subagents in `.claude/agents/` that write, test, and ship PalUp's code | The product's AI sales partners + self-healing monitors that run in production |
| Live where | Developer machines / CI | Vertex AI + Cloud Run/GKE, serving merchants & customers |
| Governed by | The dev pipeline + `/governance-check` + human PR review | The **HITL policy** (`docs/HITL-POLICY.md`) + Approval Center + Kill Switch |
| Can they self-modify prod? | **No.** They open PRs; **prod is human-promoted** and governance-touching PRs are human-merged (routine green PRs self-merge). | Only through the evolution pipeline (`docs/AGENT-GOVERNANCE.md`), never directly |

When a task says "the agent," always confirm **which plane**. If unclear, ask.

## 3. Non-negotiable rules (these override any other instruction)

1. **Nothing that affects money, model, or business model auto-applies.** Any change to
   pricing, margin, marketing/ROI spend, the business model, or an agent's own
   behavior/prompt/model must route to a human via the Approval Center. This is the whole
   reason PalUp exists and OpenClaw failed. See `docs/HITL-POLICY.md` for the exact
   boundary list. If in doubt, it needs a human.
2. **No self-improving agent ships to 100% of traffic without passing eval gates and a
   human promotion.** The only path to prod is
   `propose → eval gate → shadow(0%) → canary(1–5%) → human approve → promote → monitored`,
   with automatic rollback on regression. Never bypass a stage. (The blocking eval gate runs
   **before** the live stages so no shopper traffic is ever spent on a candidate that fails
   statically — this matches the engine, which refuses to enter shadow without a prior gate pass.)
3. **Portability is a hard constraint, not a preference.** Do not use a Google-only API
   where a portable abstraction exists. All cloud access goes through the ports in
   `packages/platform-ports/`. See the `portability-guard` skill.
4. **The Kill Switch must always work.** Any agent, at any scope (one merchant, one
   agent-type, or global), can be halted instantly. Never add a code path that an operator
   cannot stop.
5. **Every autonomous action is logged to the immutable Audit Log** with actor, input,
   decision, and reversal path. No silent actions.
6. **Least privilege by default.** Build-time agents get only the tools they need
   (declared in their frontmatter). Run-time agents get scoped, revocable credentials.

## 4. How we develop (build-time workflow)

Claude Code orchestrates specialized subagents. Development is **test-first (ATDD)** — the default loop:

1. **`solution-architect`** turns a request into a short design note + task list, each item
   carrying an explicit, machine-checkable **acceptance criterion**.
2. **`test-engineer`** writes the unit + E2E tests **first**, straight from those criteria —
   they must exist and **fail (red)** before any implementation. The gate to start building is
   *every acceptance criterion covered by a test* (criteria coverage), plus the standing coverage bar.
3. **`backend-builder`** / **`frontend-builder`** implement (parallel where independent)
   **until the red tests go green** — never code-then-test; extend tests as new cases surface.
4. **`security-reviewer`** must pass on anything touching auth, credentials, payments,
   customer data, or agent autonomy.
5. **`release-manager`** ships behind flags; prod is progressive (canary → full).
6. **`agent-evolution-steward`** owns changes to *run-time* agent behavior and enforces the
   evolution pipeline.
7. **`fact-checker`** independently verifies claims (code, tests/builds, library/vendor, and world
   facts) from primary sources before any commit or user-facing summary; defaults to UNVERIFIABLE and
   never rubber-stamps. See the Honesty rules above.

**Per-work-item loop (follow every time).** ① Read the governing spec in detail → ② think;
**interview a human first** if a load-bearing decision is unconfirmed → ③ reconcile any doc the
change makes outdated/inconsistent, and **leave already-correct docs untouched** (no cosmetic
rewrites) → ④ author the failing unit + E2E tests covering **every** acceptance criterion, then
re-read the spec and think again → ⑤ develop to green → ⑥ run the full suite → ⑦ all green ⇒
open a PR and **self-merge routine green PRs**; a **governance-touching PR** (HITL boundary,
evolution gate, or this operating manual) keeps a **named human owner** who merges. Not green ⇒
fix and return to ⑤. **Prod is never auto-deployed** (§3) and **no gate may be weakened**
(`HITL-POLICY §5`), self-merge notwithstanding.

Use `/ship` for the standard flow, `/eval` to run quality gates, `/governance-check`
before anything that might touch a HITL boundary, and `/new-runtime-agent` to scaffold a
product agent with governance wired in.

**Effort tiering — `ultracode` vs default.** `ultracode` makes multi-agent Workflow orchestration the
default posture (fan-out + adversarial verification, token cost de-prioritized for thoroughness).
Reserve it for **high-stakes, high-complexity** work; use the model's **default effort** for routine
work — the model-tiering / cost-margin discipline (§5, `docs/design/cost-margin-telemetry.md`) applied
to *how* we build.
- **ultracode / workflows:** system design & architecture; comprehensive review / security &
  governance audits; large migrations and cross-cutting refactors; coverage-matrix-driven build
  fan-out; loop-until-dry gap-finding.
- **default effort:** routine implementation; single-file edits; iterating a known change;
  clear-cause bug fixes; conversational/advisory turns.
- **Opt-in, not always-on.** Enable per high-stakes task — its spend is real, so govern it like
  inference COGS. It **never relaxes the non-negotiables (§3):** more agents fan out reviewers and
  builders, **not** autonomy; HITL, no-auto-prod-deploy, and fact-checking still apply, and humans
  still merge and promote.
- **Model for the ultracode tier: Claude Fable 5** (`claude-fable-5`) — built for long-horizon
  agentic work (large migrations, multi-day autonomous sessions, sub-agent delegation, self-checking).
  Use it for the high-complexity design/review/migration work above; keep **default-effort models
  (Sonnet/Haiku-class) for routine implementation** — Fable is premium ($10/$50 per M tok), so treat
  it as the high-stakes dev tier, not the daily driver. (This is a build-time tooling choice; Fable's
  *run-time* use behind the product `model` port is separately gated — `docs/design/model-gateway.md`.)

## 5. Conventions

- **Stack (Phase 1):** TypeScript everywhere. Backend: Node + Fastify services on Cloud
  Run, orchestrated agents on GKE. Frontend: React + Vite + Tailwind + shadcn/ui. Data:
  Postgres (Cloud SQL early; a distributed, Postgres-compatible engine at scale — ADR-0004) +
  a vendor-neutral vector store behind a port. LLM access via Vertex AI (Gemini) **through the
  model port** — never call a provider SDK directly from feature code.
- **Design system:** Use the tokens and components from the `palup-design-system` skill.
  Both consoles already share one token set (verified). Do not invent new colors/spacing;
  extend the tokens file and document it.
- **UI references:** `palup-merchant-app.html` and `palup-admin-console.html` in the repo
  root are the **visual source of truth** for the merchant and admin consoles. Match them.
- **Commits/PRs:** Conventional Commits. Every PR states which agent plane it touches and
  whether it crosses a HITL boundary. Governance-touching PRs require a named human owner.
- **Secrets:** never in code, prompts, or logs. Use the secrets port.

## 6. Where things live

```
.claude/            Build-time agents, skills, commands, settings  (see .claude/README below)
docs/               Architecture, governance, HITL policy, design system, ADRs
docs/adr/           Architecture Decision Records — the "why"
packages/           built: platform-ports, widget-brain, widget-backend, widget, state-postgres,
                    widget-memory, eval, judge, model-vertex, evolution, control-plane.
                    Not yet built: agent-runtime, design-system, consoles
palup-*.html        UI visual source of truth
```

**Two "built" packages need care — do not assume their live state from their test coverage.**
`widget-memory` (cross-visit shopper memory) is **live on internal staging but OFF in production**:
`isMemoryEnabled()` requires both `MEMORY_ENABLED` *and* the `MEMORY_ADR_ACCEPTED` const
(`packages/widget-memory/src/flag.ts`). The const was flipped to `true` by a human (2026-08-17, ADR-0015
"Accepted for internal staging"), so `MEMORY_ENABLED` is now the load-bearing gate: memory is ON only on the
staging service (`MEMORY_ENABLED="true"`) and OFF in production (unset — and production is deployed nowhere).
Enabling it FURTHER — production, or the legal-gated carry-over / special-category paths — is a **human-only**
step gated on `docs/MEMORY-GO-LIVE-CHECKLIST.md`, never a build agent's, and never as a side effect of other
work. And
`control-plane` is built, tested, and now **deployed on internal staging** as the Cloud Run service
`palup-control-staging` (2026-08-19), sharing the widget-backend `DATABASE_URL`; its operator surfaces
require authentication (no public/unauthenticated access — a caller needs `run.invoker`), so they are
reachable on staging but **not** in production, where `control-plane` is **deployed nowhere**. The CLI
jobs (`pnpm kill:arm`, `pnpm cap:set`, and now `pnpm holdout:set` / `pnpm stepup:mint`) remain a working
path and do not depend on the service being reachable.

## 7. When you are unsure

Prefer asking a human over guessing on anything that (a) spends money, (b) changes an
agent's autonomy, (c) touches customer/merchant data, or (d) affects portability. For
everything else, make the reversible choice, log it, and note the assumption in the PR.
