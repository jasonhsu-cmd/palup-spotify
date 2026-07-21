# Design Spec — Console API Contracts

_The API the two React consoles (ADR: React SPA per console, `docs/ARCHITECTURE.md` §4.3) consume.
One **console-API** service (Cloud Run) fronts both, RBAC-scoped per session. Read models/counters
come from projections; live updates via SSE/WebSocket (ADR-0006). Exact OpenAPI is generated at
build time; this fixes the shape, conventions, and per-screen resource map._

## 1. Conventions

- **Auth:** SSO (SAML/OIDC) + passkey/MFA; short-lived session tokens; **step-up** required for
  sensitive actions (approvals above a threshold, policy edits, kill-switch, authority changes).
- **Tenant + role context** on every request; server-side RBAC (5 merchant / 8 admin roles) — the
  API never returns data a role can't view, and reads never perform writes (mirrors the ask-bar
  rule).
- **Large lists:** cursor pagination (`?cursor=&limit=`) + server-side filter + search; responses
  carry `total` for "showing N of M". No offset paging on the 10^10-row tables.
- **Writes** that could cross a HITL boundary do **not** mutate directly — they create or advance a
  `proposal` (governance spec §3). The API surface reflects this: money/model/business-model
  endpoints are proposal endpoints, not direct mutations.
- **Live:** `GET /stream` (SSE) per session for tenant/role-scoped events; `/chat/:id/takeover`
  (WebSocket) for live-chat.
- **Bulk PII export** endpoints (`POST /memory/export`, customer CSV/JSON export, `GET /audit`
  export) are **step-up-required and audited** — they move personal data in bulk even though a human
  initiates them. (No run-time *agent* tool performs bulk export at all — security spec §1/§3.)
- Standard errors, idempotency keys on POST, ETag/If-Match on edits.

## 2. Merchant API (resource groups → screens)

| Resource | Key endpoints | Screen(s) |
|---|---|---|
| `dashboard` | `GET /home/summary`, `GET /revenue/series?range=` | Revenue Home |
| `memory` | `GET /memory?tab=&cursor=`, `POST /memory` (teach), `POST /memory/export` | Agent Memory |
| `inbox` | `GET /inbox/needs-you?filter=`, `GET /threads/:id`, `POST /threads/:id/{approve,reject,takeover,rule}` | Inbox |
| `customers` | `GET /customers?segment=&cursor=&q=`, `GET /customers/:id`, `POST /segments`, `PATCH /customers/:id/facts` | Customers / 360 |
| `recovery` | `GET /recovery/funnel`, `GET /recovery/carts?cohort=&cursor=`, `POST /recovery/:id/{approve,edit,takeover}` | Cart Recovery |
| `campaigns` | `GET /campaigns`, `POST /campaigns/brief`, `GET /campaigns/:id/creative`, `POST /campaigns/:id/submit` | Campaigns / Builder |
| `outreach` | `GET /sequences`, `POST /sequences/:id/{pause,edit}` | Outreach |
| `upsell` | `GET /upsell`, `POST /upsell/:id/adjust` (bounded by margin floor) | Upsell |
| `orders` | `GET /orders?cursor=`, `GET /orders/intel` | Orders |
| `payments` | `GET /payments/cycle`, `GET /payments/account` | Payments & Payouts |
| `approvals` | `GET /approvals?source=&group=&q=`, `POST /approvals/:id/{approve,approve-rule,edit,reject,takeover,sendback,undo}`, `POST /approvals/batch` | Approval Center |
| `rules` | `GET /rules`, `POST /rules`, `PATCH /rules/:id`, `DELETE /rules/:id` | Automation Rules |
| `controls` | `PATCH /agent/controls` (channels/autonomy), `POST /agent/emergency-stop` | Agent Controls |
| `benchmarks` | `GET /benchmarks` (k≥50 aggregates) | Benchmarks |
| `billing` | `GET /billing/usage`, `GET /billing/invoices`, `GET /plans` | Billing / Plans |
| `settings` | `GET/PATCH /settings/{store,agent,team,compliance,privacy,security}`, `GET /audit?cursor=&actor=&q=` | Settings / Audit |
| `widget` | `GET/PATCH /widget/config` | Live Chat Widget |
| `ask` | `POST /ask` (RBAC-scoped Q&A) | Ask Aria |

## 3. Admin API (role-gated; resource groups → screens)

| Resource | Key endpoints | Screen(s) |
|---|---|---|
| `home/business` | `GET /home` (role-aware), `GET /business/{funnel,cohorts,retention,moat}` | Home / Business Monitor |
| `finops` | `GET /finops/{margin,spend,plans,coststack}`, `POST /finops/budget/proposal` | FinOps & Margin |
| `growth` | `GET /growth/*`, `GET /prospects?cursor=&q=`, `GET /gcampaigns`, `GET /experiments`, `GET /deals`, `GET /expansion` | Growth suite |
| `approvals` | as merchant, admin sources; **two-person** on authority/security/pricing/model | Approval Center |
| `rules` | admin rule scopes + maker-checker flags | Automation Rules |
| `engineering` | `GET /eng/{slos,gateway,autoheal}` | Engineering Monitor |
| `events` | `GET /events?status=`, SSE | Event Center |
| `security` | `GET /security/{threats,coverage,accounts}` | Security / SOC |
| `killswitch` | `POST /killswitch/{global,capability,tenant}` (step-up + two-person on global) | Kill Switch |
| `evolution` | `GET /evolution?scope=&class=`, `GET /evolution/:id`, `POST /evolution/:id/{signoff,rollback}` | Evolution Console |
| `evals` | `GET /evals/suites`, `GET /evals/candidates/:id` | Eval Dashboard |
| `policy` | `GET /policy`, `PATCH /policy/:id` (owning role + step-up) | Policy & Guardrails |
| `audit` | `GET /audit?category=&actor=&cursor=`, `GET /runs/:id` | Audit Log / Run Replay |
| `rbac` | `GET /operators`, `POST /operators/invite`, `PATCH /operators/:id/role` (audited) | Users & Roles |
| `settings` | `GET/PATCH /org/settings/*` (role-filtered) | Settings |

## 4. Cross-cutting

- Every list endpoint on a large table is cursor-paginated + searchable; every live counter is a
  projection read. Every boundary-crossing POST is a proposal, audited. Every response is RBAC- and
  residency-scoped. This contract is what the UI→backend coverage matrix checks against.
- **Payment/adjustment endpoints are proposals, not direct money mutations.** Refunds/disputes
  (merchant), SLA credits, write-offs, custom/below-floor fees, and budget/cap changes (admin) create
  or advance a `proposal` (or auto-apply only within an Automation Rule); above-rule and
  disputed/contested amounts always route to a human, and money-tool grants are two-person. Read
  endpoints (`/payments/*`, `/billing/*`, `/finops/*`) are reporting views over the ledgers and the
  per-cycle reconciliation report. See `docs/design/payments-and-billing.md`.
