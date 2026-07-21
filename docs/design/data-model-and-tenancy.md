# Design Spec — Domain Data Model & Tenancy

_Backs every screen in both consoles. Storage tier and shard key per ADR-0004; isolation per
`docs/SECURITY.md` §2. This is the entity/relationship contract the `backend-builder` implements
against; exact DDL is produced at build time._

## 1. Tenancy model

- **Tenant = merchant store** (`merchant_id`). It is the leading key on every merchant-plane table
  and the shard/partition key (ADR-0004). PalUp-plane data (prospects, PalUp's own agents, platform
  policy) is keyed by `org` and is a separate logical tenant.
- **Isolation (the most-tested control):** row-level security scoped by `merchant_id` on every
  merchant table; agents and console sessions receive **tenant-scoped, revocable credentials**;
  memory (`vector`) and object storage are namespaced per tenant. No shared mutable state that can
  leak across tenants. Enforced in code, asserted by `test-engineer`, blocked on any cross-tenant
  path by `security-reviewer`.
- **Residency:** `merchant.region` (US at launch, EU-per-tenant on the roadmap) selects the
  storage/vector/comms adapter region. Because tenant data is co-located by `merchant_id`, residency
  is a routing decision, not a schema change (ADR-0001, ADR-0004).
- **Cross-tenant data (benchmarks, fleet learning)** never comes from a live cross-tenant join. It
  flows through a **de-identified, aggregated pipeline with k ≥ 50** into a separate analytics store
  (see §5). Three data classes are kept explicitly distinct (the mockups depend on this): (a)
  first-party merchant/shopper data, (b) PalUp prospect records, (c) k-anonymized cross-store
  benchmarks.

## 2. Core entities (grouped; keys and the large/hot ones flagged)

**Identity & tenancy**
- `merchant` (id, domain, plan, region, status, shopify_shop_id, created_at) — root tenant row.
- `user` / `membership` (merchant_id, role) — 5 merchant roles (Owner/Admin/Marketing/Viewer/
  Billing); RBAC "can approve" flags.
- `org_operator` / `operator_role` — 8 admin roles (Super Admin, SRE, FinOps, Growth, Security,
  Support, Compliance/Legal, Auditor); passkey/hardware-key enrollment state.

**Commerce (mirrored from Shopify; Shopify is system of record)**
- `customer` **[largest table — ~10^10 rows at target]** (merchant_id, shopify_customer_id, lifecycle
  stage, ltv, orders_count, consent flags, region). Partitioned by `merchant_id`; secondary indexes
  on (merchant_id, lifecycle), (merchant_id, ltv).
- `order` **[hot/large]** (merchant_id, shopify_order_id, value, status, placed_at). Time-partitioned
  within tenant.
- `product`, `cart` / `abandoned_cart` **[hot]** (merchant_id, state, value, reason_cohort).

**Conversations & agency**
- `conversation` / `message` **[hot/large — billions/yr]** (merchant_id, channel [live-chat/email/
  sms], customer_id, direction, status, csat). Time-partitioned within tenant.
- `segment` (merchant_id, definition, auto-discovered flag) + `segment_membership` — the 20
  auto-clustered segments; membership is large, recomputed off events.
- `agent_memory` (merchant_id, subject_ref, fact, source_provenance [stated/inferred/order/consent/
  support/network], confidence, verified_by_outcome, pinned) — structured facts; the **vector
  embeddings** for retrieval live in the `vector` store, namespaced per tenant.
- `campaign`, `sequence`, `sequence_step`, `upsell_offer`, `recovery_play` — the Growth surfaces.

**Agents (declarative bundles, ADR-0002)**
- `agent` (merchant_id or org, role, policy_ref, tools[], memory_ref, model_tier, autonomy_level).
- `agent_version` — incumbent + candidates (ties to Evolution).

**Governance (control plane — see governance-subsystems spec for state machines)**
- `proposal` **[hot]** (merchant_id/org, type, risk, impact_amount, source, expiry, expiry_behavior
  [fail-closed / never-expires / standing], why_you, basis, blast_radius, cost_of_delay, rollback,
  confidence, provenance, draft_payload, adjuster_bounds, status, two_person_flag).
- `automation_rule` (scope, limits, owner_role, blast_radius, active, used_30d).
- `policy` (deterministic hard limit: what it bounds, meter, threshold, when-exceeded, owning role).
- `audit_entry` **[largest append-only — ~3.1M/day]** (actor+role+kind, action, target_tenant,
  category, result, sensitivity, before→after diff, event_hash, prev_hash → hash-chained,
  ts). Time-partitioned; 7-yr retention with tiering.
