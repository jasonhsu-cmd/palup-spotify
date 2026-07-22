# ADR-0004: Storage tier at scale — portable, distributed Postgres

- **Status:** Accepted
- **Context:** The scale target is ~millions of merchants, each with up to ~tens of thousands of
  customers — order **10^10 customer rows**, plus billions of messages/events and billions of
  audit and agent-run-trace records per year (the admin console alone shows ~3.1M audit events/day
  and ~182k runs/day). `docs/ARCHITECTURE.md` §4.4 and the FinOps cost stack name a single **Cloud
  SQL Postgres**. A single Cloud SQL instance cannot hold this volume or sustain the write rate,
  and vertical scaling ends well short of the target. We need horizontal scale while keeping the
  portability posture (ADR-0001 / `CLAUDE.md` §3.3). The operative rule is **not** "no Google
  service" — leveraging Google managed services now is the endorsed, practical short-term choice — it
  is **"no Google-only API leaking into feature code, and a real alternative kept viable so migration
  stays feasible."** A Postgres-compatible engine — including a **managed** one that exposes the
  Postgres dialect — satisfies this behind the `storage` port.

## Decision

Access all transactional/relational data through the existing **`storage` port**, backed by a
**horizontally-scalable, Postgres-compatible engine** — evaluate **Google Cloud Spanner via its
PostgreSQL interface** (lowest-ops managed option) alongside **YugabyteDB / CockroachDB / a
Citus-class engine** (self-run/portable alternatives), managed or self-run on GKE. The engine choice
stays behind the port and is selected at integration time against the contract tests below.

1. **Tenant is the shard/partition key.** `merchant_id` (tenant) is the leading key on every
   large table. Co-locating a tenant's rows keeps almost all queries single-shard, gives natural
   blast-radius isolation, and makes per-tenant residency (US, EU) and per-tenant export/erase
   tractable. Cross-tenant reads (benchmarks, fleet learning) go through a **separate, de-identified,
   k≥50-aggregated** path (see the data-model spec), never a live cross-tenant join.
2. **Partition the hot, append-heavy tables by time within tenant** — `message`, `event`,
   `audit_entry`, `run_trace` — so old partitions can be rolled to cheaper tiers or dropped per the
   retention policy (7-yr audit; 90-day run traces).
3. **Vectors behind the `vector` port**, per-tenant namespaced; sizing and the pgvector-vs-dedicated
   decision live in the data-model + capacity specs, not here.
4. **Postgres remains the semantic contract.** Feature code targets standard SQL + the `storage`
   port; no engine-proprietary feature leaks past the adapter.

## Alternatives considered

- **Single / vertically-scaled Cloud SQL Postgres (status quo).** Simplest; correct for early
  scale. Rejected as the *target* tier — it cannot hold 10^10 rows or the write rate, and offers no
  clean per-tenant residency story.
- **Google Cloud Spanner via its PostgreSQL interface (managed).** Best-in-class managed horizontal
  scale and the lowest ops burden at extreme scale, and — critically — accessed through the **Postgres
  dialect behind the `storage` port**, so feature code stays on the portable contract and no
  Spanner-only API leaks. **Accepted as a candidate** (consistent with the "Google managed services
  now, behind ports" posture). Guardrails: target the Postgres dialect only (no Spanner-proprietary
  features in feature code), pass the `storage` contract tests, and **keep a self-run alternative
  (YugabyteDB) viable in practice** so migration remains a real option, not a slogan. Revisit if
  data-migration lock-in or economics worsen. (This supersedes the earlier outright rejection.)
- **Sharded vanilla Postgres (many Cloud SQL instances, app-owned routing).** Fully portable and
  proven. Rejected as the default because tenant-range sharding, rebalancing, and cross-shard ops
  become application-owned complexity that a distributed engine solves natively — but it remains a
  valid `storage` adapter if the distributed engine's economics or ops disappoint.

**License + posture note (`docs/design/oss-and-licensing.md`):** two clean front-runners —
**Cloud Spanner** (managed, **no OSS-license constraint**, Postgres interface keeps it portable) for
lowest ops, and **YugabyteDB (Apache-2.0)** as the portable self-run alternative to keep viable.
**CockroachDB (paid Enterprise license) and Citus (AGPL-3.0)** are *Flag*-tier and need legal +
`security-reviewer` sign-off before adoption. The architecture is unchanged (portable Postgres
contract behind the `storage` port); this only ranks the candidates.

## Consequences

- (+) Scales horizontally on the largest tables while keeping ADR-0001 intact; a second cloud or
  region is an adapter + config, not a rewrite.
- (+) Tenant-keyed layout makes cross-tenant isolation (the most-tested control, `docs/SECURITY.md`
  §2), residency, and per-tenant export/erase natural rather than bolted on.
- (−) A **self-run** distributed SQL engine is operationally heavier than one Cloud SQL instance
  (topology, rebalancing, backup/restore at scale); managed **Spanner** removes most of that at the
  cost of the portability discipline above (Postgres-dialect-only + keep-alternative-viable). Accepted.
- (−) Some SQL patterns (large cross-tenant analytics) must move to the de-identified analytics
  path or an OLAP mirror, not the transactional store. Documented in the data-model spec.
- (−) The `storage` adapter needs **contract tests** proving behavior-equivalence (transactions,
  isolation level, RLS/tenant scoping, pagination semantics) so the engine stays swappable.
