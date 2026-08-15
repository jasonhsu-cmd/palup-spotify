# S2 — serving unlock (render large catalogs) — design

**Status:** Draft for review — 2026-08-15. Author: build agent (brainstormed with jason.hsu).
**Goal:** make a **>1000-SKU** store actually RENDER products in `/chat` via `CATALOG_RETRIEVAL`, by serving the top-K from the corpus + a by-id price hydrate instead of fetching the whole catalog every turn.
**Sub-project 2 of 4** in the A2 build (`docs/superpowers/specs/2026-08-15-catalog-retrieval-scale-design.md`). **Builds on:** S1 pgvector engine (shipped #297); ADR-0020 D2/D3; the A1 `ProductFactsPort` + hydrate-by-id (built inert). **Ships dark** — everything behind `catalogRetrievalEnabled`; flag-off byte-identical to the golden. Enabling to serve shoppers stays an HITL §5 promotion (S4), out of scope here.

## 1. The core move
Today the brain calls `grounding.getContext(tenantId)` **unconditionally** (`brain.ts:1009`), which fetches the whole catalog; above 1000 products it degrades to safe-empty and the shopper sees nothing. S2: **when `CATALOG_RETRIEVAL` is on, fetch only a brand/policy *shell*, retrieve the top-K ids from the corpus, and build each product from the corpus row's metadata (title/variantId) + `ProductFacts`-by-id (price/availability)** — never touching `ctx.products`.

## 2. Decisions (this doc)
- **D-A (already chosen):** the corpus row's `metadata` carries the **stable** render fields (`title`, `variantId`); **price/availability stay in `ProductFactsPort`** (D2-fresh) so a stale price can never come from the corpus.
- **D-shell:** add a `GroundingPort.getShell(tenantId)` returning brand+policy only (no products) — a separate, testable responsibility from `getContext`. (Rejected: teaching the Shopify grounding adapter to conditionally return a products-less context — conflates fetch with retrieval-awareness.)
- **D-embed:** pin **`gemini-embedding-2`@1536** (ADR-0020 D3; confirmed on Vertex 2026-08-15: 1536 is a recommended `output_dimensionality` tier, batch embedding supports up to 1M rows/job). 1536 ≤ pgvector's 2000 `vector`-index cap → native `vector(1536)` (S1's default path). The shipped default `gemini-embedding-001`@3072 was a stopgap; nothing is indexed on the pgvector store yet, so this is a fresh index, not a migration.
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
- Embeddings: switch the index job to a **batch** embed call; add per-request timeout + retry/backoff + bounded concurrency (the serial 1-per-request path is the throughput blocker at 50k). Pin the manifest `{model:"gemini-embedding-2", dimension:1536, purpose:"document"}` via `PALUP_EMBED_MODEL`/`PALUP_EMBED_DIMENSION` in the index/deploy config.

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
- **`gemini-embedding-2` GA vs preview** — Vertex docs (2026-08-15) show both a GA-style model page and a preview page; re-confirm the exact model-id string + GA status at build. Fallback: `gemini-embedding-001`@3072 (S1's `halfvec(3072)` path) if `gemini-embedding-2`@1536 isn't serving in the staging project.
- **Serving requires `VECTOR_ANN=true`** for >5000 SKUs (pgvector); a >5000 store on the brute-force store would silently truncate at 5000. Document the `VECTOR_ANN` precondition.
- **Governance:** S2 is build-time/dark; enabling `CATALOG_RETRIEVAL` to serve is still §5 (S4). S2 does NOT flip it.

## 7. Open questions for review
1. `getShell` port method (spec'd) — confirmed by the owner. Any objection to the `GroundingShell{brandName,policy}` shape?
2. `MAX_INDEXED_PRODUCTS` = 50000 (the ADR ceiling) — or a lower first-cut cap to bound index time/cost while proving the path? (Indexing 50k is cheap in $ but ~50k batched embeds; a lower cap, e.g. 10k, proves serving sooner.)
