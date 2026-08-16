# S2 — serving unlock (render large catalogs) — design

**Status:** Implemented behind `catalogRetrievalEnabled` (dark) — 2026-08-16. Author: build agent (brainstormed with jason.hsu). Retrieval is OFF everywhere (`CATALOG_RETRIEVAL` unset); enabling it to serve shoppers is a separate, still-open HITL §5 promotion (S4) — see "Promotion preconditions" below.
**Goal:** make a **>1000-SKU** store actually RENDER products in `/chat` via `CATALOG_RETRIEVAL`, by serving the top-K from the corpus + a by-id price hydrate instead of fetching the whole catalog every turn.
**Sub-project 2 of 4** in the A2 build (`docs/superpowers/specs/2026-08-15-catalog-retrieval-scale-design.md`). **Builds on:** S1 pgvector engine (shipped #297); ADR-0020 D2/D3; the A1 `ProductFactsPort` + hydrate-by-id (built inert). **Ships dark** — everything behind `catalogRetrievalEnabled`; flag-off byte-identical to the golden. Enabling to serve shoppers stays an HITL §5 promotion (S4), out of scope here.

## 1. The core move
Today the brain calls `grounding.getContext(tenantId)` **unconditionally** (`brain.ts:1009`), which fetches the whole catalog; above 1000 products it degrades to safe-empty and the shopper sees nothing. S2: **when `CATALOG_RETRIEVAL` is on, fetch only a brand/policy *shell*, retrieve the top-K ids from the corpus, and build each product from the corpus row's metadata (title/variantId) + `ProductFacts`-by-id (price/availability)** — never touching `ctx.products`.

## 2. Decisions (this doc)
- **D-A (already chosen):** the corpus row's `metadata` carries the **stable** render fields (`title`, `variantId`); **price/availability stay in `ProductFactsPort`** (D2-fresh) so a stale price can never come from the corpus.
- **D-shell:** add a `GroundingPort.getShell(tenantId)` returning brand+policy only (no products) — a separate, testable responsibility from `getContext`. (Rejected: teaching the Shopify grounding adapter to conditionally return a products-less context — conflates fetch with retrieval-awareness.)
- **D-embed (settled at build, 2026-08-16 — supersedes the `gemini-embedding-2` pin drafted below on 2026-08-15):** pin **`gemini-embedding-001`@1536** (MRL-truncated), not `gemini-embedding-2`. Build-verify ruling: `gemini-embedding-2` DID go GA 2026-04-22, but its exact GA model-id string on Vertex was NOT confirmable at build time (the live model page still listed only `gemini-embedding-2-preview`); `gemini-embedding-001` is confirmed GA on Vertex with a confirmed exact id and supports `output_dimensionality=1536` via MRL. 1536 ≤ pgvector's 2000 `vector`-index cap → native `vector(1536)` (S1's default path, unchanged). See §8 "Promotion preconditions" for the upgrade path to `gemini-embedding-2`.
- **D-backend:** the corpus backend is S1's `VECTOR_ANN` pgvector store. **Serving a >5000-SKU store requires `VECTOR_ANN=true`** (the brute-force adapter caps at a 5000-row scan). `VECTOR_ANN` is an independent operator selection from `CATALOG_RETRIEVAL`.

## 3. Components & interfaces

