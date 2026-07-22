# Terms & Legal Provisions Brief

> ⚠️ **This is a brief for counsel — NOT legal advice, NOT a binding agreement, NOT executable terms.**
> It consolidates the legal positions the PalUp.ai product design already implies, so a qualified
> attorney and the **Compliance/Legal owner** (the 8th admin operator role) can draft and review the
> real instruments. Nothing here is authoritative; every provision must be validated, completed, and
> made jurisdiction-correct by a licensed lawyer before use. No agreements currently exist in this
> repo.

## 0. Why this brief exists

PalUp is a two-sided, autonomous, revenue-handling SaaS. Its design has already **decided many
substantive legal positions** (HITL boundary, no-funds-held billing, AI disclosure, frictionless
export/no-lock-in, kill switch, consent/CAN-SPAM/TCPA, residency, sub-processors). Capturing those
here gives counsel a strong starting brief rather than a blank page — and flags where design and
contract must stay consistent.

## 1. The instruments needed

| # | Instrument | Binds | Owner |
|---|---|---|---|
| A | **Merchant MSA / Terms of Service** | PalUp ↔ merchant | Legal + Product |
| B | **Shopper-facing notices** (AI disclosure, consent, widget terms) | Merchant ↔ its customers (PalUp-enabled) | Legal + merchant |
| C | **Data Processing Agreement (DPA)** | merchant (controller) ↔ PalUp (processor) ↔ sub-processors | Legal + Security |
| D | **PalUp Privacy Policy** | PalUp ↔ all | Legal |
| E | **Acceptable Use Policy (AUP)** | PalUp ↔ merchant | Legal + Trust/Safety |
| F | **SLA** (Pro/Enterprise) | PalUp ↔ merchant | Legal + SRE |
| G | **Enterprise Order Form / MSA addendum** | PalUp ↔ enterprise | Legal + Sales |
| — | **External compliance:** Shopify Partner Program / App Store / API License; ad-platform & comms-provider terms; model-provider terms | PalUp ↔ platforms | Legal |

## 2. A — Merchant MSA / Terms of Service (key provisions)

Each provision cites the design decision that dictates it.

- **Service description & trust-sequenced autonomy.** Assistive → supervised → autonomous AI sales
  partner. (`GTM.md` §2)
- **Agency grant & scope.** Merchant authorizes the agent to act on their Shopify store within a
  **defined, scoped, revocable** mandate; PalUp acts as the merchant's limited agent, not principal.
  (`ADR-0011`, `agent-runtime.md`)
- **HITL boundary (core).** Agent may act on reversible, in-policy, low-stakes actions; **anything
  touching money, pricing, marketing spend, business model, or the agent's own autonomy requires
  merchant approval**; **money actions are drafted by the agent and executed by the merchant in
  Shopify**. (`HITL-POLICY.md` §2)
- **Merchant controls & kill switch.** Merchant sets autonomy level, Automation Rules, and can
  **halt the agent instantly** at any scope. (`agent-runtime.md` §6, `governance-subsystems.md`)
- **Fees & billing.** Base + **performance fee on attributed *incremental* revenue measured against a
  control group** (methodology disclosed); credit overage; **spend cap** with graceful degradation;
  **billed via Shopify Billing — PalUp never holds, moves, or deducts funds and stores no card data**;
  **no lock-in, no exit fees**; **attribution-dispute process**. (ADR-0007/0008, `payments-and-billing.md`, `PRICING.md`)
- **Data ownership & portability.** Merchant **owns** its store/customer data and the agent's learned
  memory; **frictionless export (CSV/JSON) and right-to-erasure are free**; retention configurable;
  residency (US now, EU-per-tenant roadmap). (`STICKINESS.md`, `data-model-and-tenancy.md`, `SECURITY.md`)
- **IP.** PalUp retains platform/model IP; merchant retains brand/content; define **ownership/license
  of AI-generated creative** (recommend: merchant owns the output, PalUp licensed to improve the
  service on de-identified terms). (`MOAT.md`)
- **AI disclosure & responsibility allocation.** **AI is disclosed to end shoppers (locked); no
  medical/regulated claims (locked)**; agent outputs are assistance/drafts; **merchant is responsible
  for its products, prices, claims, fulfillment, and the lawful consent of its customer lists**.
  (`Settings → Agent` guardrails; `comms-and-messaging.md`)
- **Acceptable use (ref AUP).** No spam/manipulation/dark patterns; comply with CAN-SPAM/TCPA and
  obtain consent; merchant **warrants** it has consent for lists it connects. (`AGENT-GOVERNANCE.md` §5)
- **Warranties, disclaimers, liability, indemnities.** Warranty disclaimer on autonomous/AI outputs;
  **liability cap**; **merchant indemnity** for its products/claims/data/consent; **mutual IP
  indemnity**; carve-outs for confidentiality/data breach as counsel advises.
- **Security & compliance.** SOC 2 posture, breach-notification commitment, **DPA incorporated by
  reference**, sub-processor transparency. (`SECURITY.md`)
- **Suspension & termination.** Grounds (non-payment, AUP breach, legal risk); **data export window on
  exit**; survival clauses.
