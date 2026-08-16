# CATALOG_RETRIEVAL at scale (ADR-0020 "A2") — design

**Status:** Draft for review — 2026-08-15. Author: build agent (brainstormed with jason.hsu).
**Governs:** the work to let a merchant's *full* catalog (>1000 SKUs, up to the ADR-0020 ~50k design
ceiling) be indexed and shown in `/chat` via `CATALOG_RETRIEVAL`.
**Builds on (does not overturn):** ADR-0020 (D2/D3/D4/D5), ADR-0001 (portability), ADR-0015 (erasure),
HITL-POLICY §5 + the proposed owner reclassification of `CATALOG_RETRIEVAL` (PR #295, **unmerged**).

---

## 1. Problem (verified 2026-08-14/15)

Today the shopper agent fetches the merchant's *whole* catalog into the prompt every turn. That path
hard-caps at 1000 products and, above it, degrades to an empty catalog — so a large store shows **nothing**.
`CATALOG_RETRIEVAL` (top-K retrieval) exists but does **not** fix this, for three verified reasons:

1. **The "vector store" is not a vector index.** The only Postgres adapter stores embeddings as `jsonb` and
   re-scores up to 5000 rows in app code (brute force, `postgres-vector-store.ts:44-62,94`). No pgvector/HNSW.
2. **The corpus rows carry no product data.** Each row is `id + embedding + {contentHash}` only
   (`catalog-index.ts:649-656`); render data (title/variant) comes 100% from the live full-catalog fetch,
   which is the thing that dies >1000 (`brain.ts:975-981,1009`; `shopify-grounding.ts:352-354`;
   `grounding-cache.ts:95-97`).
3. **Ceilings + throughput.** `MAX_INDEXED_PRODUCTS=1000` hard-refuses above it (`catalog-index.ts:121,445`);
   the fetch caps at 4 pages; embeddings run 1-per-request, serial, no timeout (`vertex-adapter.ts:241,331`).

**Most of the surrounding scaffolding already exists, built INERT** and merged (ProductFactsPort +
hydrate-by-ID, the VectorPort + brute-force adapter + corpus writer/reader + manifest pin, the QueuePort +
webhook/reconcile path, the eval/shadow runners). The gap is specific: a real ANN engine, a by-ID render
source, higher ceilings + batched embeddings, targeted freshness, and scale-grade eval/promotion controls.

## 2. Decisions

- **D-A — render source = payload-in-row (chosen).** The retrieval row carries the **stable** render fields
  (title, `variantId`, and any other stable card field) in its `metadata`; **price/availability stay in
  `ProductFactsPort`** (volatile, D2-fresh, hydrated by ID at serve time). Rationale: preserves the invariant
  that *actually* matters — a stale **price** can never come from the corpus (money/NN#1, the #157/#180
  lesson) — while removing the full-catalog dependency for stable text; it adds the least new surface (reuses
  the existing `VectorRecord.metadata` / `VectorMatch.metadata` channel) and rides the existing content-hash
  re-index. Rejected: (B) a separate stable-facts store (more ports/producers, no clear payoff here); (C) a
  live per-ID Storefront fetch per turn (provider round-trip + spend on the hot path).
- **D-seq — build order = S1 → S2 → S3 → S4** (below). S1 (the engine) is isolated, low-risk, and
  independently verifiable; it ships dark and unblocks the rest.
- **D-embed — one vector per product, no chunking/overlap.** A product is one short semantic unit; chunking
  fragments it and hurts retrieval. The embed input stays bounded to the model's **2048-token/text** limit;
  `autoTruncate:false` + the `statistics.truncated` guard make any overflow a loud error, never a silent
  partial vector (`vertex-adapter.ts:367,390`). See §6 for the field-richness knob.

## 3. Sub-project decomposition

| # | Sub-project | Delivers | Depends on |
|---|---|---|---|
| **S1** | pgvector-HNSW adapter behind `VectorPort` + real-pgvector CI | the scalable ANN engine (ships dark; brute-force stays the small-corpus fallback) | — |
| **S2** | Serving unlock: (A) payload producer + retrieval-aware serving (skip full fetch) + raise ceilings + batch/robust embeddings + pin `gemini-embedding-2`@1536 | a >1000-SKU store actually renders products in chat | S1 for >5k |
| **S3** | Freshness at scale: targeted (by-ID) reconcile + coalesce/debounce + deployed scheduler; tighten staleness ceiling to ≤15 min + fail-honest | ≤15-min freshness without full-catalog crawls per change | S2 |
| **S4** | Safe promotion: eval/shadow on real pgvector at scale + per-tenant enablement + retrieval-scoped kill | the evidence + controls the governance bar requires | S1–S3 + #295 merged |

Each sub-project gets its own implementation plan (writing-plans) and its own PR(s). **This document fully
specs S1**; S2–S4 are outlined in §6 and will be spec'd when S1 lands.

> **Build-verify update (2026-08-16):** the `gemini-embedding-2`@1536 pin named for S2 above (and in §6)
> did not clear build-verify — GA is confirmed (2026-04-22) but the exact GA model-id on Vertex was not
> (only `gemini-embedding-2-preview` was listed). S2 shipped pinned to **`gemini-embedding-001`@1536**
> instead (GA-confirmed, MRL-truncated, same `vector(1536)` schema); adopting `gemini-embedding-2` later
> needs the exact GA id confirmed AND a full reindex (incompatible embedding spaces). Current source of
> truth: `docs/superpowers/specs/2026-08-15-s2-serving-unlock-design.md` §2/§8.

---

## 4. S1 — pgvector-HNSW adapter (detailed spec)

### 4.1 Scope & non-goals
**In:** a new `PgVectorStore` adapter implementing the existing `VectorPort` unchanged; a dimension-parametric
native-vector schema + HNSW cosine index + idempotent `migrate()`; a selection gate in `vector-factory`; a
capability-parameterized VectorPort contract so both adapters share the behavioral core; a **real
Postgres+pgvector** CI harness. Ships **dark** (brute-force remains the default; nothing serves from pgvector
until S2). **Out (later sub-projects):** the serving-path change, the (A) payload *producer*, ceiling
raises, batched embeddings, the `gemini-embedding-2`@1536 pin, freshness/reconcile, eval-at-scale,
per-tenant enablement, retrieval-scoped kill. S1 stores and round-trips whatever `metadata` is upserted; it
does not itself populate render fields (that is S2's producer).

### 4.2 Interface (unchanged `VectorPort`, `vector-port.ts:43-53`)
`upsert(namespace, records: VectorRecord[])`, `query(namespace, {vector?, text?, k}) → VectorMatch[]`,
`deleteById(namespace, ids[])`, `deleteNamespace(namespace)`.
- **Vector-query only.** `PgVectorStore.query` supports `{vector, k}`. A `{text}` query (the lexical-Jaccard
  modality the brute-force adapter offers) throws a clear `PgVectorTextQueryUnsupported`. This is safe: the
  catalog retriever always embeds the shopper turn and queries by `vector` (`catalog-retriever.ts`), never by
  text. Documented as an adapter capability, not a silent no-op.
- **Metadata round-trips** verbatim (enables D-A: S2 writes title/variant into `metadata`; `query` returns it
  on each `VectorMatch`).

### 4.3 Schema & DDL (own table; brute-force keeps `vp_records`)
`migrate()` (idempotent, adapter-level, called by the factory like the brute-force one):
```
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE IF NOT EXISTS vp_ann (
  namespace text NOT NULL,
  tenant_id text NOT NULL,
  id        text NOT NULL,
  embedding vector(<D>) NOT NULL,     -- D = configured dimension (target 1536, D3)
  metadata  jsonb,
  PRIMARY KEY (namespace, id)
);
CREATE INDEX IF NOT EXISTS vp_ann_hnsw ON vp_ann
  USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
CREATE INDEX IF NOT EXISTS vp_ann_tenant ON vp_ann (tenant_id);
```
- **Dimension is a constructor parameter** (`new PgVectorStore(sql, { dimension })`), not hardcoded — the
  column type is built from it. **D ≤ 2000** uses `vector(D)` + `vector_cosine_ops`. **D > 2000** (e.g. 3072)
  uses `halfvec(D)` + `halfvec_cosine_ops` (pgvector's `vector` HNSW index cap is 2000; `halfvec` cap 4000 —
  fact-checked in ADR-0020 D3 on 2026-08-07, **re-confirm at build** against the pgvector README). D3's
  decision is 1536, so the `vector(1536)` path is the primary; halfvec is the documented >2000 fallback.
- Separate table from `vp_records` because a native `vector`/`halfvec` column and a `jsonb` column cannot be
  the same column; the two adapters therefore own separate tables and never collide.

### 4.4 Query
```
SET LOCAL hnsw.ef_search = <efSearch>;         -- recall/latency knob, per-query
SELECT id, metadata, 1 - (embedding <=> $vec::vector) AS score
FROM vp_ann WHERE namespace = $ns
ORDER BY embedding <=> $vec::vector
LIMIT $k;
```
- `<=>` is cosine **distance**; `score = 1 - distance` is cosine **similarity** (higher = better), matching
  the brute-force adapter's `scoreRecord` semantics and the retriever's *drop non-positive cosine* filter
  (`catalog-retriever.ts:154`). Nearest-first via `<=>` ASC; ties broken by `id` for determinism.
- **Dimension guard on upsert:** reject any record whose `vector.length !== D` with a clear fail-closed error
  (mirrors the manifest pin's intent — never store a mis-dimensioned vector). No silent coercion.

### 4.5 HNSW tuning
`m` / `ef_construction` are build-time (index) params; `ef_search` is the query-time recall/latency knob.
Sensible defaults (`m=16, ef_construction=64, ef_search=40`) exposed via adapter options / env. **Recall
quality is NOT asserted in S1 unit tests** — HNSW is approximate; recall@k on a real corpus is S4's
`eval:retrieval` job. S1 proves *correctness/round-trip/erasure/isolation*, not retrieval quality.

### 4.6 Contract handling (the approximate-ANN problem)
The shared `runVectorPortContract` asserts **exact** nearest-first order + `id` tie-break and tests the
**text** modality — neither holds for an approximate, vector-only ANN adapter. Parameterize the contract
with capability flags `{ exactOrdering, textModality }`:
- **Behavioral core (both adapters):** namespace isolation, blank-namespace throw, `upsert` round-trip
  (incl. `metadata`), `deleteById`, `deleteNamespace` erases the whole tenant, unknown-namespace → `[]`.
- **Exact-ordering + text modality:** brute-force only.
- **pgvector adapter:** runs the behavioral core, plus a **vector nearest-first** check on a *small* corpus
  with `ef_search` set high enough to be exact on that size (HNSW returns exact top-k when `ef_search ≥ N`),
  plus a `text`-query → throws assertion, plus a **recall spot-check** on a synthetic ~5k-vector corpus
  (recall@k above a floor, not exact equality).

### 4.7 Selection (ships dark)
`createVectorStore(sql?)` gains a pgvector branch gated on a new env flag **`VECTOR_ANN` (default off)**:
- `DATABASE_URL` set **and** `VECTOR_ANN=true` → `PgVectorStore` (dimension from config/env), `kind:'ann'`.
- else the existing branches (brute-force Postgres / in-memory) unchanged.
Default off ⇒ byte-identical to today. Note: selecting pgvector requires embeddings at dimension `D`; until
S2 pins `gemini-embedding-2`@1536, the operator must set the embed dimension to match (the upsert dimension
guard enforces it fail-closed).

### 4.8 Erasure & portability
- **Erasure (ADR-0015):** `deleteById` / `deleteNamespace` are single transactional `DELETE`s on `vp_ann` —
  right-to-erasure stays one in-engine transaction, no second datastore.
- **Portability (ADR-0001):** all pgvector-isms (`vector`/`halfvec`, `<=>`, HNSW DDL) stay inside the adapter
  behind `VectorPort`. No native vector SQL in feature code (`portability-guard`).

### 4.9 Testing & the CI prerequisite (main risk)
- **Real Postgres+pgvector required.** `pglite` (used by the brute-force adapter's tests) does **not** ship
  the `vector` extension, so it cannot exercise HNSW DDL/recall (ADR-0020 refinement, 2026-08-08). S1's
  contract + recall tests must run against a real Postgres+pgvector — a Docker service / testcontainer
  (e.g. `pgvector/pgvector:pg16`).
- **DECIDED (owner jason.hsu, 2026-08-15): a pgvector testcontainer as a merge-gate step.** The S1
  contract + recall suite runs against a real `pgvector/pgvector:pg16` container booted within the
  merge-gate (a dedicated gate step, or folded into `pnpm test` behind a Docker-backed testcontainer — the
  S1 plan picks the exact wiring). This adds Docker as a merge-gate dependency, accepted deliberately so the
  ANN adapter is genuinely exercised (pglite cannot). The no-weakening gate step names must be updated in
  lockstep (`merge-gate.sh` EXPECT + `ci.yml`) so the step can't be silently dropped.
- Unit/adapter tests: parameterized VectorPort contract on real pgvector; dimension-mismatch rejection;
  `text`-query unsupported; `migrate()` idempotency (run twice); erasure transaction; namespace isolation;
  the ~5k recall spot-check.

### 4.10 S1 risks
- **CI/Docker availability** (§4.9) — the gating risk; resolve in the plan.
- **Approximate recall** — real recall@k is validated in S4, not S1; S1 must not claim retrieval quality.
- **Dimension coupling** — the `vector(D)` column pins D; a later model/dim change is a full re-index (the
  manifest pin already forces `--reindex`). Keep D a config parameter, target 1536.
- **Money-fact invariant** — S1 round-trips `metadata` blindly; the rule "no price in the corpus row" is a
  **producer** (S2) obligation. S1 documents it but cannot enforce a field it doesn't write.

---

## 5. Governance & flags

- Building S1 (a dark adapter) crosses **no HITL boundary** — it does not change shopper-facing behavior, is
  default-off, and is not run-time-agent autonomy. Normal test-first → merge-gate → self-merge.
- **Enabling** `CATALOG_RETRIEVAL` to serve shoppers remains an HITL §5 named-owner promotion, per the
  **proposed** (unmerged, PR #295) owner reclassification: recorded real-Vertex `eval:retrieval` +
  `shadow:retrieval` + owner sign-off; canary waived; per-tenant + kill-switch as compensating controls. S4
  builds the per-tenant enablement + retrieval-scoped kill those controls assume (they do **not** exist
  today: `CATALOG_RETRIEVAL` is a process-global flag; the only kill is whole-tenant shopper-scope).

## 6. S2–S4 outlines (spec'd later)

- **S2 — serving unlock.** (a) Producer: extend `catalog-index` so each corpus row's `metadata` carries the
  **stable** render fields (title, variantId, …) — decision D-A; keep price OUT (stays ProductFacts). (b)
  Serving: make `grounding.getContext` retrieval-aware — fetch brand+policy "shell" only (no full product
  list) when `CATALOG_RETRIEVAL` is on; rewire `retrieveCandidates` (`brain.ts:949-988`) to resolve render
  data from `VectorMatch.metadata` + ProductFacts-by-ID instead of `ctx.products`; fix `rendered`
  (`brain.ts:191`) and the "N of M" count (`:231`) to not depend on the full list; preserve the drop-delisted
  guard. (c) Ceilings: `MAX_INDEXED_PRODUCTS` 1000→~50k, raise the fetch pagination, decouple
  `MAX_SCAN_ROWS`. (d) Embeddings: add `gemini-embedding-2` to `EMBED_MAX_BATCH`, per-request timeout +
  retry/backoff + bounded concurrency; pin `PALUP_EMBED_MODEL=gemini-embedding-2` + `PALUP_EMBED_DIMENSION=1536`.
  (e) Embed-richness knob: raise/​separate `MAX_DESC`/`MAX_TAGS` for the **embed input** (bounded to the
  2048-token/text budget; select title + top-N tags + description-head), keep the rendered line short —
  validated by recall. All strictly behind `catalogRetrievalEnabled` so flag-off stays byte-identical to the
  golden.
- **S3 — freshness at scale.** Carry the changed product id through the reconcile queue message; add a
  fetch-by-ID path so a webhook refreshes only changed SKUs; coalesce/debounce per-tenant reconciles; deploy a
  Cloud Scheduler → Cloud Run Job backstop; set the serving staleness ceiling to ≤15 min and implement the
  D2 fail-honest "let me confirm current price" behavior.
- **S4 — safe promotion.** Point `eval:retrieval`/`shadow:retrieval` at a real pgvector store on a
  scale-representative corpus; stand up the real-pgvector CI (shared with S1); add per-tenant
  `CATALOG_RETRIEVAL` enablement (replace the process-global flag) and a retrieval-scoped kill the `/chat`
  path reads; produce the recorded eval+shadow evidence the §5 bar requires.

## 7. Review decisions (settled 2026-08-15, owner jason.hsu)
1. **S1 CI** — **pgvector testcontainer as a merge-gate step** (Docker accepted as a gate dependency). See §4.9.
2. **Table layout** — **separate `vp_ann` table** (confirmed). See §4.3.
3. **Selection** — **explicit `VECTOR_ANN` env flag**, no corpus-size auto-selection (confirmed). See §4.7.