### 3.1 Producer (index side) — `packages/widget-backend/src/jobs/catalog-index.ts`
- The corpus record (`catalog-index.ts:649-659`) `metadata` gains `title` and `variantId` alongside the existing `{kind, productId, contentHash}`. The embedded text (`productEmbedText` = title+tags+description) is unchanged — this is metadata for RENDER, not the vector.
- **No price/availability in the corpus** (unchanged invariant). Re-index already fires on content-hash change (title change → re-embed → metadata refreshed); a delisted product's row is removed via `deleteById`, so it can't be retrieved (preserves today's "drop delisted id" guarantee).
- **Build-verify:** confirm the grounding `Product` / catalog source carries `variantId` (the widget builds cart links from it, ADR-0020 C1b). If not directly present, source it in the producer.

### 3.2 Shell fetch (read side) — `packages/platform-ports/src/grounding-port.ts` + the Shopify adapter
- New `interface GroundingShell { brandName: string; policy: StorePolicy }` and `GroundingPort.getShell(tenantId: string): Promise<GroundingShell>` (= `GroundingContext` minus `products`). Tenant-scoped like `getContext`.
- The Shopify grounding adapter implements `getShell` by fetching only shop brand + policies (no product pagination) — so it can never hit the catalog ceiling.

### 3.3 Serving rewire — `packages/widget-brain/src/brain.ts`
When `catalogRetrievalEnabled` (`:847`) AND a retriever + query are present:
- Call `grounding.getShell(tenantId)` (not `getContext`) — no full-catalog fetch.
- Rewire `retrieveCandidates` (`:949-988`): drop the `ctx.products.length <= k` short-circuit (`:960`) and the `byId = new Map(ctx.products.map(...))` resolver (`:975`). Instead: `retriever.retrieve({tenantId, query, k})` → ids + `VectorMatch.metadata`; build each `Product` from `{ id, title, variantId }` (corpus metadata) + `ProductFactsPort.getMany(tenantId, ids)` for `price`/`availableForSale` (the existing A1 hydrate path, `brain.ts:1020-1025`, already does the fact overlay — reuse it).
- `rendered` (`:191`) is the retrieved+hydrated subset; the "N of M" count (`:231`) reads the retrieved count + the corpus/manifest product count instead of `ctx.products.length`.
- **Flag-off unchanged:** `catalogRetrievalEnabled=false` ⇒ `getContext` + `rendered = ctx.products` + the existing count — byte-identical to the golden (`retrieval-flag-off`/`chat-wire-flag-off`). The new `getShell` call and by-id assembly live strictly inside the flag-on branch.
- Fail-open preserved: a `getMany` failure resolves to the un-hydrated retrieved subset (as today, `:1017`); a retrieval failure answers the turn without products.

### 3.4 Scale (index side)
- `MAX_INDEXED_PRODUCTS` 1000 → **50000** (ADR-0020 ~50k design ceiling); raise `MAX_CATALOG_PAGES` so the index job can page the whole catalog (~200 pages × 250). This is the **offline index job**, not the per-turn path (serving uses `getShell`), so the pagination cost is acceptable. The brute-force `MAX_SCAN_ROWS` coupling is irrelevant on the pgvector path.
- Embeddings: switch the index job to a **batch** embed call; add per-request timeout + retry/backoff + bounded concurrency (the serial 1-per-request path is the throughput blocker at 50k). Pin the manifest `{model:"gemini-embedding-001", dimension:1536, purpose:"document"}` (settled at build — see D-embed §2 and §8) via `PALUP_EMBED_MODEL`/`PALUP_EMBED_DIMENSION` in the index/deploy config.

## 4. Testing (mock + pgvector-testcontainer; no real Vertex to build)
- **Producer:** a fake catalog → corpus rows carry `title`/`variantId` in metadata (against the in-memory or pgvector store).
- **getShell:** the adapter returns brand+policy, performs no product pagination, and can't throw the catalog ceiling.
- **Serving (headline):** with `catalogRetrievalEnabled` + a **>1000-product fake catalog** + a fake embed model, a `/chat` turn renders the top-K products built from corpus metadata + a fresh `ProductFacts` price, WITHOUT a full-catalog fetch. Assert the render is correct and no ceiling throw occurs.
- **Flag-off golden:** `catalogRetrievalEnabled=false` ⇒ byte-identical prompt/Decision/reply (re-run the existing goldens).
- **Delisted guard:** a product removed from the corpus (`deleteById`) is not retrieved/rendered.

## 5. Out of scope (S3 / S4)
- **S3:** targeted by-id reconcile + scheduler + tighten the staleness ceiling to ≤15min + the D2 fail-honest "let me confirm current price" behavior.
- **S4:** `eval:retrieval`/`shadow:retrieval` at scale on real pgvector; **per-tenant `CATALOG_RETRIEVAL` enablement + a retrieval-scoped kill** (these two are also the compensating controls PR #295's canary-waiver needs — S4 unblocks #295). Retrieval **quality** at 1536 is S4's real-Vertex eval, not claimed by S2.

## 6. Risks
- **`variantId` in the corpus** — confirm the catalog `Product` carries it (§3.1 build-verify); a card needs it for the cart link.
- **`gemini-embedding-2` GA vs preview — RESOLVED at build (2026-08-16):** GA confirmed 2026-04-22, but the exact GA model-id was not confirmable on Vertex (only `gemini-embedding-2-preview` was listed), so the spec's own documented fallback governs: pinned **`gemini-embedding-001`@1536** instead (see D-embed §2, §8). Upgrading later needs BOTH the exact GA id confirmed AND a full reindex — 001↔2 embedding spaces are incompatible.
- **Serving requires `VECTOR_ANN=true`** for **>5000 SKUs** (pgvector); a >5000 store on the brute-force store would silently truncate at 5000. This is a hard promotion precondition — see §8.
- **Governance:** S2 is build-time/dark; enabling `CATALOG_RETRIEVAL` to serve is still §5 (S4). S2 does NOT flip it.

## 7. Review decisions (settled 2026-08-16, owner jason.hsu)
1. **`getShell` port method + `GroundingShell{brandName,policy}` shape — confirmed.**
2. **`MAX_INDEXED_PRODUCTS = 50000`** (the full ADR-0020 design ceiling) — batch embedding makes it tractable; the durable "scales" target, not a first-cut cap.
3. **Owner ruling (jason.hsu, 2026-08-16):** on the retrieval serving path a product with no fresh `ProductFact` renders NO price (fail-honest); the §B money-facts eval gate (`MF-missing-1`, `MF-xtenant-1`) was updated to expect this stricter behavior. This strengthens NN#1; it is an expected-behavior update, not an eval-floor/threshold weakening.

## 8. Promotion preconditions (settled during build)

None of these flip a flag; they are conditions that must hold **before** a human runs the S4/§5 promotion to enable `CATALOG_RETRIEVAL` for real shopper traffic. `CATALOG_RETRIEVAL` and `VECTOR_ANN` remain OFF/unset in every environment as of this doc.

1. **Embed model pin — `gemini-embedding-001`@1536, not `gemini-embedding-2`.** Build-verify ruling (2026-08-16, primary Vertex/Google sources): `gemini-embedding-2` did go GA on 2026-04-22, but its exact GA model-id string on Vertex was not confirmable at build (the live model page listed only `gemini-embedding-2-preview`, no stable id). `gemini-embedding-001` is confirmed GA on Vertex with a confirmed exact id and supports `output_dimensionality=1536` via MRL, keeping the S1 `vector(1536)` HNSW schema unchanged. **Upgrading to `gemini-embedding-2` later is a human/§5 step** requiring BOTH the exact GA model-id confirmed on Vertex AND a **full reindex** of every tenant's corpus — the `gemini-embedding-001` and `gemini-embedding-2` embedding spaces are incompatible, so a corpus cannot be mixed or incrementally migrated between them.

2. **The offline index job's stale-reconcile is not scale/ANN-safe — S3 dependency.** The reconcile enumerate (`catalog-index.ts`, `deps.vector.query(ns, { text: "" })`) caps silently at `MAX_SCAN_ROWS` (5000) on the legacy brute-force store, and **throws** (`PgVectorTextQueryUnsupported`) on the S1 `VECTOR_ANN=true` pgvector store, which is vector-query-only. **Do not run a >5000-SKU pgvector index through the current job until S3 reworks this reconcile** into something ANN-compatible (e.g. paged/id-diff). This is why the S2 headline E2E (`serving-unlock-e2e.test.ts`) exercises the in-memory store, not pgvector.

3. **`ProductFacts` must be populated before enabling priced retrieval serving.** The corpus never carries price (D-A, §2) — `retrieveViaShell` builds each retrieved `Product` with `price: ""`, and only the separate `PRODUCT_FACTS_HYDRATION` overlay (`hydrateProductFacts`, also off by default) can fill it in. So retrieval renders **no price** for every product in either shape: with `PRODUCT_FACTS_HYDRATION` off, the price field stays a bare empty string; with it on but no fresh `ProductFact` for that product, `priceConfirmed: false` withholds the price and substitutes the "current price needs confirming" text (fail-honest). A merchant's `ProductFactsPort` data must be populated and kept fresh, and `PRODUCT_FACTS_HYDRATION` enabled, before `CATALOG_RETRIEVAL` is enabled for that tenant — otherwise shoppers see unpriced or permanently-unconfirmed products on every turn.

4. **Reindex to a fresh corpus before enabling.** The shell path (`GroundingPort.getShell`) fetches no live catalog — brand/policy only — so a delisted product's corpus row is pruned **only on reindex** (`deleteById` during a `pnpm catalog:index` run), never per-turn. A tenant must be reindexed against its current catalog immediately before enabling retrieval, or a stale/delisted product can still be served from an old corpus.

5. **`VECTOR_ANN=true` is required for any corpus above 5000 products** (see §2 D-backend and §6): the brute-force store's `MAX_SCAN_ROWS` (5000) silently truncates above that size. `VECTOR_ANN` is an independent operator selection from `CATALOG_RETRIEVAL` and must be confirmed true for a given tenant before that tenant's corpus is allowed to exceed 5000 SKUs in serving.

6. **`CART_LINE_ITEMS` is incompatible with the `CATALOG_RETRIEVAL` shell render path and MUST NOT be co-enabled until S3/S4.** Reason: the shell path builds `ctx` with `products:[]`, so `renderCartBlock` resolves zero cart items and the cart block silently drops — with no audit flag. The audit-flag + cart-via-corpus resolution is S3/S4 work. This is a HARD co-enablement gate.

**Note (revisit in S3 freshness work):** `getShell` has no cache (deliberate passthrough), so on the flag-ON path a Shopify outage drops that turn to a brandless generic prompt, where flag-OFF `getContext` would serve last-known-good; flag-ON is per-turn more fragile than flag-OFF.
