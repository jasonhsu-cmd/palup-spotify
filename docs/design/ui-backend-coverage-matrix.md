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

## Advertising & social coverage sub-matrix

Legend adds: Ad = advertising-and-social spec.

| Ads/social UI surface | Backing flow | Specs | Covered |
|---|---|---|---|
| Campaigns table + live creative (Meta/Google/TikTok/ads) | ad_campaign object model + creative | Ad(§1,§4) | ✅ |
| "Approve $400/day" / ad-budget approvals | spend = proposal (money boundary) | Ad(§1),G,HITL | ✅ |
| Budget adjuster + ad-spend cap guardrail | pacing engine inside Policy ceiling | Ad(§3),C | ✅ |
| "budget-capped by early afternoon" / auto-pause | real-time pacing + auto-pause | Ad(§3) | ✅ |
| Daily+monthly ceiling + ROI floor rules | ad-spend automation rules | Ad(§3),G | ✅ |
| ROAS / CAC / channel-comparison / heatmap | ad_metric ingestion + normalization | Ad(§2),D | ✅ |
| PMax / Meta retargeting / TikTok UGC / LinkedIn | per-platform ad adapters | Ad(§1),I | ✅ |
| Connect an ad platform | authority change (two-person) + allowlist | Ad(§1),S,G | ✅ |
| Ad/email/social creative (AI visual, headline/CTA) | creative production service | Ad(§4) | ✅ |
| Media eval gate (brand/safety/IP/claims/CAN-SPAM/AI-label/a11y) | media eval gate service | Ad(§4),G(§5) | ✅ |
| Regenerate creative (metered) | media-gen orchestration + metering | Ad(§4),B | ✅ |
| Organic social publishing (Ayrshare, IG/TikTok/founder POV) | social publishing service | Ad(§5),I | ✅ |
| Organic engagement KPIs | social_metric rollups | Ad(§5) | ✅ |
| Conversion tracking (implied by ROAS/attribution) | Pixel/CAPI, consent-gated, PII-hashed | Ad(§6),S | ✅ |
| SEO/AEO pages + rewrites (Brand/Pricing sign-off) | content pipeline + sign-off | Ad(§7),G | ✅ |
| AI-answer citation (ChatGPT/Gemini/Perplexity "38% cited") | citation monitoring → seo_metric | Ad(§7) | ✅ |
| Site Experiments / CRO (canary → promote HITL) | reuses evolution gating | Ad(§8),G(§4) | ✅ |

**Zero unmapped ads/social surfaces.** All spend is proposal-or-rule + audited + reversible; pacing
never exceeds Policy; all creative passes the media eval gate; conversion tracking is
consent-gated + PII-minimized. *Empirical risks to validate in build:* pacing under ad-API lag, and
ad-conversion reconciliation vs. the incrementality model (`advertising-and-social.md` §2–3).

## Platform (LLM / DB / infra) coverage sub-matrix

Legend adds: MG = model-gateway, DP = data-platform, CD = compute-and-delivery,
OS = observability-and-sre, A9 = ADR-0009.

| Platform UI surface | Backing service | Specs | Covered |
|---|---|---|---|
| Model Gateway (routing 95/4/1, fallback, 1.9M tok/min) | model gateway routing + failover | MG(§1,§3),ADR-0005 | ✅ |
| Deflection 40% / semantic cache 22% / prompt cache 71% | three cache tiers | MG(§1),DP(§4) | ✅ |
| Self-trained canary serving / provider fallback | GPU serving + failover | MG(§2–3),OS(§6) | ✅ |
| Agent memory retrieval at 10⁹–10¹⁰ vectors | vector tier (pgvector + dedicated) | A9,DP(§3) | ✅ |
| Service health & SLO (p95 280ms, 99.98%) | SLO/alerting | OS(§2),Cap | ✅ |
| Auto-heal & scale ("scaled 12→28 cells") | autoscaling + self-heal | CD(§2,§6),OS(§3) | ✅ |
| Event Center (auto-remediation, MTTR) | telemetry pipeline + monitors | OS(§1–3),E | ✅ |
| Security/SOC counters | security observability + SIEM | OS(§4),S | ✅ |
| Audit 3.1M/day + Run traces 87M/day ingestion | async ingestion off bus | OS(§1),DP(§1) | ✅ |
| Environments (Production/Staging) | CI/CD + environments | CD(§5) | ✅ |
| Cost stack: infra (GKE/CloudRun/PG/GCS/observability) | compute topology + cost meter | CD(§1),C | ✅ |
| Cost stack: eval & training (H100/A100) | GPU eval/training infra | OS(§6) | ✅ |
| DR / backup / RTO-RPO | backup/restore/DR | DP(§2),OS(§5) | ✅ |
| Data residency (US / EU-per-tenant) | per-region adapters + networking | DP,CD(§3),ADR-0001 | ✅ |

