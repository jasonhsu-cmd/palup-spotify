# PalUp.ai — System Architecture

_Status: living document. Decisions with lasting consequences are captured as ADRs in
`docs/adr/` and summarized here._

## 1. Goals and the forces that shape the design

PalUp must simultaneously satisfy several pressures that pull in different directions.
Naming them up front makes the trade-offs below legible.

- **Business ambition:** millions of merchants, hundreds of millions of end customers, a
  public-company-grade reliability and margin story. → favors horizontal scale, strong
  observability, and cost control as a first-class concern.
- **Two-sided agentic product:** agents act on behalf of merchants *and* on behalf of
  PalUp, 24/7. → favors a shared, well-governed agent runtime rather than bespoke code.
- **Self-improvement without the OpenClaw failure mode:** agents should get better on their
  own, but never mutate production behavior unsupervised. → governance is the backbone, not
  a bolt-on (see §5 and `docs/AGENT-GOVERNANCE.md`).
- **Portability:** currently on Google Cloud (Vertex AI, Gemini, Cloud Run, GKE) but must
  avoid lock-in and stay portable across clouds, commerce platforms, regions, and business
  models. → everything vendor-specific hides behind a port.
- **Human trust:** merchants are handing an AI their revenue; PalUp admins are handing it
  their margin. → HITL boundaries, auditability, and an always-available kill switch are
  non-negotiable.
- **Very high stickiness:** the business depends on durable retention. → agent memory,
  results, and per-tenant self-improvement are the moat, and *trust/reliability is the
  retention substrate* (a single bad autonomous action can erase months of it). Treated as a
  first-class driver in `docs/STICKINESS.md`; note it forbids optimizing engagement at the
  expense of value.

## 2. The big picture: three planes

PalUp is organized into three planes with clear boundaries. This is the load-bearing
structural decision (ADR-0002).

```
┌──────────────────────────────────────────────────────────────────────┐
│  CONTROL PLANE  (humans + governance)                                  │
│  Merchant Console · Admin Console · Approval Center · Kill Switch ·     │
│  Evolution Console · Eval Dashboard · Audit Log · Policy engine         │
└───────────────▲───────────────────────────────────▲───────────────────┘
                │ approvals / policy / halt          │ telemetry / proposals
┌───────────────┴───────────────────┐   ┌────────────┴────────────────────┐
│  AGENT PLANE (run-time)            │   │  MONITORING PLANE                │
│  Merchant Sales Partner            │   │  Engineering monitor (traffic,   │
│  PalUp Growth/Sales Partner        │   │  cost, errors, security/SOC)     │
│  Self-healing monitors             │   │  Business monitor (acquisition,  │
│  — all on a shared Agent Runtime — │   │  margin, moat, engagement)       │
└───────────────▲────────────────────┘   └───────────────▲─────────────────┘
                │ tools (scoped, revocable)               │
┌───────────────┴─────────────────────────────────────────┴───────────────┐
│  PLATFORM PLANE  (ports & adapters — the portability boundary)           │
│  model · vector · queue · storage · secrets · commerce(Shopify) ·        │
│  payments · comms(email/chat) · telemetry — each a port with adapters    │
└──────────────────────────────────────────────────────────────────────────┘
```

Separately, a **build-time plane** (Claude Code subagents in `.claude/`) produces all of
the above. It never runs in production; it opens PRs that humans merge. Keeping build-time
and run-time governance distinct is rule #1 in `CLAUDE.md`.

## 3. Component responsibilities

**Agent Runtime (shared).** One runtime hosts every run-time agent — merchant partners,
PalUp's own partner, and the self-healing monitors. An agent is a declarative bundle:
`role + policy + tools + memory + model-tier`. Building one runtime (not three codebases)
means governance, audit, kill-switch, and evolution are implemented **once** and inherited
by every agent. New agent types are config, not new infrastructure. This is what makes the
"extend to new industries/business models" requirement cheap.

**Model tiering.** Routine work → a fast model (e.g. Gemini Flash tier); high-stakes
decisions → a stronger model (Pro tier); experimental self-trained variants → canary only.
The console mockups already reflect this (≈95% routine / 4% high-stakes / 1% canary). The
tier is chosen behind the **model port**, so the routing policy is portable.

**Memory.** Per-agent long-term memory (customer facts, merchant preferences, prior
decisions) in a vector store behind the `vector` port + structured state in Postgres.
Merchant-visible as "Agent Memory" in the merchant console.

