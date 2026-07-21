# Backend Design & Scale Review — Findings and Go/No-Go

This folder is the **buildable backend design** for PalUp.ai, produced as a pre-development review
answering two questions from the finalized UI/UX:

1. **Does the backend design support every detail of the UI/UX?**
2. **Can it scale to millions of merchants, each with tens of thousands of customers?**

## What this review found

- **Before this phase:** PalUp had excellent architecture *principles* (three planes, one shared
  agent runtime, ports & adapters, governance-as-backbone, model tiering — ADR-0001/0002/0003) but
  **no buildable backend design and no code** (`packages/` did not exist). The only concrete infra
  choice named in the mockups — a single Cloud SQL Postgres — cannot hold the target scale.
- **This phase produced** the missing design layer: 4 new ADRs + 11 design specs, each traceable to
  the UI inventory and stress-tested against the scale target.

## The documents

| # | Document | Answers |
|---|---|---|
| ADR-0004 | `../adr/0004-storage-tier-at-scale.md` | How storage scales while staying portable |
| ADR-0005 | `../adr/0005-agent-runtime-execution-model.md` | How "24/7 agents" run for millions of tenants |
| ADR-0006 | `../adr/0006-eventing-and-realtime.md` | How live UI + triggers + monitoring are fed |
| ADR-0007 | `../adr/0007-attribution-and-metering.md` | How the outcome fee + credit metering work |
| 1 | `data-model-and-tenancy.md` | Entities behind every screen; isolation; large-table strategy |
| 2 | `port-interfaces.md` | The 9 portable ports + contract tests |
| 3 | `capacity-model.md` | The numbers; bottlenecks; residual empirical risks |
| 4 | `agent-runtime.md` | The traced run loop, budgets, HITL-in-hot-path, kill switch |
| 5 | `governance-subsystems.md` | Policy → Rules → Approvals; Evolution; Eval; Audit |
| 6 | `attribution-and-billing.md` | Incrementality fee basis; metering; Shopify Billing |
| 7 | `cost-margin-telemetry.md` | Per-tenant COGS, circuit-breaker, margin floor |
| 8 | `integration-architecture.md` | Shopify + ~15 integrations behind ports |
| 9 | `security-data-path.md` | Injection, tenant isolation, DLP, residency, controls |
| 10 | `console-api-contracts.md` | Merchant + admin API, RBAC, pagination, proposals |
| 11 | `ui-backend-coverage-matrix.md` | Every screen ↔ backend; **zero unmapped** |

## Answer to the two questions

1. **Supports every UI detail: YES, by design.** `ui-backend-coverage-matrix.md` maps every screen
   and every load-bearing behavior (live counters, approve-to-rule, bounded adjusters, expiry
   semantics, two-person/step-up, basic-mode-at-cap, k≥50 benchmarks, hash-chained audit, forensic
   run lookup) to a named entity, endpoint, event source, and spec — with zero gaps.
2. **Scales to millions × tens-of-thousands: YES on paper, WITH conditions.** ADR-0004/0005/0006
   give a design that holds the storage and agency volumes (`capacity-model.md`), and the margin
   holds **if** the model-tier mix (~95/4/1) and per-action cost (~$0.011) hold at fleet scale.

## Go / no-go for automated development

**Recommendation: GO to automated development, conditionally** — the design is complete and
consistent enough for the builder agents to implement against without improvising load-bearing
decisions. The following are **conditions to validate early in the build**, not design gaps (a
validating load-test/PoC was deliberately out of scope for this doc-only phase):

- [ ] **Empirical scale constants** (`capacity-model.md` §6): real req/s and its linearity;
      per-action cost and the 95/4/1 tier mix on real traffic (cost eval gate live); vector-store
      economics at 10^9–10^10 vectors; distributed-Postgres rebalancing/restore (RTO/RPO).
- [ ] **Storage engine selection** among the ADR-0004 candidates, passing the `storage` contract
      tests.
- [x] **Build-time reviewer sign-offs — completed.** Both ran against the specs; each raised **one
      blocking finding**, now **fixed**:
      - `agent-evolution-steward` → BLOCK: "pure-quality → auto-promote" let a behavior change skip
        human promotion. **Fixed** (governance §4): auto-promote is now permitted *only* for
        non-output-affecting changes; any behavior/prompt/model change always takes human approve;
        change class is governance-assigned (defaults up); frozen candidates need human clearance +
        cooldown to re-enter. Plus should-fixes on threshold/holdout edit control.
      - `security-reviewer` → BLOCK: PII-redaction-before-inference had no enforcement point.
        **Fixed** (security §3, `port-interfaces` model): enforced at the `model` port boundary as an
        invariant + contract test. Plus should-fixes applied: constrained/audited admin cross-tenant
        read path, `storage` fail-closed on missing tenant ctx, durable (transactional-outbox) audit
        write, enumerated erasure cascade, step-up+audit on bulk PII export, Shopify token revocation
        on uninstall, non-self-mutable agent bundle, tenant-scoped queue handlers.
- [ ] **Residual — human security sign-off** to formally close the two items on the reviewer's
      mandated block list (cross-tenant isolation incl. the admin read path; PII-before-inference),
      required before governance-sensitive code merges. The design now specifies both; a named human
      must accept them.

## How to proceed

Build risk-first, behind flags, via the standard loop (`/ship`): start with the ports + data model +
runtime skeleton (the governance invariants in `agent-runtime.md` §4/§6 and `governance-subsystems.md`
§8 must be true from the first vertical slice), validate the empirical constants above on the
cart-recovery wedge, then expand screen-group by screen-group against the coverage matrix. Every
governance-touching PR runs `/governance-check` and names a human owner.
