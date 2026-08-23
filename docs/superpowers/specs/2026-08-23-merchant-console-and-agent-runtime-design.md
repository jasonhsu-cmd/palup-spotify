# Merchant Console + Agent Runtime — Program Design

- **Status:** Approved (brainstorm) — 2026-08-23; ready for implementation plans
- **Owner:** Claude (build-time agent), from 2026-08-23 — approved by the product owner during brainstorming (that approval is the human gate). The §3 approvals this spec describes are the **run-time product feature** (§4, §12), not a build-time ownership or merge gate.
- **Supersedes/relates:** ADR-0002 (two-plane), ADR-0005 (agent-runtime), ADR-0006 (eventing), ADR-0007 (attribution/metering), ADR-0008 (billing via Shopify), ADR-0011 (merchant auth), ADR-0012 (Shopify grounding), ADR-0013 (telemetry/cost), ADR-0001 (portability).

## 1. Goal

Build PalUp's **run-time agent plane** (`agent-runtime` and the product's sales agents) **and the merchant console** that a Shopify merchant uses to watch, steer, and trust it — as a **production-ready system running on internal staging**. Only legal instruments, live billing charges, standalone/SSO auth, the Ask-Aria conversational layer, and the human prod-promotion gates are deferred to the production push; everything else is built, wired, and enabled on staging.

## 2. Strategic frame (why the design is shaped this way)

The business objective: help Shopify merchants maximize revenue while maximizing PalUp's revenue and margin, en route to a publicly-traded US company serving millions of merchants and hundreds of millions of shoppers, on very high stickiness and a durable moat.

Three design through-lines fall directly out of that objective and govern every decision below:

1. **Trust-calibrated autonomy (the stickiness + margin engine).** Per-action human approval cannot scale to millions of merchants, and friction there kills retention — but §3 forbids removing the guardrail. The resolution is a **trust ratchet**: the agent proves outcomes → earns a wider autonomy envelope → the merchant delegates more → effort drops, switching cost rises. One PalUp serves many merchants at high margin because *earned* autonomy (not a weaker guardrail) shrinks the human-touch cost per merchant.
2. **The network effect (the platform moat / the $30B lever).** Per-merchant learning is an individual switching cost. **Aggregate, anonymized cross-merchant learning** that seeds new merchants on Day 1 turns thousands of individual switching costs into a compounding platform advantage no competitor can catch.
3. **Honest incremental billing (the alignment guarantee / anti-OpenClaw).** PalUp charges only on **incremental** revenue it can prove it added (measured against a holdout), never inflated last-touch. This structurally removes the incentive to milk merchants — the failure that sank OpenClaw. At scale, trust *is* the moat; the governance is the asset, not friction.

Everything below serves these three. Where a choice trades short-term PalUp revenue against merchant trust, trust wins — because at millions of merchants, word travels and a milked merchant inverts the moat.

## 3. Scope

### In scope (v1, production-ready on staging)
- The **engine**: `agent-runtime` + the run-time agents (chat closer [exists], win-back, offers, nurture, insight synthesizer), governed by the evolution pipeline + HITL + Kill Switch.
- A new **`merchant-backend`** service + **React merchant console** (App Bridge embedded), covering workstreams **W1–W7 + Install/Onboarding** (§9).
- Foundations **F1–F3** (§7).