**Control plane.** The two consoles plus the governance surfaces (Approval Center,
Automation Rules, Kill Switch, Evolution Console, Eval Dashboard, Audit Log, Policy). This
is where every boundary-crossing decision is resolved by a human. The mockups are the
visual spec.

**Monitoring plane.** Two monitors — engineering (traffic, cost, errors, security/SOC) and
business (acquisition, margin, moat, engagement). Each can *self-recover and self-optimize*
within guardrails, but any fix/optimization that would change cost, margin, ROI, or the
business model is emitted as a **proposal to the Approval Center**, never auto-applied.

## 4. Key technology decisions and trade-offs

Each row states the choice, the main alternative, and why we chose as we did. Deeper cases
have ADRs.

### 4.1 Cloud posture — portable-first on Google (ADR-0001)
- **Chosen:** Use Google's managed services now, but access every one through a port
  (`packages/platform-ports/`). Model calls, vector search, queues, storage, secrets, and
  telemetry all go through interfaces with a Google adapter today.
- **Alternative rejected:** Go Google-native for speed (call Vertex/Gemini/Pub-Sub SDKs
  directly everywhere).
- **Why:** Native is faster to write but couples the business to one vendor's pricing and
  roadmap — unacceptable for a company whose margin story is core and whose moat must
  survive a provider price change. The port tax is small (thin adapters) and pays for
  itself the first time we add a second model provider or region. Trade-off accepted:
  ~1 extra indirection layer and the discipline to keep feature code out of vendor SDKs.

### 4.2 Service topology — modular services, shared runtime
- **Chosen:** A small number of services (console API, agent runtime, monitoring,
  billing) rather than one monolith or dozens of micro-services. Stateless request work on
  **Cloud Run** (scales to zero, cheap at low traffic); long-lived/stateful agent
  orchestration on **GKE** (needed for durable agent loops, schedulers, connection pools).
- **Alternatives rejected:** (a) single monolith — simplest but couples release cadence and
  blast radius, bad for a 24/7 self-healing system; (b) fine-grained micro-services —
  premature for one product team, multiplies ops and cost.
- **Why:** This gives independent deployability where it matters (you can ship a console
  fix without touching the agent runtime) while keeping the operational surface small
  enough for early-stage cost and reliability targets. Split further only when a seam
  proves painful.

### 4.3 Frontend — React + Vite + Tailwind + shadcn/ui
- **Chosen:** React SPA per console, Tailwind for the token system, shadcn/ui for
  accessible primitives, driven by the existing HTML mockups as the visual spec.
- **Why:** shadcn/ui gives unstyled, ownable, accessible components we can theme with the
  PalUp tokens rather than fighting a heavy component library's opinions. Tailwind maps
  cleanly onto the CSS-variable token set both mockups already share. See the
  `palup-design-system` skill for the tokens.

### 4.4 Data — Postgres + vendor-neutral vector store
- **Chosen:** Postgres for transactional/relational data (merchants, orders, approvals,
  audit log); a vector store behind the `vector` port for agent memory and retrieval. Audit
  log is append-only.
- **Why:** Postgres is portable, boring, and well understood — the right default for the
  money-and-audit data where correctness matters most. Keeping vectors behind a port lets
  us start managed and move if economics change.
- **At scale (ADR-0004):** a *single* Cloud SQL instance is fine early but cannot hold the
  target volume (~10^10 customer rows + billions of messages/events/audit records — see
  `design/capacity-model.md`). The scale tier is a **portable, distributed, Postgres-
  compatible engine, sharded by tenant (`merchant_id`)**, behind the same `storage` port so
  ADR-0001 stays intact. **Cloud Spanner — via its PostgreSQL interface, behind the `storage`
  port — is an accepted managed candidate** (lowest-ops), with a self-run alternative
  (YugabyteDB) kept viable; the portability discipline is Postgres-dialect-only +
  keep-an-alternative-viable. Details: `docs/adr/0004-storage-tier-at-scale.md`,
  `docs/design/data-model-and-tenancy.md`.

### 4.5 Open-source agent tooling
- **Approach:** The named ecosystems (`wshobson/agents`, `obra/superpowers`,
  `msitarzewski/agency-agents`, `addyosmani/agent-skills`, `superdesigndev/superdesign`,
  `shadcn-ui/ui`) are used as **inspiration and, where their license and quality check out,
  as vendored building blocks** — not as un-audited runtime dependencies for a system that
  handles merchant revenue.