- **Changes to terms, governing law, venue, dispute resolution / arbitration & class-waiver** (as
  counsel advises for the target markets).

## 3. B — Shopper-facing notices (merchant's obligation, PalUp-enabled)

PalUp does **not** contract directly with the merchant's shoppers, but it must supply the mechanisms
and templates so the merchant can meet these:

- **AI-interaction disclosure** — "you're chatting with an AI assistant" (locked guardrail).
- **Messaging consent** — email/SMS **opt-in**, one-click **unsubscribe / STOP/HELP/START**, frequency
  and quiet-hours (TCPA/CAN-SPAM/A2P-10DLC). (`comms-and-messaging.md`)
- **Privacy notice / data use** and **CCPA/GDPR data-subject rights** (access, delete, opt-out).
- **Live-chat widget terms** (the `cdn.palup.ai/w.js` surface).
- **Responsibility line:** the merchant is the consumer-facing party; PalUp provides tooling +
  processing under the DPA.

## 4. C — Data Processing Agreement (key provisions)

- **Roles:** merchant = **controller**, PalUp = **processor**; downstream vendors = **sub-processors**.
- **Processing scope:** purpose, duration, categories of data (customer PII, orders, conversations,
  memory) and data subjects.
- **Sub-processor list + change-notice + objection right** — e.g. **Vertex/Google (model/cloud),
  Twilio (SMS), SendGrid/SES (email), ad/analytics/shipping vendors**; maintained publicly.
  (`integration-architecture.md`, `SECURITY.md`)
- **Security measures** — reference the technical controls (encryption/CMEK, tenant isolation, DLP,
  access control). (`security-data-path.md`)
- **Breach notification** — timelines meeting regulatory requirements.
- **Data-subject-rights assistance**, **deletion/return on termination** (ties to the erasure cascade,
  `data-model-and-tenancy.md` §4).
- **International transfer** — SCCs / adequacy mechanism; **residency** (US launch, EU-per-tenant).
- **Model-provider commitment** — **no training on PalUp/merchant data**; documented in the
  sub-processor terms. (`SECURITY.md` §2.7)
- **Model-specific retention** — some models carry provider-set retention that overrides ZDR
  preferences. Notably **Claude Fable 5 is a "Covered Model" with 30-day data retention (no zero-data-
  retention option)**; if adopted at run-time it must appear in the sub-processor exhibit with that
  retention term, and PII-minimization-before-inference becomes a hard dependency, not a nicety.
  Counsel should confirm this is compatible with the merchant DPA and EU-residency commitments before
  Fable serves any PII path. (`model-gateway.md` §2, `security-data-path.md` §2.7)
- **Audit rights** (report-based / on-cause).

## 5. D–G — the rest

- **D. Privacy Policy** — PalUp's own collection/use/retention/rights/cookies; consistent with the DPA.
- **E. AUP** — prohibited uses (spam, manipulation, illegal goods, prohibited claims), enforcement
  (suspension/kill switch), reporting.
- **F. SLA** (Pro/Enterprise) — uptime commitment (ties to the 99.98% SLO), **service credits** (ties
  to the SLA-credit flow in `payments-and-billing.md` §5), support response, exclusions.
- **G. Enterprise Order Form** — custom fee/commitment, SSO/SCIM, CMEK/BYOK, residency, DPA addendum,
  security questionnaire (SIG/CAIQ). (`SECURITY.md` §6)

## 6. External terms PalUp must itself comply with

- **Shopify Partner Program / App Store / Admin API License + Protected Customer Data requirements**
  — hard constraints on data handling, billing (Shopify Billing), and app behavior. **Non-optional.**
- **Ad-platform terms** (Meta/Google/TikTok/LinkedIn), **comms-provider terms** (Twilio A2P,
  SendGrid/SES), **model-provider terms** (Vertex/Anthropic/etc.) — flow-through obligations that must
  be reflected in the merchant MSA and AUP.

## 7. Consistency watch-list (design ↔ contract must not drift)

These are places where a contract term and a coded behavior must agree, or the company is exposed:

1. "No lock-in / free export" (STICKINESS) ↔ MSA must not add exit fees.
2. "PalUp never holds funds" (ADR-0008) ↔ MSA/DPA billing clauses.
3. "AI disclosed / no medical claims" (locked guardrails) ↔ shopper notices + AUP.
4. Attribution-as-fee-basis + control group (ADR-0007) ↔ fee clause + dispute process.
5. Right-to-erasure cascade (data-model §4) ↔ DPA deletion clause (incl. redaction-in-place for
   immutable audit).
6. Sub-processor list (integration-architecture) ↔ DPA sub-processor exhibit, kept in sync.
7. Consent/STOP mechanics (comms) ↔ shopper messaging-consent terms.

## 8. Next steps (for the Compliance/Legal owner + counsel)

1. Engage qualified counsel for the target markets (US launch; EU on the residency roadmap).
2. Turn §2–§5 into drafted instruments; reconcile against the §7 watch-list.
3. Confirm Shopify Partner/App Store terms compliance (§6) before App Store submission.
4. Stand up the Trust Center (DPA + sub-processor list + policies) per `SECURITY.md` §6.
5. Keep the sub-processor list and AUP as living documents versioned with the product.
