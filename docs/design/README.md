# Backend Design & Scale Review — Findings and Go/No-Go

This folder is the **buildable backend design** for PalUp.ai, produced as a pre-development review
answering, for the finalized UI/UX:

1. **Does the backend design support every detail of the UI/UX?**
2. **Can it scale to millions of merchants, each with tens of thousands of customers?**
3. **Is each major service domain fully planned** (payments, email/SMS, ads/social, LLM/DB/infra,
   cost)?

## What this review found

- **Before this phase:** PalUp had excellent architecture *principles* (three planes, one shared
  agent runtime, ports & adapters, governance-as-backbone, model tiering — ADR-0001/0002/0003) but
  **no buildable backend design and no code** (`packages/` did not exist). The only concrete infra
  choice named in the mockups — a single Cloud SQL Postgres — cannot hold the target scale.
- **This phase produced** the missing design layer: **8 new ADRs (0004–0011) + ~20 design specs**,
  each traceable to the UI inventory, stress-tested against the scale target, and **independently
  security-reviewed** (see the sign-off ledger below), plus an **OSS licensing policy** with an
  enforcing CI gate (`oss-and-licensing.md`).

## The documents

**Load-bearing decisions (ADRs)**

| ADR | Decision |
|---|---|
| 0004 | Storage tier at scale — portable distributed Postgres, tenant-sharded |
| 0005 | Agent-runtime execution model — event-driven, not process-per-merchant |
| 0006 | Eventing & real-time delivery |
| 0007 | Attribution & metering as the billing basis |
| 0008 | Billing settlement via Shopify Billing primitives (no funds held) |
| 0009 | Vector store at scale (engine choice behind the port) |
| 0010 | Capacity-commitment strategy (committed-use/reserved/spot, governed) |
| 0011 | Merchant-auth model — Shopify-embedded, portable behind an `identity` port |

**Core platform specs**

| Document | Covers |
|---|---|
| `data-model-and-tenancy.md` | Entities behind every screen; isolation; large-table strategy; erasure cascade |
| `port-interfaces.md` | The 9 core ports + marketing-plane ports (`ads`/`social`/`tracking`) + contract tests |
| `capacity-model.md` | The numbers; bottlenecks; residual empirical risks |
| `agent-runtime.md` | Traced run loop, budgets, HITL-in-hot-path, 3-scope kill switch |
| `governance-subsystems.md` | Policy → Rules → Approvals; Evolution; Eval; Audit; media eval gate |
| `security-data-path.md` | Injection, tenant isolation, DLP, residency, model supply-chain |
| `identity-and-access.md` | AuthN service, authZ PDP (RBAC+ABAC), SSO/SCIM, passkey/step-up, API keys, break-glass, lifecycle |
| `oss-and-licensing.md` | License allowlist policy, candidate register (flags Cockroach/Redis/Grafana/Sentry/Citus), SBOM + license-scan CI gate |
| `../legal/provisions-brief.md` | Terms/DPA/privacy/AUP/SLA provisions brief for counsel (not legal advice) — grounded in the design |
| `build-automation.md` | Continuous build-time agent orchestration (develop→test→fix→PR→CI→staging; human merge/promote gates); OSS vet-then-adopt workflow |
| `console-api-contracts.md` | Merchant + admin API, RBAC, pagination, proposals |
| `ui-backend-coverage-matrix.md` | Every screen + payments/comms/ads/platform/cost ↔ backend; **zero unmapped** |

**Money path**

| Document | Covers |
|---|---|
| `attribution-and-billing.md` | Incrementality fee basis; credit metering |
| `payments-and-billing.md` | Billing lifecycle, reconciliation, dunning, adjustments, money tools, tax |
| `cost-margin-telemetry.md` | Per-tenant COGS, circuit-breaker, margin floor |
| `cost-optimization.md` | Operating-cost levers (commitments/spot/egress/right-size/tiering/media) + continuous FinOps loop |

**Integrations & channels**

| Document | Covers |
|---|---|
| `integration-architecture.md` | Shopify + ~15 integrations behind ports |
| `comms-and-messaging.md` | Email/SMS/chat: send gate, deliverability, inbound, consent/suppression, A2P, live chat |
| `advertising-and-social.md` | Ads (Meta/Google/TikTok/LinkedIn) + pacing, creative + media eval gate, Ayrshare, conversion tracking, SEO/AEO |

**Infrastructure**

| Document | Covers |
|---|---|
| `model-gateway.md` | LLM serving: routing, cache tiers, failover, self-trained serving, embeddings |
| `data-platform.md` | DB ops, backup/restore/RTO-RPO, replicas, vector tier, cache, OLAP mirror |
| `compute-and-delivery.md` | Service topology, autoscaling, scheduler, networking, CI/CD, IaC, environments |
| `observability-and-sre.md` | SLO/alerting/tracing, monitoring ingestion, DR, eval/training GPU infra |

## Answers

1. **Supports every UI detail: YES, by design.** `ui-backend-coverage-matrix.md` maps every screen
   and every load-bearing behavior — plus the payments, comms, ads/social, platform, and cost
   sub-matrices — to a named entity, endpoint, event source, and spec, with **zero unmapped
   surfaces**.
2. **Scales to millions × tens-of-thousands: YES on paper, WITH conditions.** ADR-0004/0005/0006/0009
   hold the storage and agency volumes (`capacity-model.md`); the margin holds **if** the tier mix
   (~95/4/1) and per-action cost (~$0.011) hold at fleet scale.