- `killswitch_state` (scope [global/agent-type/merchant], armed, by, at) — read on every run.
- `evolution_candidate` + `evolution_stage_record` (stage, metrics, holdout_delta, canary_result,
  decision, approver, rollback_pointer); `eval_run` + `eval_suite_result` (7 suites, secret-holdout
  delta); `fleet_pattern` (k, lift, confidence).
- `run_trace` **[largest by volume — ~182k runs/day × steps]** (merchant_id/org, agent, trigger,
  outcome, cost, latency, steps[perceive/recall/plan/guardrail/act], per-step tier/tokens/cost/
  verdict). 90-day retention, sampled into the eval golden set.

**Money**
- `outcome_ledger_entry` (merchant_id, period, attributed_incremental_revenue, control/holdout ref,
  method, confidence) — the fee basis (ADR-0007).
- `usage_ledger_entry` **[hot/large]** (merchant_id, action, credits, billable|absorbed, cost_cogs,
  category, ts) — the credit meter.
- `invoice` (merchant_id, period, base, performance_fee, overage, status, shopify_invoice_ref).
- `spend_budget` / `spend_cap` (tenant + platform; warn %, hard cap; COGS vs GTM buckets).

**PalUp growth plane**
- `prospect` (org, icp fields, funnel stage, channel, consent) — stitched to `merchant` on Shopify
  OAuth (domain + owner email); the signup conversation/goal is carried across.
- `growth_campaign`, `growth_sequence`, `experiment` (CRO), `deal` (subscription pipeline).

**Analytics / read models**
- Per-tenant **projections** for live counters and dashboards (ADR-0006), rebuilt from events.
- `metric_rollup` (tenant/org, metric, window) for KPI tiles.

## 3. Large-table strategy (the scale crux)

| Table | Order of magnitude @ target | Strategy |
|---|---|---|
| `customer` | ~10^10 rows | Shard/partition by `merchant_id`; per-tenant sub-indexes; archival of dormant customers to cold tier |
| `message` | billions/yr | Partition by `merchant_id` + time; hot window online, older tiered/dropped per retention |
| `order` | billions | Partition by `merchant_id` + time |
| `audit_entry` | ~3.1M/day, 7-yr | Append-only, hash-chained, partitioned by time; older partitions to cold, tamper-evident export |
| `run_trace` | ~182k runs/day × ~4.3 steps | Partition by time; 90-day retention; sampled to eval set; forensic by-id (no fleet-wide scroll) |
| `usage_ledger_entry` | per billable action | Partition by `merchant_id` + billing period; rolled up per cycle |
| `agent_memory` + vectors | per-tenant, grows with tenure | Structured rows in `storage`; embeddings in `vector`, per-tenant namespace, sized in capacity model |

Design rules: no unbounded fleet-wide scans in the transactional path; big lists are always
tenant-scoped + cursor-paginated + searchable ("showing N of M / scroll loads more" in the UI);
fleet-wide analytics run off the de-identified analytics store, not the OLTP tables.

## 4. Provenance, consent, retention, erasure (compliance-driven)

- **Provenance** is first-class on `agent_memory` and customer facts (stated/inferred/order/consent/
  support/network) — the Customer-360 and Agent-Memory screens render and let users edit/delete a
  fact (CCPA).
- **Consent** flags on `customer` (email/SMS) gate every send; TCPA/CAN-SPAM enforced at send time
  (see comms integration + security specs).
- **Retention**: configurable per merchant (12/24/36 mo customer data); audit 7 yr; run traces 90
  days.
- **Export & erasure**: frictionless export (CSV/JSON) and right-to-be-forgotten are first-class
  (`docs/STICKINESS.md`, ADR-0001) — tenant-keyed layout makes per-tenant export/delete tractable.

## 5. De-identified cross-tenant pipeline (benchmarks + flywheel)

Events → de-identification → aggregation with **k ≥ 50** minimum cohort → analytics store that backs
Benchmarks (merchant side) and Fleet Learning / Evolution proposals (admin side). No raw PII, no
per-merchant identifiability, no live cross-tenant join. Fleet patterns enter the evolution pipeline
as proposals (proposer ≠ evaluator; secret holdout) — they never auto-apply.

## 6. Open items for build-time

- Exact DDL, index tuning, and partition sizing (informed by the capacity model).
- pgvector-vs-dedicated `vector` decision and per-tenant index sizing (capacity model).
- Analytics store engine (OLAP mirror) selection behind a port.
