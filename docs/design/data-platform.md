# Design Spec — Data Platform (operations, vector, cache, analytics)

_The operational design behind `storage` + `vector` (ADR-0004, ADR-0009) and the read/analytics
layers. Backs the row/vector volumes in `capacity-model.md` and the DR targets. Builds on
`data-model-and-tenancy.md` (entities, partitioning, isolation) — this spec adds how the data tier is
**run**._

**Prime invariants:** tenant isolation holds across every layer (OLTP, vector, cache, OLAP);
money/audit truth lives only in the transactional store; every layer is residency-aware.

## 1. Transactional store operations (distributed Postgres, ADR-0004)

- **Sharding/partitioning:** shard by `merchant_id`; hot append tables (`message`, `event`,
  `audit_entry`, `run_trace`, `usage_ledger`) time-partitioned within tenant; old partitions tiered to
  cheap storage or dropped per retention (7-yr audit; 90-day traces; 12/24/36-mo customer data).
- **Migrations:** online, backward-compatible, expand-contract; applied per-shard by the adapter;
  reversible and flag-gated (`compute-and-delivery.md`).
- **Connection management:** pooled (server-side pooler) sized to the stateless worker fleet; workers
  are ephemeral (ADR-0005) so pooling, not per-worker connections, is the norm.
- **Read replicas:** read-heavy console/report queries routed to replicas; RLS/tenant scoping applies
  on replicas too. **Authorization-relevant reads go to the primary / strong-consistency path** —
  RBAC role/permission state, policy rows, and **credential/grant revocation** must never be served
  from a lagging replica (stale-authz); revocation **fails closed** (deny on staleness). Money/audit
  reads that need strong consistency likewise go to primary.

## 2. Backup, restore, DR (concrete targets)

- **Backups:** continuous WAL/point-in-time + periodic full, per shard, encrypted (KMS/CMEK),
  residency-pinned. **Restores are tested** on a schedule (not assumed).
- **Targets:** money/audit data **RPO ≤ 5 min, RTO ≤ 1 h**; other tenant data **RPO ≤ 1 h, RTO ≤ 4 h**
  (starting targets — validate against restore times at 10¹⁰–10¹¹ rows, `capacity-model.md` §6).
- **Blast radius:** the tenant-keyed layout scopes a restore/incident to a shard, not the fleet.
- **Audit integrity:** the hash chain (`governance-subsystems.md` §6) makes a restored audit log
  tamper-evident end-to-end.

## 3. Vector tier (ADR-0009)

- Two-tier per tenant class: **pgvector co-located** for the long tail; **dedicated ANN store behind
  the `vector` port** for whales. Per-tenant namespaces; no cross-namespace query; per-namespace
  erasure. Sizing, index type, and the promotion threshold are set from measured cost/recall
  (`capacity-model.md` §6), not assumed.

## 4. Cache tier (hot reads + projections)

- **In-memory cache (Redis/Memcached-class) behind a port**, tenant-keyed, for: live counters/
  projections (ADR-0006), hot session/config reads, rate-limit counters, and the model gateway's
  semantic-cache index (`model-gateway.md`). **Cache is never the source of truth** for money/audit;
  it is invalidated off the event bus. The cache tier **inherits KMS/CMEK at-rest encryption and
  residency pinning** (`docs/SECURITY.md` §3) — it holds projections and answer text that can contain
  PII, so it is not exempt from the standard at-rest controls. Kill-switch/halt state uses a fast always-available read here
  (runtime spec §6) but fails safe if unavailable.

## 5. Analytics / OLAP mirror

- The **de-identified, k≥50 cross-tenant pipeline** (`data-model-and-tenancy.md` §5) and fleet-wide
  reporting feed a **separate OLAP store behind a port** (evaluate BigQuery-class *as an adapter*, or
  a portable warehouse) — never a live cross-tenant join on the OLTP tables. Benchmarks, fleet
  learning, and business-monitor aggregates read from here.
- Raw PII never lands in OLAP; only de-identified/aggregated data crosses the boundary.

## 6. Invariants (tests)

1. RLS/tenant scoping holds on primary, replicas, vector namespaces, cache keys, and OLAP (no
cross-tenant path anywhere). **1a. Authz/RBAC/policy/revocation reads are strong-consistency
(primary); revocation fails closed on staleness — no replica serves stale authorization.** 2. Cache/
OLAP/replica are never the source of truth for money/audit; the cache tier is KMS/CMEK-encrypted at
rest and residency-pinned.
3. Restores are tested and meet the stated RPO/RTO (or the target is revised with evidence).
4. Erasure cascades across OLTP, vector, cache, projections, object store (redaction-in-place for
immutable audit/run-traces — `data-model-and-tenancy.md` §4). 5. Residency is enforced per layer.
6. Only de-identified (k≥50) data enters OLAP.
