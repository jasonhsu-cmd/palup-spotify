# ADR-0009: Vector store at scale (behind the `vector` port)

- **Status:** Accepted
- **Context:** Agent memory retrieval uses embeddings behind the `vector` port
  (`data-model-and-tenancy.md`, `port-interfaces.md`). At target scale this is **10⁹–10¹⁰ vectors**
  across **millions of per-tenant namespaces**, growing with tenure — and it is cost- and
  latency-sensitive (it sits in the Recall step of every agent run, ADR-0005). `data-model-and-tenancy.md`
  §6 and `capacity-model.md` §6 left the engine choice (pgvector vs. a dedicated store) as an open
  item. This ADR closes it without breaking ADR-0001 portability.

## Decision

1. **Keep the `vector` port; make the engine a two-tier, config-driven choice per tenant class.**
   - **Small/low-tenure tenants → `pgvector` co-located in the tenant's Postgres shard** (ADR-0004).
     No extra system, memory reads join naturally with structured `agent_memory`, and per-tenant
     isolation is inherited from the shard. This covers the long tail cheaply.
   - **Large/high-tenure tenants → a dedicated ANN store** (evaluate Vertex Vector Search /
     Milvus/Qdrap-class self-run on GKE), **still behind the `vector` port**, chosen for recall + $/query
     at high vector counts.
   The port hides which tier a namespace uses; promotion from pgvector → dedicated is an operational
   migration, not a code change.
2. **Namespace = tenant; no cross-namespace query** (unchanged). Right-to-erasure is per-namespace/id.
3. **Embeddings are produced through the `model` port** and written via a batch **embeddings
   pipeline** (`model-gateway.md`); the vector store only indexes/serves.
4. **Cost + recall are gated metrics.** Per-tenant vector cost feeds the COGS meter
   (`cost-margin-telemetry.md`); recall quality is part of answer-accuracy eval. A dedicated store is
   adopted only where it beats pgvector on the cost/recall/latency envelope for that tenant class.

## Alternatives considered

- **pgvector everywhere.** Simplest, fully co-located, zero new system. Rejected as the *sole* answer
  — at 10⁹–10¹⁰ vectors the largest tenants need purpose-built ANN indexing for recall/latency/cost;
  but pgvector is retained for the long tail.
- **One dedicated vector store for the whole fleet (single global index).** Rejected — breaks
  per-tenant isolation and residency, and a single global index is a blast-radius and noisy-neighbor
  risk.
- **A Google-only managed vector service wired directly into feature code.** Rejected — violates
  ADR-0001; a managed service is fine *as an adapter behind the port*, not as a hard dependency.

## Consequences

- (+) Cheap for the long tail (pgvector, no new infra), performant for whales (dedicated ANN), both
  portable behind one port; residency + isolation preserved.
- (+) The engine can change per tenant class or over time without touching feature/agent code.
- (−) Two operational paths to run and keep behavior-equivalent; the `vector` contract test must
  cover both, and the promotion migration must be safe and reversible.
- (−) Vector economics remain an **empirical go/no-go item** (`capacity-model.md` §6) — the tier
  thresholds are set from measured cost/recall, not assumed here.
