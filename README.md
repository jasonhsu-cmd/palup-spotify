# PalUp.ai — Claude Code Project Scaffold

Reusable Claude Code artifacts + system design for **PalUp.ai**, an agentic AI SaaS platform
that gives Shopify merchants a 24/7 AI sales partner, gives PalUp its own growth agent, and
runs a self-healing monitoring plane — all under a governance framework that fixes
OpenClaw's missing HITL/evolution controls.

This repo is the **operating layer** a team drops into the codebase: it tells Claude Code
how to build PalUp safely and captures the design decisions and their justifications. The
application packages (`packages/…`) are scaffolded by these artifacts, not shipped here.

## Start here
- **`CLAUDE.md`** — the operating manual, loaded every session. The non-negotiable rules and
  the two-agent-plane distinction live here. Read it first.
- **`docs/ARCHITECTURE.md`** — the system design, technology choices, and trade-off analysis.
- **`docs/AGENT-GOVERNANCE.md`** — the gated self-improvement pipeline (the OpenClaw answer).
- **`docs/HITL-POLICY.md`** — the exact boundary of what always needs a human.
- **`docs/STICKINESS.md`** — how PalUp earns durable, healthy user stickiness (and the
  guardrails that stop it becoming manipulative).
- **`docs/MOAT.md`** — an honest, dynamic view of defensibility (flywheel, not a wall);
  backs the admin console's moat metric.
- **`docs/GTM.md`** — the go-to-market strategy (trust-sequenced, recursive engine);
  backs the admin console's growth section.
- **`docs/PRICING.md`** — pricing & packaging strategy (margin-aware, value-based
  land-and-expand) derived from the SWOT, moat, and GTM.
- **`docs/SECURITY.md`** — security architecture & enterprise readiness (agentic threats +
  standard controls + compliance roadmap); backs the console's security section.
- **`docs/DESIGN-SYSTEM.md`** — the shared token system (identical across both consoles).
- **`docs/design/`** — the **buildable backend design** (data model, ports, runtime, governance
  subsystems, attribution/billing, cost/margin, integrations, security, API contracts) plus the
  **UI→backend coverage matrix**, **capacity model**, and the **go/no-go** review
  (`docs/design/README.md`). Produced as the pre-development review of whether the backend supports
  every UI detail and scales to millions of merchants.
- **`docs/adr/`** — the load-bearing decisions, recorded as ADRs (0001–0003 strategic; 0004–0011
  the scale/runtime/eventing/attribution/billing/vector/capacity/auth decisions).

## What's in `.claude/`
| Path | Purpose |
|---|---|
| `agents/` | Build-time subagents: orchestrator, solution-architect, backend/frontend builders, test-engineer, security-reviewer, release-manager, agent-evolution-steward, fact-checker (verifies claims before commits/summaries). |
| `skills/palup-design-system/` | Tokens + Tailwind mapping + component vocabulary for UI work. |
| `skills/hitl-approval-gate/` | Checklist + code pattern for routing boundary-crossing actions to the Approval Center. |
| `skills/portability-guard/` | Enforces the ports-and-adapters portability rule (ADR-0001). |
| `skills/triage/` | Loop heartbeat: discovers build-time work (CI/coverage/evals/alerts) and writes it to a durable state file so the autonomous loop is resumable. |
| `commands/` | `/ship`, `/eval`, `/governance-check`, `/new-runtime-agent`. |
| `settings.json` + `hooks/` | Permissions (least-privilege, no ungated prod deploy) + an advisory governance pre-check hook. |
| `../.mcp.json` | Project-scoped MCP servers (GitHub + a template for PalUp's control-plane server). |

## Everyday use
- Build a feature: `/ship <what you want>` — runs architect → builders → tests → security →
  (steward if it changes a run-time agent) → progressive release.
- Add a product agent: `/new-runtime-agent <name and purpose>` — scaffolds a governed config
  bundle on the shared runtime.
- Before merging anything governance-sensitive: `/governance-check <paths>`.
- Gate an agent candidate: `/eval <candidate>`.

## The visual source of truth
`palup-merchant-app.html` and `palup-admin-console.html` (repo root) are the mockups the real
consoles must match. Their design tokens are captured in the design-system skill.

## Two things worth flagging honestly
1. **"Self-improving, 24/7 auto-deploy to production" is deliberately constrained here.**
   Unsupervised self-deploying agents are the exact OpenClaw failure mode. In this design
   agents self-*improve* continuously but self-*deploy* never — promotion of any behavior
   change, and anything touching money/model/business-model, requires a human. That is the
   trade-off, and it is intentional.
2. **The named open-source repos are candidates, not guarantees.** Evaluate license,
   quality, and security for each (`wshobson/agents`, `obra/superpowers`,
   `msitarzewski/agency-agents`, `addyosmani/agent-skills`, `superdesigndev/superdesign`,
   `shadcn-ui/ui`) at integration time, pin versions, and wrap them behind PalUp's own ports
   and policies before granting any autonomy.
