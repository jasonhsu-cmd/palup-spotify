# Design Spec — Platform Port Interfaces

_Realizes ADR-0001 and the `portability-guard` skill. Feature and agent code depend **only** on
these ports; provider SDKs appear **only** inside `packages/platform-ports/<port>/adapters/*`.
Signatures below are the contract; exact TypeScript is finalized at build time. Every port ships a
**contract-test suite** so any adapter is behavior-equivalent and swappable._

## Conventions

- All calls carry a **tenant context** (`{ merchantId | org, region }`) so adapters can enforce
  residency and scoping; ports never expose provider-specific types.
- All ports surface normalized errors (`Retryable`, `RateLimited`, `NotFound`, `PermissionDenied`)
  — never a raw provider error.

## The nine ports

### `model` — LLM inference (Vertex/Gemini today; Claude via Model Garden as fallback)
```
generate(req: { tier: 'routine'|'high_stakes'|'canary', messages, tools?, maxTokens }): { text, toolCalls?, usage: { tokensIn, tokensOut, costEstimate } }
embed(req: { texts, model? }): { vectors, usage }
```
Tier → concrete model mapping lives in the adapter/config (not feature code). Emits usage for the
cost meter. Supports provider fallback behind the port (routing shown in the Engineering Monitor).
**The adapter enforces PII minimization/redaction before the request leaves for the provider** (the
egress-before-inference control, `security-data-path.md` §3) — symmetric with `comms` DLP. This is a
**required contract test**: an adapter that forwards un-redacted PII does not ship.

### `vector` — memory retrieval (per-tenant namespaced)
```
upsert(ns: TenantNs, items: { id, vector, metadata }[]): void
query(ns: TenantNs, vector, topK, filter?): { id, score, metadata }[]
delete(ns: TenantNs, ids | filter): void
```
Namespace = tenant; no cross-namespace query. Supports right-to-erasure by namespace/id.

### `queue` — event backbone + work queue (ADR-0005, ADR-0006)
```
publish(topic, event: { key: tenantKey, id, type, payload }): void
subscribe(topic, group, handler): Subscription   // at-least-once; per-key ordering; idempotent handlers
enqueueRun(run): void ; scheduleRun(run, at): void   // agent triggers + cadence timers
```
Events carry a tenant key; **handlers are constrained to their own tenant key** — a run processing an
event can only touch that event's tenant, so cross-tenant leakage can't occur via the queue.

### `storage` — transactional/relational (ADR-0004, distributed Postgres)
```
tx(fn): T                       // ACID transaction
query(sql, params, ctx): rows   // tenant-scoped via RLS/ctx
// migrations, partition mgmt, and RLS policy application are adapter concerns
```
Contract tests assert isolation level, RLS/tenant scoping, cursor pagination semantics, and
transactional guarantees so the engine (Cockroach/Yugabyte/Citus/sharded-PG) stays swappable.
**Fail-closed on missing tenant context:** the adapter **rejects** any query without a resolved
tenant/RLS session rather than silently widening scope — isolation must not depend on caller
discipline. This is a required contract test. (The constrained admin cross-tenant read path is
defined in `data-model-and-tenancy.md` §1.)

### `secrets` — secret material (KMS/Secret Manager)
```
get(ref): secret ; issueScopedCredential(scope, ttl): shortLivedCred ; rotate(ref): void
```
Never returns secrets to logs/prompts; issues short-lived, revocable creds for agents.

### `commerce` — Shopify first (orders/products/customers/fulfillment/OAuth/webhooks/billing)
```
oauthInstall(shop): tokens ; verifyWebhook(req): event ; getOrders/getCustomers/getInventory(ctx, cursor): page
createBillingCharge(ctx, plan|usage): shopifyInvoiceRef   // PalUp never holds money
```
Read-heavy operations are auto-allowed; anything moving money routes through HITL, not the port.

### `payments` — billing settlement (Shopify Billing adapter now; PSP-ready for future)
```
ensureSubscription(ctx, plan): subscriptionRef            // base plan → AppSubscription
submitUsage(ctx, subscriptionRef, batchId, amount): status // fee+overage → AppUsageRecord (idempotent on batchId, under cappedAmount)
getCapturedCharges(ctx, cycle): capture[]                 // for reconciliation vs ledgers
recordAdjustment(ctx, adjustment): void                   // credit / write-off / clawback (adjustment_ledger)
```
Provider-neutral: the Shopify Billing adapter maps these to `AppSubscription` / `AppUsageRecord` /
`AppPurchase` (ADR-0008); a future direct-PSP adapter can satisfy the same port. **No PAN storage**,
no fund custody (PCI minimization, `docs/SECURITY.md` §5). Contract tests assert idempotent usage
submission, cap enforcement, and reconciliation-shape parity so the adapter stays swappable. Full
semantics: `docs/design/payments-and-billing.md`.