3. **Each domain fully planned: YES at design depth, each security-reviewed.** Not "fully optimized"
   for cost — that is an empirical operating result, not a design claim (see cost caveat below).

## Reviewer sign-off ledger

Every domain was reviewed by the relevant build-time subagent; each **blocking** finding was fixed.

| Review | Verdict (initial) | Result |
|---|---|---|
| Core design — `agent-evolution-steward` | BLOCK (1) | **Fixed** — auto-promote fenced to non-behavioral only; class governance-assigned; frozen-candidate cooldown |
| Core design — `security-reviewer` | BLOCK (1) | **Fixed** — PII-redaction-before-inference enforced at `model` port; + admin cross-tenant path, storage fail-closed, durable audit, erasure cascade, export step-up |
| Payments money-path — `security-reviewer` | SIGN OFF w/ conditions | **Fixed** — aggregate money ceiling, separation-of-duties on money-out, non-auto-cleared reconciliation exceptions |
| Messaging — `security-reviewer` | BLOCK (2) | **Fixed** — approval attestation at the comms floor; verified + signed-token inbound tenant attribution; consent tamper-resistance |
| Ads/social — `security-reviewer` | BLOCK (1) | **Fixed** — platform-native hard-cap backstop for pacing; `tracking` port fail-closed; exact rule/HITL spend line; least-priv social tokens |
| Platform — `security-reviewer` | SIGN OFF w/ conditions | **Fixed** — strong-consistency authz/revocation reads; training-scope binds serving-scope; cache poisoning/encryption |
| Cost governance — `security-reviewer` | SIGN OFF w/ conditions (1 blocking) | **Fixed** — safety-infra fenced from cost cuts; quality eval gates infra levers; cost anomalies triaged vs SOC |
| Identity & access — `security-reviewer` | SIGN OFF w/ conditions (2 blocking) | **Fixed** — Shopify token validation + tenant-bind-from-verified-claims; API-key scope = min(key, current grantor); IdP-group ceiling; embedded CSP/replay; operator recovery; session-store fail-closed |

## Go / no-go for automated development

**Recommendation: GO to automated development, conditionally.** The design is complete, internally
consistent, and reviewed across all domains; builders can implement against it without improvising
load-bearing decisions. Remaining items are **build-time conditions, not design gaps** (a validating
load-test/PoC was deliberately out of scope for this doc-only phase):

- [ ] **Empirical constants** (`capacity-model.md` §6) — validate on real traffic: req/s and its
      linearity; per-action cost and the 95/4/1 tier mix (cost eval gate live); vector-store economics
      at 10⁹–10¹⁰ vectors; distributed-Postgres restore times (RTO/RPO); cache hit rates (40/22/71);
      commitment utilization. **These are what "optimized" and "scales" ultimately rest on.**
- [ ] **Engine selections** — the `storage` engine (ADR-0004 candidates) and the dedicated `vector`
      engine (ADR-0009), each passing its port contract test **and its license check** (prefer the
      Allow-tier picks: YugabyteDB, Valkey/Memcached — `oss-and-licensing.md`).
- [ ] **OSS license clearance** — no per-dependency verification is possible until the dependency
      tree exists; the SBOM + license-scan CI gate (`oss-and-licensing.md`) must be live from the
      first build, and any Flag-tier component (CockroachDB / Redis / Grafana / Sentry / Citus) needs
      legal + `security-reviewer` sign-off before it ships.
- [ ] **Legal instruments (not started)** — no Terms/DPA/privacy/AUP/SLA exist; `../legal/provisions-
      brief.md` is a **counsel brief, not drafted agreements**. Qualified counsel must draft/review
      them, reconciled against the design ↔ contract consistency watch-list, before commercial launch
      and Shopify App Store submission. Owner: the Compliance/Legal operator role.
- [x] **All build-time reviewer sign-offs completed** — see the ledger above; every blocking finding
      fixed in the specs.
- [ ] **Named human sign-offs before governance-sensitive code merges** (design specifies all of
      these; a person must accept them):
      - **Security team** — cross-tenant isolation (incl. admin read path) + PII-before-inference
        (core review block list); plus Shopify session-token validation/tenant-binding and API-key
        scope-on-role-downgrade (IAM review block list).
      - **Security team (gate-weakening class, HITL §5)** — any future cost change that would reduce
        eval / audit / SOC / redaction / guardrail / kill-switch coverage.
      - **Named owners** — money/authority/pricing changes (two-person + step-up): fee-model,
        margin-floor, commitments, money-tool grants, ad-platform connections.

## Cost caveat (re: "fully optimized")

Cost is a first-class, governed, metered concern with a continuous FinOps loop and the full lever set
(`cost-optimization.md`, ADR-0010). But **"fully optimized" is not a design claim** — it is an
empirical result earned on real traffic. The design provides the machinery; the numbers that prove
minimal cost are the empirical constants above.

## How to proceed

Build risk-first, behind flags, via the standard loop (`/ship`): start with the ports + data model +
runtime skeleton (the governance invariants in `agent-runtime.md` §4/§6 and `governance-subsystems.md`
§8 must be true from the first vertical slice), validate the empirical constants on the cart-recovery
wedge, then expand screen-group by screen-group against the coverage matrix. Every governance-touching
PR runs `/governance-check` and names a human owner.
