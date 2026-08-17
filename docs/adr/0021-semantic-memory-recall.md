# ADR-0021: Semantic cross-visit memory recall (v1) — relevance-ranked recall, safety floor, Art-9 no-embed boundary

- **Status:** Proposed — 2026-08-17 (owner: jason.hsu@framy.co). Design recorded; the implementation is
  **shipped dark** (PRs #319 `VectorPort.list`+pagination, #320 write path, #321 read path) behind a new
  default-off posture flag `MEMORY_SEMANTIC_RECALL` — flag off ⇒ recall is byte-identical to the FAST-V1
  list-all baseline and no embedding is written. **This ADR enables nothing.** Turning it on is a future
  human step gated on BOTH (a) the run-time evolution pipeline — eval gate → shadow(0%) → canary(1–5%) →
  named-human promotion (ADR-0002 / HITL-POLICY §5) — AND (b) the owner + legal sign-offs recorded in D3
  and D4 below. **Internal-staging enablement (owner: jason.hsu, 2026-08-17):** the owner has enabled
  semantic memory on the internal-only staging service (`palup-skincare-jason`) with **D3 and D4 DEFERRED**
  as an accepted internal-only risk — the same posture ADR-0015 takes for legal (internal users, not real
  external-shopper data at scale). D3/D4 (and the D6 pinned-index + latency check) **remain REQUIRED before
  any production / external enablement**; this internal-staging decision does not grant them. This ADR
  **extends ADR-0015** (which governs whether cross-visit memory runs at all, and is
  Accepted for internal staging only, legal deferred): ADR-0015 owns enablement; this ADR owns the
  recall-semantics and embedding sub-decisions.
- **Context:** FAST-V1 memory recall (`service.ts`) was a *list-all* — `query(ns,{text:"",k:500})` handed
  the brain every consented fact, unranked, and facts were stored without embeddings. Two problems: (1) it
  does not scale or rank — at the target of **thousands of facts per shopper** it truncates arbitrarily and
  floods the prompt with irrelevant facts; (2) it is incompatible with the pgvector ANN store enabled for
  the catalog (`VECTOR_ANN`) — that store rejects text-modality queries **and** vector-less writes, so with
  memory on, every `/chat` turn errored (observed in staging 2026-08-17; memory disabled, serving restored).
  Giving memory embeddings is what makes it ANN-native, so the semantic upgrade **is** the store fix, done
  in the right direction. Portability (ADR-0001) is a hard constraint — all storage/embedding go through the
  `vector`/`model` ports. Full design + task history: `docs/superpowers/plans/…` / the approved plan.

## Decisions

### D1 — Recall semantics: list-all → semantic top-K + an always-include safety floor
Recall becomes relevance-ranked: embed the shopper's turn once (`purpose:"query"`), retrieve the top-K
(`MEMORY_RECALL_TOP_K`, default 16 — **un-tuned, eval-gated**, per the `DEFAULT_CATALOG_RETRIEVAL_K` stance)
facts most similar to the turn, EXCLUDING placeholder/pinned rows from ranking. On top, a **safety floor**
unconditionally unions in the shopper's safety-critical facts. Fallback to the exact list-all baseline when
the flag is off, no query vector is available, or the embedding-space pin mismatches. *Rationale:* at
thousands-of-facts scale a relevance-ranked recall is the whole point; the floor guarantees a
safety-critical fact is never lost to top-K.

**Safety-floor completeness guarantee (formal — the load-bearing property).** Every row where
`class === "special"` **OR** `mustRecall === true` is surfaced by recall, enumerated **to exhaustion**
(paginated, not capped), subject only to (i) TTL-on-read expiry and (ii) the brain's current-turn read-time
consent filter (`consentedAtReadTime`, unchanged — the floor is a recall mechanism, never a consent bypass).
The floor keys on the **durable `class:"special"`** marker (authoritative in `erasure.ts`), not only the
newer flag-gated `mustRecall` stamp — so a special/allergy fact written *before* the flag existed is still
guaranteed to surface (the hole the PR #321 security review caught and this predicate closes). A consented
allergy fact aging out after its ratified 30-day sliding TTL (ADR-0015) is intended retention, not a gap.

### D2 — Art-9 (special-category / health) facts are NEVER embedded — the privacy boundary
A vector derived from special-category plaintext is never computed or stored. Special facts carry a
**random-unit placeholder vector** (satisfies the pgvector NOT-NULL/dimension contract, cryptographically
unrelated to content) + `mustRecall:true`, and are recalled ONLY via the safety floor (D1), never by
similarity. An ordinary fact carrying an Art-9 `sourceQuote` is promoted to `special` via `effectiveClass`
*before* the embed step, so its health text also takes the no-embed path. The safety floor is therefore
also the privacy boundary: **no unencrypted health vector exists at rest.** *Verified by the PR #320
security review (PASS on the boundary in code) + a leak-guard test.* This improves the Art-9 at-rest posture
that ADR-0015 legal deferred.

### D3 — Ordinary facts store an unencrypted, partially-invertible embedding at rest — REQUIRES owner + legal sign-off before enablement
An ordinary fact's `text` remains encrypted at rest, but its embedding `vector` (derived from the plaintext)
must be stored **unencrypted** for the HNSW cosine index to function — a searchable vector cannot be
encrypted. Embeddings are partially invertible (approximate source-text reconstruction), so this is a **new
at-rest exposure** for ordinary personal data, distinct from the Art-9 case. Scope that bounds it: ordinary
facts only (never Art-9 — see D2), built from text already redacted of payment cards/SSNs. This is an
**inherent tension of semantic ANN, not a fixable bug** — it is a policy acceptance. **Status: DEFERRED for INTERNAL STAGING
(owner: jason.hsu, 2026-08-17)** — accepted as an internal-only risk (internal testers, not real
external-shopper data at scale), consistent with ADR-0015's legal deferral. **REQUIRED — owner + legal
sign-off — before production / external enablement.** (Surfaced by the PR #320 security review, item 2.)

### D4 — The Art-9 `dedupTag` is a keyed-HMAC equality oracle — REQUIRES legal sign-off before enablement
Write-time dedup for special facts uses a keyed-HMAC `dedupTag` over the sanitized plaintext (exact-match
only — no similarity oracle over health text). The HMAC key is **tenant-mixed + domain-separated**
(`deriveKey(tenantId, key, "memory-dedup")`, matching the AES path's cross-tenant separation — fixed in the
PR #320 review, Finding 3.A) and there is no unkeyed fallback (no key ⇒ no tag ⇒ dedup skipped). Content is
not recoverable without the key. Residual: `metadata.dedupTag` is a **stable equality identifier** over an
Art-9 fact in unencrypted metadata — a DB-reader can see that N records encode the same health fact.
**Status: DEFERRED for INTERNAL STAGING alongside D3 (owner: jason.hsu, 2026-08-17); REQUIRED — legal sign-off — before production / external.** (Ordinary dedup uses vector top-1 ≥
`MEMORY_DEDUP_THRESHOLD` = 0.95, **eval-gated** — too low silently merges a distinct consented fact, which
the dedup eval guards; update-in-place is a newest-wins full upsert, class/consent can never be widened.)

### D5 — `VectorPort.list` (bounded keyset enumerate) + paginated erasure/retention/merge
A new additive port method `list(ns,{limit,after?})` — a plain namespace scan the ANN store can serve
(distinct from the similarity `query`). Erasure/retention/merge move off the list-all `query({text:""})`
idiom (which pgvector rejects) to a `list` page-walk **to exhaustion**, so GDPR right-to-erasure completeness
is guaranteed by exhaustion rather than a fail-closed-at-500 cap. *Verified: PR #319 security review PASS on
erasure completeness + namespace isolation.*

### D6 — Latency posture
**Corrected 2026-08-18 (live-staging finding).** Memory writes were originally moved **off the `/chat`
critical path** (fire-and-forget, `void memoryService.remember(...).catch(...)`) to remove FAST-V1's
synchronous distiller round-trip and make the new embed/dedup free to the shopper. Live diagnosis on the
internal-staging deployment proved this posture **does not work on Cloud Run**: once the HTTP response is
sent, Cloud Run throttles the container's CPU to ~0, so a write kicked off AFTER the reply (the distiller's
`model.complete` + embed + upsert) is starved and never runs — confirmed by 0 facts ever landing in
`vp_ann` and by metering showing exactly one `shopper`-tagged model call per turn (the reply) instead of two
(reply + distiller). The write is therefore **SYNCHRONOUS** (`await`ed inside `/chat`'s existing try/catch,
`server.ts`): this keeps it inside the request, where Cloud Run guarantees CPU, at the cost of adding the
distiller round-trip back to the shopper-visible turn latency — trading back part of the win this decision
originally claimed. Fail-open is unchanged: a `remember()` failure is caught and logged, never breaking the
reply. **Follow-up (not yet built):** a durable async write queue (Cloud Tasks / Pub/Sub, mirroring the
catalog-webhook path) is the correct way to reclaim the latency — hand the write off durably instead of
racing it against a container whose CPU may be reclaimed at any moment. Recall **reuses the one turn
embedding** the catalog retriever already computes (metered `TURN_EMBED_AGENT_TYPE`), computed once on the
clean-sales path only (zero embeds on a guardrail-short-circuited turn) — so semantic recall adds no new
per-turn model call; this part of the original posture is unaffected. **Pre-promotion follow-up (recall
side, unaffected by the write-path fix above):** the safety-floor enumerate is O(N)/recall at
thousands-scale (no server-side metadata filter); a pinned-fact index (separate per-subject namespace or a
subject-pinned index) must land before promotion so the floor is O(pinned). A latency check must accompany
that optimization before promotion — the PR4 eval suite measures recall *quality* (relevance / safety-floor
/ dedup), not latency.

## Consequences / promotion gate
- **Enablement requires, in order:** the D3 + D4 owner+legal sign-offs recorded here; the D6 pinned-index
  optimization + a latency check; the recall-quality eval gate passing — `pnpm eval:memory-recall` (a
  dedicated gating script mirroring `eval:retrieval`, with null→block discipline; recall@k relevance +
  safety-floor + dedup suites); then shadow(0%) → canary → named-human promotion. Flipping
  `MEMORY_SEMANTIC_RECALL` on any real environment is human-gated (a build agent may not). **A promotion
  runbook entry for `MEMORY_SEMANTIC_RECALL` in HITL-POLICY §5 / `MEMORY-GO-LIVE-CHECKLIST.md` is a
  pre-enablement authoring step** (owner / release-manager) — not yet written; this ADR records the gate
  shape, the checklist entry records the operational steps.
- **Reversibility:** dark and additive — flag off restores the list-all baseline with no vector-at-rest and
  no new data written; reverting is a flag/const change plus the standard erasure path for anything written.
- No flag is flipped by the implementation PRs; `flag.ts` (the ADR-0015 double gate) is untouched.
