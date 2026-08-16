# S3 — freshness at scale (A2 / ADR-0020) — design

**Status:** Draft for review — 2026-08-16. Author: build agent (brainstormed with jason.hsu).
**Governs:** keeping a >1000-SKU CATALOG_RETRIEVAL corpus fresh at scale — targeted (by-id) reconcile,
per-tenant coalesce/debounce, a ≤15-min serve-time staleness ceiling (fail-honest), and a deployed
scheduled backstop — **without** full-catalog crawls per change and **without** the ANN-unsafe enumerate S2
surfaced.
**Builds on (does not overturn):** S1 (pgvector engine, shipped #297), S2 (serving-unlock, PR #299),
ADR-0020 (D2 freshness / D3 embed / the webhook-optimization-with-scheduled-backstop model), ADR-0001
(portability), ADR-0015 (erasure), HITL-POLICY §5.
**Ships dark.** `CATALOG_RETRIEVAL` and `VECTOR_ANN` stay OFF; nothing serves from the corpus until a §5
human promotion. The scheduled reconcile job *maintains* the dark corpus (and thus spends on embeddings) —
that is why its deploy is a human apply (§E), not a build agent's.

---

## 1. Problem (verified 2026-08-16 via source map)

Three freshness gaps remain after S2:

1. **The reconcile is not ANN-safe.** `indexOneTenant` enumerates the existing corpus with
   `deps.vector.query(ns, { text: "", k: maxProducts+1 })` (`catalog-index.ts:508-509`) to compute
   `stale`/`toEmbed` (`:531-551`, prune at `:705`). On the brute-force store this silently caps at
   `MAX_SCAN_ROWS=5000`; on the S1 pgvector store it **throws** `PgVectorTextQueryUnsupported`
   (`pgvector-store.ts:94`, vector-only). So a >5000-SKU pgvector index cannot be reconciled today (the
   in-code note at `catalog-index.ts:500-507` parks exactly this to S3). VectorPort deliberately exposes no
   `listIds`/`count`/enumerate (`vector-port.ts:43-53`; adding one is non-portable per
   `MEMORY-GO-LIVE-CHECKLIST.md:92`).
2. **Every change costs a full crawl.** The webhook path exists but its queue message carries only
   `{tenantId, topic, webhookId}` (`catalog-webhook-queue.ts`; `routes/shopify-webhooks.ts:366-390`) and the
   consumer calls `reconcile(tenantId)` = a **whole-catalog** `runCatalogIndex` (`server.ts:1069-1071`). For a
   large store, one product edit re-fetches + re-diffs the entire catalog.
3. **No freshness guarantee at serve time, and no backstop.** The serve-time staleness overlay exists
   (`hydrate-facts.ts` `isStale` → `priceConfirmed:false` → the "current price needs confirming" sentinel,
   `brain.ts:139-145,207,211`) but defaults to a **1-hour** ceiling (`PRODUCT_FACTS_MAX_AGE_MS`,
   `server.ts:600`) and `PRODUCT_FACTS_HYDRATION` carries a D2 promotion-blocker (`hydrate-facts.ts:22-30`).
   No scheduled catalog reconcile job exists (only the CLI `pnpm catalog:index`); the ADR-0020 missed-event
   backstop (`docs/adr/0020-durable-grounding-at-scale.md:61-63`) is unbuilt.

Much scaffolding already exists inert: the webhook→queue→reconcile seam, the OIDC Pub/Sub push route
(`/internal/pubsub/catalog-reconcile`, smoke-verified), the ProductFacts poll-producer, and the
retention-sweep Cloud Run Job + Cloud Scheduler as a deploy template.

## 2. Decisions (settled with jason.hsu, 2026-08-16)

- **D-S3-scope — full freshness + deploy now.** All four pieces below ship in S3, and the scheduled backstop
  is actually deployed to staging (the job maintains the dark corpus; serving stays §5). Governance-touching
  (deploy + embedding spend) → **human-merged by jason.hsu**, and the `gcloud` applies are his.
- **D-S3-ledger — the authoritative id→contentHash ledger moves into RuntimeState KV** (chosen over adding a
  `listIds` to VectorPort). Reconcile diffs the ledger against the live catalog and never enumerates the
  vector store. Portable (no VectorPort change), identical on brute-force and pgvector, scales to 50k. See §B.
- **D-S3-targeted — webhooks carry changed product id(s); a fetch-by-id path refreshes only those SKUs.**
  Product-level topics resolve precisely; `INVENTORY_LEVELS_UPDATE` is a coarse (coalesced) signal because it
  carries an `inventory_item_id`, not a product id. See §C.
- **D-S3-ceiling — serve-time staleness ceiling = 15 min** (`PRODUCT_FACTS_MAX_AGE_MS` default 3_600_000 →
  900_000). This is the money safety net, independent of webhook/scheduler reliability. See §D.
- **D-S3-cadence — the scheduled backstop runs hourly.** Webhooks are the fast path; the 15-min serve-time
  ceiling is the safety net, so an hourly full reconcile is a sufficient missed-event backstop. See §E.

**Non-goals (S4 or later):** per-tenant `CATALOG_RETRIEVAL` enablement + retrieval-scoped kill (S4, and the
compensating controls PR #295 needs — still blocked); eval:/shadow: at scale (S4); flipping any serving flag;
`INVENTORY_LEVELS_UPDATE`→product precise mapping via the Admin token (S3 uses the coarse+ceiling approach).

---

## §B — ANN-safe reconcile (the corpus-state ledger)

**What:** persist, per tenant, the set of indexed record ids and their `contentHash` in RuntimeState KV, and
drive reconcile from it instead of `vector.query({text:""})`.

- **Storage.** A new KV record in the existing `catalog_index` collection (`MANIFEST_COLLECTION`), key
  `ledger` (chunked as `ledger:<NNNN>` if a tenant exceeds a size cap — a 50k id+hash map is a few MB; chunk
  at e.g. 10k entries/record to stay well under KV value limits). Written **in the same `store.tx`** as the
  manifest+audit (`catalog-index.ts:733-740,762-793`) so the ledger, manifest, and audit commit atomically.
  Shape: `{ version, at, entries: { "product:<id>": "<contentHash>", … } }`.
- **Reconcile diff (replaces `:508-551`).** Read the ledger (not the vector store). Given the live catalog
  plan:
  - `new = plan ids ∉ ledger` → embed + upsert.
  - `changed = plan ids where ledger.hash !== plan.hash` → embed + upsert.
  - `stale = ledger ids ∉ plan` → `deleteById(stale)`.
  - unchanged (`ledger.hash === plan.hash`) → skip embedding (preserves the existing contentHash
    optimization).
  Then rewrite the ledger to exactly the plan's ids+hashes.
- **Foreign-id guard preserved.** The current guard refuses to touch any existing id not prefixed `product:`
  (`:542-549`). The ledger only ever contains `product:*` ids we wrote, so the guard is intrinsic; keep an
  assertion.
- **Resync path.** `--reindex` does `deleteNamespace` + rebuilds the ledger from scratch (authoritative
  reset). A ledger/store drift (e.g. a crash between upsert and ledger write) self-heals on the next
  `--reindex`; the read-back verify (`:692-703`) still guards the upsert landing.
- **No enumerate anywhere.** After this change, `runCatalogIndex` never calls `query({text:""})`; grep-guard
  it in a test so the ANN-unsafe path can't return.
- **Migration.** First reconcile after S3 lands finds no ledger → treat as `new`-everything against the live
  catalog but DO NOT blind-delete (no ledger ⇒ unknown prior set); build the ledger from the plan and rely on
  the next `--reindex` (or a one-time bootstrap that reads the store once on the brute-force path only) to
  prune legacy orphans. Document the one-time bootstrap in the runbook.

**Tests (mock + real pgvector):** reconcile with a seeded ledger computes correct new/changed/stale;
`deleteById` receives exactly the stale set; a >5000-entry ledger reconcile runs on the **pgvector
testcontainer** with zero `query({text:""})` calls and no throw (the S2-parked bug, now closed); the
foreign-guard assertion; chunked-ledger round-trip; atomic ledger+manifest commit (a failed tx leaves both
unchanged).

---

## §C — Targeted by-id refresh + coalesce/debounce

**Webhook carries ids.** Extend `catalogReconcileMessage` / `CATALOG_RECONCILE_TOPIC` payload
(`catalog-webhook-queue.ts`) with `productIds?: string[]` and `reason: "product" | "inventory" | "full"`.
`handleCatalogChange` (`routes/shopify-webhooks.ts:377-390`) extracts the product id from the verified
payload body:
- `PRODUCTS_CREATE/UPDATE/DELETE` → the product `id` (precise; `reason:"product"`).
- `INVENTORY_LEVELS_UPDATE` → carries `inventory_item_id`, **not** a product id, and the Storefront delegate
  token cannot resolve it. It is recorded/coalesced but **does NOT trigger a per-event crawl** (a full poll
  per inventory tick would defeat the whole targeting goal and burn spend). Inventory/price freshness is
  covered by the **hourly backstop** (§E) + the **15-min serve-time ceiling** (§D) — a fact gone stale shows
  "current price needs confirming" until the next refresh, so a shopper is never quoted a stale price.
  (Optional future enhancement, not in S3: maintain an `inventory_item_id → productId` map during indexing to
  make this precise; deferred because it needs the Admin token and a new index.)

**Fetch-by-id path.** Add a `fetchProductsById(tenantId, ids[])` to the Shopify catalog source
(`shopify-grounding.ts`) using the Storefront `nodes(ids: [ID!])` / `product(id:)` query, returning the same
shape `runCatalogIndex` consumes. `reconcile(tenantId, { productIds })` (`server.ts:1069-1071`) becomes:
- `productIds` present → fetch only those, re-embed + upsert their rows, update their ProductFacts + ledger
  entries, `deleteById` any that came back missing/delisted. **No full-catalog crawl.**
- `PRODUCTS_DELETE` → `deleteById(product:<id>)` + drop the ledger entry directly (no fetch).
- absent/`reason:"full"` → the existing whole-catalog `runCatalogIndex` (the backstop path).

**Coalesce/debounce (per tenant).** A burst (bulk edit) must not fan out to N reconciles. Coalesce in the
consumer: accumulate changed ids per tenant over a short window (default 5 s, env
`CATALOG_RECONCILE_COALESCE_MS`) and process them as one batch; cap the batch (e.g. 500 ids) and spill to a
full reconcile above the cap. Dedup by `(tenantId, productId)`. The existing webhook-id dedup
(`shopify-webhooks.ts`) stays.

**Tests:** payload id-extraction per topic (incl. INVENTORY→coarse); `fetchProductsById` returns only asked
ids; targeted reconcile upserts/deletes exactly the changed set and touches no other row (spy the vector
store); PRODUCTS_DELETE prunes without a fetch; coalesce collapses a 50-id burst into one batched reconcile;
over-cap spills to full. All on the mock path; a pgvector-testcontainer variant for the targeted upsert/delete.

---

## §D — Serve-time staleness ceiling (≤15 min, fail-honest)

Mostly built; S3 tightens and clears the blocker:
- **Default 1h → 15 min.** `PRODUCT_FACTS_MAX_AGE_MS` default `3_600_000` → `900_000` (`server.ts:600`).
- **Always pass the window on the serve path.** Ensure the brain's hydrate call always receives
  `{ now, maxAgeMs }` when hydration is on, so a fact older than 15 min renders the "current price needs
  confirming" sentinel (`brain.ts:211`) and drops `availableForSale` — never a stale price (money/NN#1).
- **Clear the D2 promotion-blocker note** (`hydrate-facts.ts:22-30`): the fail-honest ceiling is now wired
  end-to-end; enabling `PRODUCT_FACTS_HYDRATION` becomes a §5 promotion step with the ceiling in force
  (record the precondition, don't flip the flag).

**Tests:** a fact at 14 min renders its price; at 16 min renders the sentinel + no availability; the S2
flag-off goldens stay byte-identical (hydration still gated). Money-facts §B gate stays green (the S2 owner
ruling stands).

---

## §E — Scheduled backstop (build + deploy)

Clone the proven retention-sweep deployment (`docs/DEPLOY.md:813-859`):
- **Cloud Run Job** `palup-catalog-index` running `pnpm catalog:index` (the existing CLI entrypoint;
  backstop = full reconcile per tenant, now ANN-safe via §B).
- **Cloud Scheduler** `palup-catalog-index-hourly` firing it hourly.
- **Least-privilege invoker SA** `palup-catalog-index-invoker@…` with `roles/run.invoker` only (mirrors
  `palup-sweep-invoker@`).
- **Runbook** in `docs/DEPLOY.md` + the exact `gcloud run jobs deploy` / `gcloud scheduler jobs create`
  commands surfaced for **jason to apply** (terraform not installed locally; applies are the owner's).
- **Known blind-spot (documented, not fixed here):** both jobs enumerate `SHOPIFY_STORES` for their tenant
  list (`catalog-index.ts:876-878`), so a self-installed merchant absent from that env is not reconciled
  (`DEPLOY.md:401-404`). Note as an S4/operational follow-up (the tenant list should come from the install
  registry).
- **Spend note (for the apply):** enabling the hourly job starts real Vertex embedding spend on the dark
  corpus (bounded: only changed hashes embed after the first run). The apply is the owner's cost decision.

**Tests:** the CLI job path is exercised by the §B/§C reconcile tests; a deploy-config test asserts the new
Cloud Run Job / Scheduler env matches the runbook (mirrors the existing `deploy-staging-env` test); no
serving flag added by the deploy config.

---

## §F — Governance & flags

- Building S3 crosses no serving HITL boundary (dark; default-off). **But** it is **human-merged by jason**
  (deploy infra + embedding spend + it touches the freshness/money surface), and the staging `gcloud` applies
  are his.
- Enabling `CATALOG_RETRIEVAL`/`VECTOR_ANN` to serve shoppers stays a §5 named-owner promotion.
- No governance flag flipped by any S3 code (`CATALOG_RETRIEVAL`/`VECTOR_ANN`/`MEMORY_ADR_ACCEPTED`/
  `PRODUCT_FACTS_HYDRATION` all stay as-is). Enabling `CATALOG_WEBHOOKS` + the scheduler in staging is part of
  the owner's apply.
- **#295 stays blocked** (needs S4's per-tenant flag + retrieval-scoped kill).
- Erasure (ADR-0015): the ledger is per-tenant KV; `deleteNamespace`/tenant erasure must also drop the tenant
  ledger record(s) — add to the erasure path + test.

## §G — Testing & CI

ATDD; `env -u GOOGLE_CLOUD_PROJECT` for all tests; mock path + the pgvector testcontainer merge-gate step
(the ledger reconcile at >5000 is the headline pgvector test). No real Vertex (fake embed). The seven
merge-gate steps unchanged; the pgvector step now also covers the ANN-safe reconcile.

## §H — Promotion preconditions (carried forward, for the §5 owner)

Unchanged from S2 §8, plus: (1) run the scheduler backstop (or a manual `pnpm catalog:index --reindex`) to
build a fresh ledger + corpus before enabling serving; (2) the `SHOPIFY_STORES` blind-spot means self-install
merchants aren't reconciled until the tenant-list-from-registry follow-up (S4).