### Deferred (documented, not dropped)
- **Ask Aria** — the in-console conversational assistant (v2 delight; removes the natural-language action surface risk from v1). The merchant drives the engine through the structured screens.
- **Standalone accounts + Enterprise SSO/SCIM** (ADR-0011's secondary auth path) — deferred to the Enterprise push.
- **Legal instruments** (Terms/DPA/privacy/AUP/SLA) and the legal-gated data paths (memory production go-live, special-category/Art-9 carry-over, sensitive-data residency *promise*).
- **Live billing charges** — the billing code path is real on staging; the money movement is mocked.
- **All human prod-promotion gates** — staging agents may reach canary on staging traffic; going to prod/100% waits for a human.

### Explicitly out of scope
- The **admin console** (PalUp operator plane) — separate program; the operator control-plane already exists.
- The **merchant-growth agent** (PalUp's own acquisition agent) beyond the signup→console handoff it feeds.

## 4. The two planes (do not blur)

This program is the **run-time agent plane** (ADR-0002) and its human control surface. The agents here serve merchants and shoppers in production; they are governed by the **HITL policy + Approval Center + Kill Switch**, and change only through the **evolution pipeline** (`propose → eval gate → shadow → canary → human promote`). They are **not** build-time agents.

Critical boundary: the merchant console's Approval Center is the **merchant plane** (a merchant approving *their own* agent's money/autonomy actions, per-tenant, App-Bridge-authed). It must **not** reuse the existing control-plane operator routes (`packages/control-plane` — `/api/approve` etc.), which are the **PalUp-admin plane**. Conflating the two is, per the operating manual, "the single largest risk."

**The symmetry (CLAUDE.md §1).** PalUp runs two mirror AI sales partners. The **merchant's partner** (this program) acquires/closes/nurtures the merchant's *shoppers*, and its self-improving actions that touch the *merchant's* revenue / sales-marketing ROI / business model require the **merchant's** approval — the Approval Center built here. PalUp's own partner acquires/closes/nurtures *merchants*, and the mirror actions require **PalUp administrators'** approval — the admin console, a separate program (out of scope, §3). Both approval gates are **run-time product features**; neither is a gate on *building* this software.

## 5. Architecture overview

```
Shopify Admin (embeds)                          Shopify (system of record)
   │  App Bridge session token                        ▲  read-through / webhooks
   ▼                                                  │
merchant console (React/Vite/Tailwind/shadcn)         │
   │  HTTPS (session token → PalUp session)           │
   ▼                                                  │
merchant-backend (new Cloud Run service) ─────────────┘
   │            │                    │
   │ identity   │ merchant-plane API │ ports (commerce, secrets, comms, model, state)
   │ port (F2)  │ (W1–W7)            │
   ▼            ▼                    ▼
agent-runtime (GKE) ── run-time agents ── evolution pipeline / eval gate
   │  proposal→approval loop, Kill Switch, immutable audit, attribution/holdout
   ▼
Postgres (state) + vector store + outcome/audit ledgers
```

- **`merchant-backend`** is a **new Cloud Run service** (decision D-arch-1), distinct from `widget-backend`, for clean plane separation and independent deploy. It exposes the merchant-plane API and depends on the same platform ports (ADR-0001 — no provider SDK in feature code).
- **`agent-runtime`** (ADR-0005, Accepted, not yet built) is the GKE host for the run-time agents. It owns the proposal→approval loop, the Kill Switch primitive, the immutable audit ledger, and the attribution/holdout machinery.
- **Reused substrate already built (mostly dark):** Shopify grounding (ADR-0012), CommercePort/CartPort, order-attribution webhooks + join token, outcome-ledger, holdout arms, merchant-credential store, telemetry/cost (ADR-0013), the evolution engine + eval gate, the runtime Kill Switch primitive. This program gives much of the dark flywheel substrate its first real callers.

## 6. The engine (`agent-runtime`)

### 6.1 The agents (mapped to the console)
| Agent | Role | Status | Feeds |
|---|---|---|---|
| Chat closer | Answers shoppers in live chat 24/7, nudges to sale | **Exists** (widget-brain/backend) | Live chat; touchpoints (W5) |
| Win-back / campaign | Drafts win-back / abandoned-cart campaigns | New | Approval Center (W1) |
| Offers / discount | Proposes discounts within W4 caps | New | W1 / W4 |
| Nurture | Email/SMS lifecycle sequences | New | W1; comms port (W7) |
| Insight synthesizer | Turns raw data into merchant-facing insights | New | Learned (W3) |

All are governed run-time agents: scoped/revocable credentials, Kill-Switch-halted, every autonomous action audited, behavior changes only via the evolution pipeline.

### 6.2 The proposal → approval loop (the spine — shared with W1)
1. Agent decides an action → `classifyAction(action)` (the `hitl-approval-gate` pattern) reads the **live** Automation Rules (W4).
2. `auto` (reversible + in-policy + within envelope) → execute + write audit. Done.
3. `requires_approval` (crosses money/marketing/autonomy, or above the envelope) → create a **Proposal** (`pending`) with a **required `reversalPlan`** (invalid without one) and **`boundaryReasons`** traceable to a specific HITL rule.
4. Merchant decides in the Approval Center → on **approve**, preconditions are **re-validated at click-time** (never execute a stale decision), execution runs **idempotently**, and every transition writes the **append-only, hash-chained audit ledger** (reuse the `verifyAuditChain` pattern from `packages/evolution`).

**Proposal model:** `{ tenantId, agentId, agentType, action{type,params}, category, rationale, boundaryReasons, estimatedImpact, reversalPlan, irreversible, preconditions, status, version, createdAt, expiresAt, decidedBy, decidedAt, decisionNote, executionId, executedAt, executionResult }`.

**Lifecycle:** `draft → pending → {approved → executing → executed | execution_failed} | rejected | expired | withdrawn | killed`.

### 6.3 Governance rails (non-negotiable)
- **Evolution pipeline** for every behavior change; the blocking eval gate runs before any live stage. On staging, agents may reach canary on staging traffic; prod promotion is a deferred human gate.
- **Kill Switch** always works: a dead-simple, separate path (never dependent on agent health) at three scopes (one merchant / one agent-type / global). The merchant console exposes the tenant-scoped face; the control-plane primitive + `pnpm kill:arm` remain the broader path. While killed: in-flight executions abort at the next checkpoint, new proposals blocked, pending frozen. Un-kill is deliberate + audited.
- **Immutable audit** of every autonomous action: actor, input, decision, reversal path.
- **Attribution / holdout** (§9 W2): a ~5% holdout arm measures incremental lift; the outcome ledger + holdout arms (built dark) get real callers here.

## 7. Foundations (build first — F1 → F2 → F3)

- **F1 · `design-system` package** (not yet built) — tokens + shadcn/ui themed to the PalUp tokens, sourced from the `palup-design-system` skill and `palup-merchant-app.html`. Shared with the future admin console. Build only what the v1 screens need (YAGNI).
- **F2 · `identity` port + Shopify App Bridge adapter** (ADR-0011, Accepted, **not built**) — App Bridge session-token exchange → PalUp session `{merchantId, userId, role, authLevel}`, tenant bound from **verified claims, never client input**; single-use exchange; CSP-restricted framing. Role is PalUp's (5-role RBAC), mapped from Shopify staff role / invite. Standalone/SSO/API-keys deferred.
- **F3 · `merchant-backend` service** — the merchant-plane API. Every route tenant-scoped from the verified principal, behind platform ports, RBAC-enforced in middleware, every mutation through the HITL classifier + audit. New Cloud Run service.

## 8. Cross-cutting decisions

- **New service** for the merchant plane (not an extension of `widget-backend`) — plane separation, independent deploy.
- **One canonical metering path** (ADR-0007) is the single source for every money number (attributed revenue, fees, net) — no second calculation in the console or the engine.
- **Portability** (ADR-0001): all cloud/vendor/commerce/comms/secrets access via ports; a second commerce platform is a new adapter, not a rewrite.
- **Least privilege** (§6 of the manual): agents get scoped, revocable credentials; console users default to low-privilege roles.

## 9. Workstreams

Each workstream = a governed surface (engine half + console half), built ATDD, behind a flag, staging-enabled. "Staging-done" = the mechanism is real against the staging Shopify dev store; only the deferred gates (§3 scope) are stubbed.

### W1 · Approval Center + Kill Switch + Audit Log — *the product*
- **Purpose / producer:** the proposal→approval loop (§6.2); every agent feeds it.
- **API (`merchant-backend`):** `GET /approvals?status=&category=&cursor=` · `GET /approvals/:id` · `POST /approvals/:id/approve` (body: version, note) · `POST /approvals/:id/reject` (reason) · `GET|POST /kill` · `POST /unkill` · `GET /audit?cursor=` · `GET /events` (SSE: new-proposal / decided / kill-changed). Tenant-scoped; `approve` gated on `can_approve_money`.
- **Decisions:** trust-ratchet model (agent proposes envelope expansions as a first-class proposal type); rules-first, not approve-each — the Approval Center shows only exceptions above the standing envelope; rejections feed **per-tenant preference memory** that shapes future proposals (never a silent prompt change); irreversible actions allowed + flagged, entering the auto-act envelope last, with a **permanent approval floor** on high-blast-radius sends regardless of trust; optimistic-lock concurrency (`version`); proposal TTL default **72h**, category-tuned, with one-click "redraft" on expiry.
- **§3:** the whole non-negotiable — no proposal without a `reversalPlan`; nothing auto-applies; approve is a role-bound human act.
- **Staging-done:** a real win-back proposal is approved against the staging store; execution + Kill Switch + audit all real.

### W2 · Revenue Home
- **Purpose:** the retention surface and the trust ratchet's scoreboard.
- **Producer:** the attribution/outcome ledger + the activity event stream (ADR-0006).
- **API:** `GET /home/summary` (attributed / cost / **net**), `GET /activity?cursor=`, the onboarding-handoff card.
- **Decisions:** **bill and report on honest incremental lift** (holdout-based), never last-touch; **~5% holdout**, transparent, positioned as the proof; **net-negative merchants shown honestly** + a fix-it flow (hiding it inverts the moat); **one primary goal** object every agent reads and orients to; incrementality is a **marketed differentiator**, not a footnote.
- **§3:** read-only *action* surface; high *integrity* surface — attributed revenue is the billing base, from the one canonical metering path only.

### W3 · Learned / Memory & Voice
- **Purpose:** where the individual moat *and* the network-effect platform moat are built.
- **Producer:** `widget-memory` (built, staging-ON) + a governed **insight synthesizer** agent.
- **API:** `GET /learned?category=` (customers/products/voice/policies), `POST /learned` (teach), `POST /learned/:id/pin`, `DELETE /learned/:id`, export.
- **Decisions:** **two-tier learning** with a hard wall — **private** per-merchant (never shared) + **aggregate anonymized** cross-merchant priors that seed new merchants (no store's specifics ever reach another); **merchant owns voice** — the agent may *propose* voice changes but never silently alters how it talks; **conservative insight grounding** — source + sample-size floor before "High" confidence, nothing surfaced below a confidence floor (a wrong insight acted on burns trust); **merchant owns their brain** — can export/delete their private layer ("you own your agent's brain"; export mechanism legal-deferred, ownership stance committed now); teaching = **per-tenant config** the agent conditions on (not retraining), with a **safety floor** (can tighten guardrails, cannot loosen a safety-critical one below policy).
- **§3:** synthesizer is a governed agent (eval gate + honest grounding); voice/policy edits are per-tenant config; special-category insights respect the consent path (memory prod-enablement legal-gated).

### W4 · Automation Rules
- **Purpose:** the standing money envelope — the pressure-release valve for W1 and the trust ratchet's storage.
- **Producer:** merchant-authored + agent-proposed (via W1); consumed live by the classifier.
- **API:** `GET /rules`, `PUT /rules` (discount ceiling + stacking, ad-spend budget + ROI floor, refund/price-match limits, subscription policy, comms frequency + quiet hours).
- **Decisions:** three-layer envelope `PalUp safety floors < merchant envelope < agent auto-act limit`; **conservative-but-useful starting envelope** (Day-1: answer + tiny in-policy nudges auto; all spend/discount/refund need approval until earned); **PalUp inviolable safety floors** (mass-send floor + spend-sanity, discount-depth, refund-abuse caps) even the merchant can't exceed; **vertical default presets** informed by the W3 aggregate layer (network effect → faster time-to-value); **merchant sovereign** on rule changes (instant, no artificial cooldown) with a clear "this lets the agent … up to X" confirmation + audit on big jumps; rules **enforced live in the classifier**, not display-only.
- **§3:** the densest money-boundary config; every change audited with provenance; agent-initiated changes flow through W1; PalUp floors inviolable. Governance-touching → named human owner.

### W5 · Orders + Payments & Payouts
- **Purpose:** the trust anchor ("PalUp never touches your money") + compliance moat (out of money-transmitter licensing / PCI scope, ADR-0008).
- **Producer:** Shopify (system of record) via CommercePort + order-attribution webhooks; PalUp overlays "what the agent did."
- **API:** `GET /orders` (read-through, annotated with agent touchpoints), `GET /payments` (Shopify payouts + transparent PalUp fee line); Shopify deep-links for money actions.
- **Decisions:** read-through only — Shopify owns orders/fulfilment/edits/refunds; **refunds mostly propose-only** (agent auto-issues only tiny in-policy goodwill within a hard W4 limit; anything real → W1 or merchant-in-Shopify); **agent observes + does customer-service actions** (proactive "shipped" messages, flag issues) but order edits/fulfilment stay in Shopify; **touchpoint (per-order, factual) vs incremental (aggregate, billed)** kept crisply distinct.
- **§3:** low — read-only + deep-links; the one money action (refunds) is governed by W4/W1.

### W6 · Billing & Usage + Plans
- **Purpose:** the monetization engine, the GTM wedge, and the deepest §3 boundary (money + margin + business model).
- **Producer:** Shopify Billing API (ADR-0008) + canonical metering (ADR-0007) + incremental attribution (W2).
- **API:** `GET /billing` (usage vs cap, fee model), `GET /plans`, `POST /plan` (→ Shopify approval).
- **Decisions:** **pay-as-you-earn** — pure performance (0 base, % of **incremental**) for frictionless land; a base/platform fee only at **Pro/Enterprise** (predictable recurring revenue for the public-company story); **~6% take-rate on incremental** (a merchant keeps 94% of revenue they wouldn't have had; must clear inference COGS with wide margin — watched via ADR-0013 telemetry); **billed through Shopify** (no card with PalUp, reinforcing W5); **usage cap = bill-shock protection** (cap raise = merchant approval in Shopify); **charge-failure = pause proactive work, never stop live chat**; tiers gate scale + features + which agents/channels, **Enterprise adds SSO/SCIM/seats/support**.
- **§3:** changing the take-rate / fee model is the ultimate boundary — never auto-applies; plan/cap changes route to Shopify approval. Governance-touching → named human owner.
- **Staging-done:** full billing code path real; **live charges mocked** (deferred).

### W7 · Settings
- **Purpose:** RBAC (the top-down GTM enabler) + data residency (trust + market-access moat) + integrations (the agents' comms capability).
- **API:** store/brand profile; team & RBAC (`can_approve_money`, ADR-0011's 5 roles); data residency; integrations (comms channels).
- **Decisions:** ADR-0011's 5 roles, permissions PalUp's, mapped from Shopify staff role / invite, editable with audit; **invited teammates default to least-privilege** (view + operate, no money-approval) until the owner elevates; RBAC enforced in **middleware on every route** (security-reviewer gate); **data-residency mechanism built now** (region-pinned via ports, ADR-0001), marketed once legal clears for prod, led with for EU-serving/enterprise; **comms sender supports both** a PalUp-managed sender (frictionless day-one) and a merchant-connected sender (brand + deliverability), credentials via the secrets port; **SSO/SCIM deferred** to the Enterprise push.
- **§3 / security:** RBAC (authz), residency (legal-adjacent), comms creds (secrets) → named human owner + security-reviewer.

### Install & Onboarding (ex-W8; Ask Aria removed)
- **Purpose:** the front door + first-value moment (bottom-up GTM conversion; time-to-first-value is retention-defining).
- **Design:** App Bridge OAuth install (extend the existing `chore/shopify-app-host-staging` config); **opinionated guided setup** — connect Shopify (grounding/catalog) → set the primary goal → apply conservative vertical-preset default rules → pick data residency → **live chat answering shoppers within minutes** (the chat closer is the fastest first win; proactive agents introduced under the trust ratchet); **signup→console handoff** — the merchant-acquisition agent's signup conversation carried into Day 1, kept strictly separate from customer data, transparent to the merchant.
- **Dependency (not a design choice):** **Shopify app registration** (PATH-TO-PRODUCTION item 1, pending) is a human/partner-dashboard step required for real App Bridge even on staging.
- **§3 / security:** Shopify token custody via secrets port (merchant-cred store, built dark); cross-plane handoff data-separated → named human owner + security-reviewer.

## 10. Decisions ledger (business decisions ratified during design)

All ratified by the owner on 2026-08-23 unless noted.

**Autonomy / Approval (W1):** trust-ratchet model ✓ · permanent mass-send approval floor ✓ · rules-first (exceptions only) · rejections → per-tenant preference memory · irreversibles allowed+flagged, envelope-last · `can_approve_money` distinct, owner+admin default, delegable · TTL 72h + redraft.
**Attribution / Revenue (W2):** bill on incremental · ~5% holdout, marketed as proof · net-negative shown honestly + fix-it · one primary goal · canonical metering single-source.
**Learning (W3):** two-tier (private + aggregate) with hard wall · merchant owns voice (agent proposes) · conservative grounding (sample-size + confidence floors) · merchant owns/export/deletes their brain · teaching = config not retraining, safety floor.
**Rules (W4):** three-layer envelope · conservative-but-useful start · PalUp inviolable floors · vertical presets from aggregate · merchant sovereign + big-jump confirm.
**Orders/Payments (W5):** read-through, Shopify system of record · refunds propose-only (tiny goodwill exception) · agent observes + service actions.
**Billing (W6):** pay-as-you-earn, pure-perf land + base fee at Pro/Enterprise · ~6% on incremental · billed via Shopify · usage cap protection · charge-fail pauses proactive, not chat · tiers gate scale/features, Enterprise SSO.
**Settings (W7):** ADR-0011 5 roles, least-privilege default · residency mechanism now / market later · dual comms sender · SSO deferred.
**Onboarding:** opinionated guided setup · signup handoff carried in, data-separated · live chat first win.
**Scope:** Ask Aria deferred · engine driven via structured console.

## 11. Build order

1. **Foundations:** F1 (design-system) → F2 (identity port + App Bridge) → F3 (`merchant-backend` skeleton).
2. **First end-to-end vertical (proves "console + engine"):** `agent-runtime` skeleton + **one real agent (win-back)** + the proposal→approval loop + **W1** (Approval Center + Kill Switch + Audit) + minimal **W4** (the rules the classifier reads).
3. **The scoreboard:** W2 (activity feed → wire dark outcome-ledger/holdout → incremental lift → net) + the goal object.
4. **The moat surfaces:** W3 (learning private + aggregate; insight synthesizer) then broaden W4 (full envelope, presets).
5. **Money surfaces:** W5 (read-through + touchpoints) → W6 (billing code path, charges mocked).
6. **Access + entry:** W7 (RBAC, residency, comms) + Install/Onboarding.
7. **More agents:** offers, nurture, insight synthesizer to full capability, each through the evolution pipeline.

Each numbered block becomes one or more implementation plans (one per PR-sized deliverable) via the `writing-plans` skill; foundations and W1/engine are the critical path.

## 12. Non-negotiables compliance (§3 mapping)

- **Money/model/business-model never auto-applies** → the proposal→approval loop (W1) + Shopify-routed plan/cap approvals (W6) + audited rule changes (W4).
- **No agent ships to 100%/prod without eval gate + human promotion** → evolution pipeline; staging reaches canary only; prod promotion deferred.
- **Portability** → all access via ports (ADR-0001); new `merchant-backend` uses ports, no provider SDK in feature code.
- **Kill Switch always works** → §6.3, tenant-scoped face in W1.
- **Every autonomous action audited** → append-only hash-chained ledger.
- **Least privilege** → scoped agent credentials; least-privilege default console roles.

**Ownership vs. the run-time gates (do not conflate).** The §3 approvals above are the **run-time product feature** — the merchant's agent requires the *merchant's* approval to self-improve on revenue/ROI/business-model actions (and PalUp's agent requires *admin* approval for the mirror). They are **not** a gate on developing this software. This spec is brainstormed with and approved by the product owner, so **the build-time program is owned by the build agent**; routine and flag-off/gate-green PRs self-merge after the §4 reviews (security-reviewer where authz/credentials/agent-autonomy code is touched). The owner is brought in only for (a) **run-time enablement/promotion** to production traffic and (b) genuinely governance-touching *edits* — changes to the HITL policy, the evolution gate, or the operating manual itself.

## 13. Risks & open questions

- **Scope size.** This is a multi-subsystem program (engine + service + 7 surfaces), not one plan. Sequencing (§11) keeps each block independently testable; the first vertical (block 2) de-risks the whole shape.
- **Proposal producer dependency.** The Approval Center is only meaningful with agents producing real proposals — which is why block 2 builds `agent-runtime` + one agent *with* W1, not W1 over synthetic data.
- **Aggregate-learning privacy boundary (W3).** The hard wall between private and aggregate layers needs a rigorous definition of "aggregate enough" and a consent/competitive-fairness review before the aggregate layer is enabled — flagged for legal/security at that block.
- **App registration (Onboarding).** A human/Shopify-partner step gates real App Bridge; not a code deliverable.
- **Unit economics (W6).** ~6% on incremental must clear inference COGS with margin; wire the fee against ADR-0013 telemetry so margin is observable per merchant from day one.
- **Legal-gated data paths.** Memory prod-enablement, special-category handling, and sensitive-data residency *promises* stay legal-gated; the mechanisms are built and run on staging, the production promises wait.

## 14. Self-review

- **Coverage:** every workstream from the design conversation (engine, W1–W7, onboarding) has a section; Ask Aria is captured as deferred with rationale, not dropped. Every ratified business decision (§10) maps to a workstream.
- **Consistency:** the three strategic through-lines (§2) recur in each workstream's decisions; the attribution number has one source (ADR-0007) across W2/W5/W6; the trust ratchet ties W1 and W4.
- **Decomposition:** the program is explicitly split into foundations + per-workstream plans (§11); it is not a single implementation plan.
- **Ambiguity:** the merchant vs operator plane boundary is stated (§4); the staging-vs-prod gate line is explicit (§3, §12); the one genuinely unresolved design item (aggregate-learning boundary definition) is flagged as a block-time legal/security review, not left silent.

---

**Next step:** owner reviews this spec. On approval, decompose into implementation plans (`writing-plans`), starting with foundations F1–F3 and the first end-to-end vertical (block 2).