- **Guardrail:** Before adopting any external agent/skill, verify its license, pin the
  version, review it through `security-reviewer`, and wrap third-party behavior behind our
  own ports/policies. Do not let an external skill acquire autonomy that bypasses the HITL
  policy. (Treat the specific repos above as candidates to evaluate at integration time,
  not as guaranteed-suitable — confirm current contents/licenses when you get there.)
- **The license policy is now concrete:** the allowlist, the flagged candidate register (CockroachDB
  / Redis / Grafana / Sentry / Citus have commercial/copyleft constraints), and the enforcing SBOM +
  license-scan CI gate live in `docs/design/oss-and-licensing.md`.

## 5. Self-improvement, governed (the OpenClaw answer)

OpenClaw's stated failure is agent evolution with **no governance framework and no
human-in-the-loop**. PalUp's answer is to make evolution a pipeline with mandatory gates.
Full detail: `docs/AGENT-GOVERNANCE.md`. In one line:

```
propose ─▶ shadow (0% live) ─▶ canary 1–5% ─▶ eval gate (auto) ─▶ HUMAN approve ─▶ promote ─▶ monitor ─▶ (auto-rollback on regression)
```

No stage is skippable. The eval gate is automatic and blocking ("nothing ships without
passing," per the Eval Dashboard). The human approval is required for any promotion that
changes agent behavior, and for anything crossing a money/model/business-model boundary.
Regression at any live stage triggers automatic revert and freeze (already depicted in the
admin Event Center: _"Eval regression → auto-reverted to v1, canary frozen"_).

## 6. Reliability, cost, and security

- **Self-healing within guardrails:** monitors may restart, reroute, scale, and retry
  automatically. Anything that changes **cost or business model** becomes an Approval
  Center proposal instead of an auto-action.
- **Cost as a metric, not an afterthought:** per-agent and per-merchant token/compute cost
  is telemetry we track and gate on; runaway spend is a first-class alert and a kill-switch
  trigger.
- **Security/SOC:** the engineering monitor includes a security lane; credential scope is
  least-privilege and revocable; the audit log is immutable; the kill switch is global.

## 7. Expansion path (why this survives contact with growth)

Because agents are config on a shared runtime and all vendor/platform specifics live behind
ports, expansion is additive:
- **New commerce platform** (beyond Shopify) → new `commerce` adapter, same runtime.
- **New region** → new region config + data-residency-aware storage adapter.
- **New industry / business model** → new agent role bundles + policies, no new plumbing.
- **New cloud/model** → new adapter behind the existing port.

The things that are expensive to change (governance, audit, kill switch, HITL boundaries)
are built once and inherited everywhere; the things that change often (agents, policies,
adapters) are cheap.

Expansion is also **moat defense**, not only growth: staying on one commerce platform caps
PalUp's defensibility at "whatever that platform allows." Cross-platform reach and an owned
merchant/data layer are what turn a platform feature into a durable business. See
`docs/MOAT.md`.

## 8. Buildable design specs (the pre-development design layer)

The sections above set principles and topology. The **buildable backend design** — data model,
tenancy, ports, runtime, governance-as-services, the money path, integrations, security-in-the-
data-path, and the numbers that validate scale — lives in `docs/design/`, and the load-bearing
decisions are captured as ADRs. This layer was produced as an explicit review of whether the
backend can support **every detail** of the finalized UI/UX and scale to **millions of merchants ×
tens of thousands of customers each**; see `docs/design/ui-backend-coverage-matrix.md` (zero
unmapped screens) and `docs/design/capacity-model.md` (scale + residual empirical risks).

- **ADRs:** `adr/0004` storage tier at scale · `adr/0005` agent-runtime execution model ·
  `adr/0006` eventing & real-time · `adr/0007` attribution & metering · `adr/0008` billing
  settlement via Shopify · `adr/0009` vector store at scale · `adr/0010` capacity-commitment strategy ·
  `adr/0011` merchant-auth model.
- **Specs:** `design/data-model-and-tenancy` · `design/port-interfaces` · `design/capacity-model` ·
  `design/agent-runtime` · `design/governance-subsystems` · `design/attribution-and-billing` ·
  `design/payments-and-billing` · `design/cost-margin-telemetry` · `design/integration-architecture` ·
  `design/comms-and-messaging` · `design/advertising-and-social` · `design/model-gateway` ·
  `design/data-platform` · `design/compute-and-delivery` · `design/observability-and-sre` ·
  `design/cost-optimization` · `design/security-data-path` · `design/identity-and-access` ·
  `design/oss-and-licensing` · `design/console-api-contracts` · `design/ui-backend-coverage-matrix`.
- **Go/no-go for automated development:** `design/README.md`.
