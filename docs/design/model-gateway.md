# Design Spec — Model Gateway (LLM serving)

_The buildable service behind the `model` port. Backs the admin **Engineering Monitor → Model
Gateway** exactly (deflection 40%, semantic cache 22%, prompt cache 71%, routing 95/4/1, fallback,
1.9M tokens/min). Realizes ADR-0001 (portable), ADR-0005 (per-step tiering), and the margin engine of
`cost-margin-telemetry.md`. Every agent Recall/Plan/Act step calls this gateway._

**Prime invariants:** tier routing + quality floor are enforced here, not by callers; **PII is
redacted before any provider egress** (`security-data-path.md` §3); every call is metered; no provider
SDK leaks past an adapter.

## 1. Request path (per model call)

`model.generate(req) → gateway`:
1. **Redaction/DLP** — minimize/redact PII before the request can leave (fail-closed; contract test).
2. **Cache lookup (three tiers, cheapest first):**
   - **Deterministic deflection (~40%):** exact/rule-answerable requests (templated FAQs, structured
     lookups) never hit an LLM at all.
   - **Semantic cache (~22%):** embedding-similarity match to a prior answer within a tenant-scoped
     cache, above a confidence threshold.
   - **Prompt cache (~71% of what remains):** provider/context prefix caching for repeated system/
     context tokens.
3. **Tier routing:** `routine` → Gemini Flash (~95%), `high_stakes` → Gemini Pro (~4%), `canary` →
   experimental variant (~1%, capped by Evolution). **Quality floor:** closing/refunds/pricing/
   complaints never downgrade to a cheaper tier to save cost.
4. **Budget check:** per-tenant + per-run token/cost budget (ADR-0005); exceed → unbounded-consumption
   ceiling trips (halt + alert), not a silent overrun.
5. **Invoke + failover** (§3), **meter** (§5), return normalized `{text, toolCalls?, usage}`.

Caches are **tenant-scoped** (no cross-tenant answer reuse) and honor residency.
- **Semantic-cache provenance (anti-poisoning):** an answer shaped by high-untrusted-content context
  (customer chat, product data, scraped web) is **not cached** — or is tagged with trust/provenance so
  a potentially-injected answer is never silently reused (even within the tenant). Cached PII is
  covered by the erasure cascade (`data-platform.md` §7).
- **Prompt cache** operates on **post-redaction** content (redaction is step 1), and the provider
  prefix-cache key is asserted **collision-free across tenants** (a required `model` adapter contract
  test) so no timing/content leaks across tenants.

## 2. Providers & serving

- **Managed:** Vertex Gemini Flash/Pro; **Claude via Vertex Model Garden** as fallback. Embeddings
  (`text-embedding-005`) + Cohere Rerank.
- **Self-trained variants (Gemma/Llama canary):** served on **GKE GPU nodes** (see
  `observability-and-sre.md` for the GPU pool); provenance-tracked, promoted only through the
  evolution pipeline. Tier→model mapping lives in adapter config, never feature code.

## 3. Failover & health

- Per-provider health tracked; on 5xx/timeout/rate-limit the gateway **fails over** to the configured
  alternate (routing shown in the monitor; Claude fallback <1%) while preserving tier semantics and
  the quality floor. Failover is auto-allowed (reliability, non-cost-changing); a routing/default-
  model *policy* change is governed (HITL).

## 4. Embeddings pipeline

- Batch-embeds new/changed memory and content through the `model` port → writes to the `vector`
  store (ADR-0009). Backpressure-aware, idempotent, tenant-scoped; embedding cost is **absorbed COGS**
  (billing spec), metered but not billed to the merchant.

## 5. Cost metering & throughput

- Every call emits `telemetry.recordCost(ctx, 'inference', tokens→$)` attributed to tenant × agent ×
  tier. The **tier mix is the gross-margin engine** — a routing regression toward expensive tiers is a
  margin event flagged by the cost/efficiency eval (≥85) and cost telemetry (`cost-margin-telemetry.md`
  §4). Throughput target ~1.9M tokens/min today, scaling with the worker pool.

## 6. Invariants (tests)

1. No provider call without redaction passing (fail-closed). 2. Cache reuse is tenant-scoped; no
cross-tenant answer leakage. 3. Quality floor holds — high-stakes steps never downgraded. 4. Per-tenant/
run budget enforced; overrun trips the ceiling. 5. Failover preserves tier + quality-floor semantics.
6. Default-model/routing-policy changes are governed (HITL), not silent. 7. Every call metered to a
tenant + tier.
