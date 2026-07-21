# Design Spec — UI → Backend Coverage Matrix

_This is the artifact that answers the user's first question directly: **does the backend design
support every detail of the finalized UI/UX?** Every screen in both mockups is mapped to the
entities, API endpoints/services, events, and specs that back it. A row with a gap is a design
defect. Source of truth for the UI: the two mockups + the exhaustive UI inventory produced in this
phase._

Legend for "Backed by": D = data-model, A = console-api, R = agent-runtime, G = governance,
B = attribution/billing, C = cost-margin, I = integrations, S = security, E = eventing (ADR-0006),
Cap = capacity model.

## Merchant console

| Screen | Backing entities | API / events | Specs | Covered |
|---|---|---|---|---|
| Revenue Home | outcome_ledger, metric_rollup, run_trace(today) | `GET /home/summary`, `/revenue/series`; SSE counters | D,A,B,E | ✅ |
| Agent Memory | agent_memory + vectors (provenance, confidence) | `GET/POST /memory`, `/memory/export` | D,R,S | ✅ |
| Inbox | conversation, message, proposal | `GET /inbox/needs-you`, `/threads/:id/*`; SSE live | D,A,G,R,E | ✅ |
| Customers / 360 | customer, segment, agent_memory | `GET /customers?…`, `/customers/:id`, `PATCH facts` | D,A,S(CCPA) | ✅ |
| Cart Recovery | abandoned_cart, recovery_play, proposal | `/recovery/*` | D,A,G,R | ✅ |
| Campaigns / Builder | campaign, creative, proposal | `/campaigns/*` (brief→creative→submit) | A,G,I(media eval) | ✅ |
| Outreach | sequence, sequence_step, consent | `/sequences/*` | A,G,I(comms consent) | ✅ |
| Upsell | upsell_offer (margin-floor adjuster) | `/upsell/:id/adjust` | A,G,C(floor) | ✅ |
| Orders | order, run_trace(intel) | `/orders`, `/orders/intel` | D,A,I(Shopify) | ✅ |
| Payments & Payouts | invoice, outcome_ledger | `/payments/cycle`, `/account` | B,I(Shopify Billing) | ✅ |
| Approval Center | proposal (state machine, expiry) | `/approvals/*`, batch; SSE "N to approve" | G,A,E | ✅ |
| Automation Rules | automation_rule | `/rules/*` | G,A | ✅ |
| Agent Controls | agent (channels/autonomy), killswitch | `/agent/controls`, `/agent/emergency-stop` | R,G | ✅ |
| Benchmarks | de-identified analytics (k≥50) | `/benchmarks` | D(§5),S | ✅ |
| Billing & Usage | usage_ledger, invoice, spend_cap | `/billing/usage`, `/invoices` | B,C | ✅ |
| Plans | plan config | `/plans` (change via Shopify) | B,I | ✅ |
| Live Chat Widget | widget_config | `/widget/config`; `w.js` | A,I,E(WS) | ✅ |
| Settings (store/agent/team/compliance/privacy/security) | merchant, user, policy, consent | `/settings/*` | D,S,G | ✅ |
| Audit log (settings) | audit_entry (hash-chained) | `/audit?…` | G(§6) | ✅ |
| Notifications | notification prefs | `/settings/notifications`; SSE | A,E | ✅ |
| Ask Aria | (RBAC-scoped read) | `/ask` | A,S(RBAC) | ✅ |
| Overage/cap banners, basic mode | spend_cap, policy | SSE cap-hit event | B,C,E | ✅ |

## Admin console