**Zero unmapped platform surfaces.** Tenant isolation holds across OLTP/vector/cache/OLAP; no CI/CD
path lets an agent self-deploy; caches/replicas/OLAP are never money/audit truth. *Empirical risks
(unchanged, `capacity-model.md` §6):* req/s linearity, per-action cost + tier mix, vector economics,
distributed-Postgres restore times.

## Cost-optimization coverage sub-matrix

Legend adds: CO = cost-optimization, A10 = ADR-0010.

| Cost UI surface / lever | Backing design | Specs | Covered |
|---|---|---|---|
| FinOps cost stack (8 categories, MTD vs budget) | per-category metering | C,CO(§1) | ✅ |
| Model-gateway cost levers (deflection/cache/routing) | tier + cache tiers | MG,CO(§1) | ✅ |
| "Vertex committed-use commitment" approval | capacity-commitment strategy | A10,CO(§2) | ✅ |
| Spot/preemptible for eval & training | workload placement | A10,CO(§1–3),OS | ✅ |
| Scale-to-zero / autoscale (auto-heal "12→28 cells") | elastic compute | CD,CO(§3) | ✅ |
| Storage cost tiering / retention | partition tiering + cold storage | DP,CO(§1) | ✅ |
| Egress as a cost line | egress cost lever | CO(§1) | ✅ |
| Right-sizing / bin-packing | infra levers | CO(§1,§3) | ✅ |
| Media (Veo/Imagen) cost | draft-cheap-first + caps | CO(§1),Ad | ✅ |
| Cost circuit-breaker / unbounded-consumption ceiling | guardrail | C,CO(§5) | ✅ |
| Contribution margin per account / outlier flag | unit-economics guardrails | C,CO(§5),PRICING | ✅ |
| "raise platform budget" approval | governed cost boundary | C,CO(§4),HITL | ✅ |
| Cost/efficiency eval (≥85) gates cost regressions | eval gate | G,CO(§4) | ✅ |

**Cost is a first-class, governed, metered concern with a continuous optimization loop.** *Not
claimed as "optimized":* the constants that prove minimal cost (per-action cost, tier mix, cache hit
rates, vector $/query, commitment utilization) are **empirical go/no-go items** validated in the build
(`capacity-model.md` §6), not in design.

## Identity & access (authN/authZ) coverage sub-matrix

Legend adds: IAM = identity-and-access, A11 = ADR-0011.

| Auth UI surface | Backing design | Specs | Covered |
|---|---|---|---|
| Merchant login (owner signed in) | Shopify-embedded session-token exchange | A11,IAM(§1) | ✅ |
| Merchant 2FA required / SSO-SAML (Enterprise) | passkey/TOTP + SSO adapter | IAM(§1,§3) | ✅ |
| Admin "Continue with SSO" + phishing-resistant MFA | SSO + passkey/hardware key | IAM(§1,§3) | ✅ |
| Step-up for sensitive actions | policy-driven step-up (short-TTL authLevel) | IAM(§1–2) | ✅ |
| Merchant roles matrix (5) + can-approve | RBAC in the PDP | IAM(§2),D | ✅ |
| Admin roles matrix (8) + approve domains | RBAC in the PDP | IAM(§2),D | ✅ |
| Role-gated nav / ask-bar inherits matrix | single PDP, default-deny | IAM(§2),S | ✅ |
| New operators read-only until passkey enrolled | enrollment gate | IAM(§4) | ✅ |
| Revoke session / sign-out-all / sessions list | session store + revocation | IAM(§1,§8) | ✅ |
| Session timeout | idle + absolute timeout | IAM(§1) | ✅ |
| Two-person + maker-checker | two distinct stepped-up principals | IAM(§2),G | ✅ |
| API keys (shown once) | scoped/hashed/rotatable/revocable keys | IAM(§5) | ✅ |
| Users & Roles: invite / role change (audited) | account lifecycle | IAM(§7) | ✅ |
| SSO/SCIM (org settings) | SAML/OIDC + SCIM provision/deprovision + group→role | IAM(§3) | ✅ |
| Break-glass / JIT privileged access | time-boxed, two-person, audited | IAM(§4) | ✅ |
| Agent scoped/revocable tool credentials | issueScopedCredential + autonomy ceiling | IAM(§6),R | ✅ |

**Zero unmapped auth surfaces.** Authorization is server-side default-deny at one PDP; revocation
fails closed and is strong-consistency; no principal (user, API key, agent) can escalate its scope.

## Result

**Zero unmapped screens or load-bearing behaviors.** Every detail in the finalized UI/UX has a named
backing entity, endpoint, event source, and owning spec. Items that remain *empirical* rather than
*structural* (per-action cost, tier mix, req/s, vector economics) are tracked as go/no-go conditions
in the capacity model §6 — they are not coverage gaps.