### `comms` — outbound email/chat/SMS (SendGrid/SES, Twilio; consent-gated)
```
send(ctx, { channel, to, body, consentRef, templateRef?, approvalRef?, frequencyKey }): result
        // rejects unless consent + suppression + frequency + quiet-hours + rate + DLP pass;
        // AND rejects a non-template or out-of-frequency send that lacks a valid in-policy approvalRef
liveChat(ctx, session): duplex                          // take-over
verifyWebhook(req): inboundEvent                        // provider-signature verified; tenant resolved
        // from PalUp-provisioned resources (per-tenant number / signed reply token), NEVER from payload
```
Enforces CAN-SPAM/TCPA/A2P-10DLC + DLP/PII redaction at the boundary (see security spec). The full
ordered **pre-send gate** (consent → suppression → frequency → quiet-hours → rate → DLP → compliance
envelope), inbound pipeline (replies, delivery-status webhooks, deterministic SMS STOP/HELP/START),
deliverability (IP warmup, reputation, SendGrid↔SES failover), and live-chat transport are specified
in `docs/design/comms-and-messaging.md`. Contract tests assert the gate rejects (never silently
sends) and that opt-out suppresses before the next send.

### `telemetry` — metrics/traces/logs/cost (OTel/Grafana/Sentry)
```
metric(name, value, tags) ; trace(span) ; recordCost(ctx, category, amount) ; auditAppend(entry)  // hash-chained
```
Metrics/traces are best-effort and droppable. **`auditAppend` is not:** it must be **at-least-once
durable, committed with the action** (transactional outbox tied to the action's DB commit), so no
action can execute without its audit entry — "no silent action" (`CLAUDE.md` §3.5). Audit durability
is distinct from droppable telemetry even though both sit on this port.

## Marketing-plane ports (additive to the core nine, per ADR-0001's additive model)

These are first-class ports with their own contract-test suites; provider SDKs (Meta/Google/TikTok/
LinkedIn, Ayrshare, Pixel/CAPI) appear only in their adapters. Full semantics:
`docs/design/advertising-and-social.md`.

### `ads` — paid campaigns (Meta / Google incl. PMax / TikTok / LinkedIn)
```
launchCampaign(ctx, proposalRef, spec): campaignRef   // requires an approved proposal; sets platform-native hard caps
setBudget(ctx, campaignRef, budget, proposalRef?): status // increase requires proposal; platform daily+lifetime+account caps enforce the ceiling
pause(ctx, campaignRef): status                       // spend-reducing → auto-allowed
getMetrics(ctx, cursor): adMetric[]                    // spend/impr/clicks/conv/ROAS, normalized
```
Contract tests: tenant-scoping, residency, **launch/increase rejected without a valid approvalRef**,
platform hard-cap set on launch.

### `social` — organic publishing (Ayrshare)
```
schedule(ctx, post, when): postRef ; getEngagement(ctx, cursor): socialMetric[]
```
Least-privilege, revocable, per-tenant publish tokens via `secrets`; ingested engagement is untrusted.

### `tracking` — conversion signals (Meta Pixel/CAPI, Google Enhanced Conversions)
```
sendConversion(ctx, { event, consentRef, signals }): status
```
**Fail-closed contract test:** the adapter **rejects** any egress lacking `consentRef` or containing
un-hashed PII, and honors residency — symmetric with the `model` egress-before-inference test.

## Model tiering (via `model`, stays portable)

`routine` → fast tier (~95% of actions), `high_stakes` → strong tier (~4%), `canary` →
experimental variant (~1%, capped by the evolution pipeline). Quality-floor policy forbids
downgrading high-stakes steps to save cost (mockup FinOps note).

## Contract tests (per port, required before an adapter ships)

Each port has a suite that a new adapter must pass: functional parity, tenant-scoping/residency,
error normalization, retry/idempotency, and (for `storage`) isolation + pagination semantics.
Adapters that don't pass don't ship (`portability-guard`, ADR-0001 consequence).