| Screen | Backing entities | API / events | Specs | Covered |
|---|---|---|---|---|
| Login / step-up | operator, passkey | SSO/OIDC, step-up | S | ✅ |
| Home (role-aware) | metric_rollup (role slice) | `/home` | A,S(RBAC) | ✅ |
| Business Monitor | funnel, cohort, retention, moat metrics | `/business/*` | D,B,E | ✅ |
| FinOps & Margin | usage_ledger, spend_budget, plan margins, 8-cat cost stack | `/finops/*`, budget proposal | C,B,G | ✅ |
| Growth Overview | growth metrics, loops | `/growth/*` | D,A | ✅ |
| Prospect Pipeline | prospect (funnel, heatmap, channels) | `/prospects?…` | D,A,I(Clearbit/Apollo) | ✅ |
| Growth Campaigns / Builder | growth_campaign, creative (SEO/AEO) | `/gcampaigns`, builder | A,G,I | ✅ |
| Site Experiments / CRO | experiment (canary) | `/experiments` | A,G(evolution-style) | ✅ |
| Growth Outreach | growth_sequence, suppression | `/goutreach` | A,I(comms),G | ✅ |
| Growth Inbox | conversation (prospect), proposal | `/ginbox`; SSE | D,A,G,E | ✅ |
| Deal Close | deal, invoice (PalUp subs) | `/deals` | B,I(Shopify Billing) | ✅ |
| Expansion | expansion opportunity (guardrails) | `/expansion` | A,G(dedup/nudge caps) | ✅ |
| Approval Center | proposal (all PalUp sources, two-person) | `/approvals/*` | G,A,E | ✅ |
| Automation Rules | automation_rule (maker-checker) | `/rules` | G | ✅ |
| Engineering Monitor | SLO/service health, model gateway | `/eng/*` | Cap,R,C,E | ✅ |
| Event Center | event, remediation | `/events`; SSE | E,R | ✅ |
| Security / SOC | threat monitor, guardrail coverage, accounts | `/security/*` | S,E | ✅ |
| Kill Switch | killswitch_state (3 scopes) | `/killswitch/*` (step-up/two-person) | G,R | ✅ |
| Evolution Console | evolution_candidate + stage records, fleet_pattern | `/evolution/*` (signoff/rollback) | G(§4),D(§5) | ✅ |
| Eval Dashboard | eval_run, eval_suite_result (7 suites) | `/evals/*` | G(§5) | ✅ |
| Policy & Guardrails | policy (~41) | `/policy/*` (owning role+step-up) | G(§1),S | ✅ |
| Audit Log | audit_entry (3.1M/day, 7yr) | `/audit?…` | G(§6),Cap | ✅ |
| Run Replay / Run lookup | run_trace (by-id, 90d) | `/runs/:id` | R(§9),D,Cap | ✅ |
| Users & Roles (RBAC) | operator, operator_role (8) | `/operators/*` | S | ✅ |
| Settings (org/env/residency) | org, region config | `/org/settings/*` | S,D(residency) | ✅ |

## Cross-cutting UI behaviors → backing decision

| UI behavior | Backed by |
|---|---|
| "showing N of M / scroll loads more" on big lists | cursor pagination + `total` (api §1); tenant-keyed tables (D) |
| Live counters / "N to approve" / monitors updating | projections + SSE (ADR-0006 / E) |
| Approve → set as a rule | rule creation from proposal (G §2) |
| Batch decide-once | proposal batch endpoint (G §3) |
| Numeric adjusters bounded (margin floor, ad cap) | policy-bounded adjusters (G §3, C §4) |
| Expiry: fail-closed / never-expires / standing | proposal expiry semantics (G §3) |
| Two-person + step-up | RBAC + step-up (S §6, G §3) |
| Basic mode at cap (live chat continues) | spend_cap policy + degradation (B §5) |
| Role-gated nav / ask-bar inherits RBAC | server-side RBAC (S §6, api §1) |
| k≥50 benchmarks / fleet learning | de-identified pipeline (D §5) |
| Hash-chained audit, before→after diff | audit_entry (G §6) |
| Forensic by-id run lookup (no fleet scroll) | run_trace design (R §9, Cap) |

## Payments coverage sub-matrix (money path in detail)

Legend adds: Pay = payments-and-billing spec, A8 = ADR-0008.

| Payment UI surface | Backing entity/flow | Specs | Covered |
|---|---|---|---|
| Merchant Payments & Payouts (net-you-keep, "PalUp never touches money") | invoice, outcome_ledger; payout = Shopify (read-only) | Pay(inv),A8,B | ✅ |
| Merchant Billing & Usage — Within plan | invoice = base+fee+overage | B(§3),Pay(§2) | ✅ |
| Billing & Usage — Overage | usage_ledger beyond included credits | B(§2),Pay(§2) | ✅ |
| Billing & Usage — At cap $3k / $0 | cappedAmount + basic-mode degradation | A8,B(§5),Pay(§2) | ✅ |
| Overage spend cap (warn %, hard cap, approved in Shopify) | Shopify `cappedAmount` | A8,Pay(§2) | ✅ |
| Failed charge → pause proactive, Shopify retries | dunning state machine | Pay(§3) | ✅ |
| Invoices table / PDF (billed via Shopify) | invoice, AppSubscription/UsageRecord | A8,Pay | ✅ |
| Plans (base + fee tiers; change in Shopify) | plan config, AppSubscription line items | A8,B(§3) | ✅ |
| Admin FinOps — collection this cycle / performance fees | outcome_ledger, reconciliation report | Pay(§2),C | ✅ |
| Admin FinOps — plan margin (incl. Shopify 0/15% share) | margin model + revenue-share cost line | A8,C(§3) | ✅ |
| Admin Deal Close — new MRR / failed & retrying $3,210 | PalUp own AppSubscription + dunning | A8,Pay(§3) | ✅ |
| Merchant refund (draft; ≤$30 auto; duplicate check; execute in Shopify) | refund money tool | Pay(§6),S | ✅ |
| Refund past policy / above ceiling → HITL | proposal + ceiling | Pay(§6),G | ✅ |
| Chargeback / dispute (evidence assembled, submission HITL) | dispute tool | Pay(§6) | ✅ |
| SLA credit (≤$500 rule / above HITL) | adjustment_ledger credit | Pay(§5),G | ✅ |
| Bad-debt write-off (≤$1,000 rule / above HITL) | adjustment_ledger write-off | Pay(§5),G | ✅ |
| Custom / below-floor fee (two-person) | fee delta, margin boundary | Pay(§5),C,G | ✅ |
| Returns reduce attributed revenue → clawback | attribution restatement → adjustment_ledger | Pay(§4) | ✅ |
| Routine billing corrections auto / disputed escalate | adjustment rule vs proposal | Pay(§4),G | ✅ |
| Money-tool allowlist (Shopify refund, Shopify Billing app charge) — two-person | money-tool allowlist | Pay(§6),S,G | ✅ |
| Every money action audited + reversible | hash-chained audit + reversal | Pay(§8),G(§6) | ✅ |

**Zero unmapped payment surfaces.** No PalUp-holds-funds path anywhere; every money mutation is a
rule-or-proposal, audited, reversible.

## Comms coverage sub-matrix (email / SMS / live chat)

Legend adds: Cm = comms-and-messaging spec.

| Messaging UI surface | Backing flow | Specs | Covered |
|---|---|---|---|
| Merchant Inbox — replies land here ("Replies → Inbox 1,240") | inbound email parse → thread → Inbox | Cm(§5),D,E | ✅ |
| Live Chat Widget (`w.js`, <120ms, take-over) | WebSocket transport + handoff | Cm(§10),E | ✅ |
| Email send (campaigns/nurture/outreach) | send gate + SendGrid/SES | Cm(§1–2),I | ✅ |
| SMS send (segment counter, consent-gated) | send gate + Twilio + segment count | Cm(§1,§8),I | ✅ |
| Domain auth (SPF/DKIM/DMARC "authenticated") | deliverability onboarding | Cm(§2) | ✅ |
| Deliverability / sender reputation | IP warmup, reputation, ESP failover | Cm(§2,§6) | ✅ |
| Consent snapshot (email 21,840 / SMS 8,210 / excluded 412) | consent records (proof) → projection | Cm(§3) | ✅ |
| One-click unsubscribe / opt-out | instant suppression propagation | Cm(§3–4) | ✅ |
| SMS STOP / HELP / START | deterministic keyword auto-handling | Cm(§5) | ✅ |
| Bounce / spam-complaint handling | feedback loop → auto-suppress + reputation | Cm(§6) | ✅ |
| Suppression list (outreach) | global + per-tenant suppression | Cm(§4) | ✅ |
| TCPA exclusions (412 missing SMS consent) | consent gate step 1 | Cm(§3) | ✅ |
| Quiet hours + frequency caps | quiet-hours + cross-channel governor | Cm(§1,§7) | ✅ |
| Send rate limits (email 2k/hr, SMS 200/hr) | rate limit gate | Cm(§1),G | ✅ |
| A2P 10DLC registered number | brand/campaign registration workflow | Cm(§8) | ✅ |
| CAN-SPAM sender identity / physical address | compliance envelope | Cm(§1),I | ✅ |
| Personalized-per-recipient copy / preview | template & rendering service | Cm(§9) | ✅ |
| Basic mode at cap (live chat continues) | chat transport + billing degradation | Cm(§10),Pay | ✅ |
| DLP/PII redaction before send | comms-boundary redaction | Cm(§1),S(§3) | ✅ |

**Zero unmapped messaging surfaces.** Every send passes a consent + suppression + frequency +
quiet-hours + rate + DLP gate; opt-outs and STOP/HELP are deterministic, not LLM-dependent.

## Result

**Zero unmapped screens or load-bearing behaviors.** Every detail in the finalized UI/UX has a named
backing entity, endpoint, event source, and owning spec. Items that remain *empirical* rather than
*structural* (per-action cost, tier mix, req/s, vector economics) are tracked as go/no-go conditions
in the capacity model §6 — they are not coverage gaps.
