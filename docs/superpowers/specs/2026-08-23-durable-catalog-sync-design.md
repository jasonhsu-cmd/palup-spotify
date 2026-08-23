# Durable Product-Catalog Sync — Design

**Date:** 2026-08-23
**Status:** Design (awaiting owner review → writing-plans)
**Plane:** Build-time work producing run-time infra. Touches no HITL money/model/business
boundary (§3). Portability-constrained (ADR-0001): all Shopify access stays behind a port/adapter.
**Author:** Claude Code (brainstorming → architectural path)

---

## 1. Problem

PalUp's assistant grounds every answer in the merchant's product catalog. Today catalog data
reaches the assistant two different ways, and **neither is a durable source of truth**:

1. **Small catalogs (≤1000 SKUs)** are fetched live from the Shopify Storefront API on demand and
   memoized in a short-TTL cache (`shopify-grounding.ts` `storefrontFetch` at ~:356,
   `MAX_CATALOG_PAGES = 4`; `grounding-cache.ts` TTL 1800s). If the live fetch fails the assistant
   fails **closed** to an empty catalog — the shopper sees no products.
2. **Large catalogs (>1000 SKUs)** are indexed into pgvector for retrieval
   (`jobs/catalog-index.ts` `runCatalogIndex`, `pgvector-store.ts` namespace `${tenant}::catalog`)
   with price/availability in a side table (`postgres-product-facts-store.ts` `product_facts`).
   But the pgvector row holds only an **embedding plus thin metadata**
   (`{productId, contentHash, title, variantId, imageUrl}`) — not enough to *render* a product,
   and the >1000-SKU path is the reason the sample storefront shows nothing unless catalog
   retrieval is enabled (see memory `storefront-demo-catalog-over-1000-skus`).

Consequences that block the durability bar the owner set ("live chat must be durable, top-tier
US sales agent"):

- **A live-API dependency on the hot path.** Every cold cache turn re-hits Shopify. Shopify rate
  limits (Storefront API cost-based throttle) or a Shopify incident degrades the assistant
  directly. There is **no local fallback** for the ≤1000 path.
- **No single render/serving source of truth.** Full product fields (description, handle, tags,
  variants, options, images) live only in Shopify. pgvector has enough to *retrieve* an id but not
  to *show* the product; `product_facts` has price/availability but not descriptive fields.
- **No rate-limited Shopify client.** Backfill (`runCatalogIndex`) and delta reconcile
  (`reconcileProducts`) both call Shopify directly with page caps (`MAX_INDEX_CATALOG_PAGES = 200`,
  `MAX_CATALOG_PAGES = 4`) and **no cost-aware throttle or backoff** — fine at demo scale, unsafe
  at "millions of merchants."

## 2. Goal & non-goals

**Goal.** One **durable, per-tenant, local source of truth** for the product catalog inside
PalUp: backfilled once from Shopify, kept fresh by incremental webhook deltas through a
**rate-limited** Shopify client, and served to the assistant **from PalUp's own store** for every
catalog size — so the hot path never depends on a live Shopify call.

**Non-goals (explicitly out of scope for this spec):**

- Changing the retrieval/ranking model. pgvector + embeddings stay the retrieval index; this spec
  changes where *rendering/serving* data comes from, not how candidates are *ranked*.
- Multi-platform adapters beyond Shopify. The port stays platform-neutral (ADR-0001) so a future
  WooCommerce/BigCommerce adapter drops in, but only the Shopify adapter is built here.
- Any HITL money/model/business surface. Catalog data is descriptive, not a money/agent-autonomy
  boundary; nothing here auto-applies a §3-gated change.
- Enabling anything in **production**. This targets **staging** (owner directive: staging now, no
  real shoppers, defer legal/human gates to prod). Prod promotion stays a §5 human step.

## 3. Durability invariant (the bar every component must meet)

> **The assistant serves the catalog from PalUp's local store. A live Shopify call is only ever a
> background freshness mechanism, never on the shopper's hot path. If Shopify is down, slow, or
> rate-limiting, the shopper still sees the full, last-known-good catalog.**

Corollaries:
- Reads for serving hit Postgres only (the new `catalog_product` table + `product_facts` +
  pgvector for candidate ids). No serving read calls Shopify.
- Every Shopify call (backfill + delta) goes through **one** rate-limited client with cost-aware
  throttling and bounded retry/backoff. No feature code calls `fetch(shopify)` directly.
- Freshness is eventually-consistent: a webhook delta updates the local store within seconds under
  normal load; if the delta pipeline is behind, the shopper sees slightly stale data, never *no*
  data. Staleness is observable (a per-product `synced_at`).

## 4. Chosen approach — Option A: one persistent per-tenant catalog store

Rejected alternatives (from brainstorming):
- **Option B — keep live-fetch, just cache harder.** Longer TTLs reduce Shopify hits but keep the
  live dependency on the cold path and still fail closed. Doesn't meet the invariant.
- **Option C — index everything into pgvector including full render fields.** Overloads the vector
  store with non-embedding data it isn't shaped for, couples rendering to the retrieval index, and
  still leaves the ≤1000 path on live fetch. Rejected.

Option A backfills each tenant's catalog once into a **local render/serving source of truth**,
keeps it fresh with **incremental deltas**, and serves **all catalog sizes** from the local store.

### 4.1 Store shape — dedicated `catalog_product` table (confirmed decision)

A dedicated per-tenant Postgres table is the render/serving source of truth, **alongside** (not
replacing) the two existing stores, each keeping its current job:

| Store | Role after this change | Change |
|---|---|---|
| **`catalog_product`** (NEW) | Full product render/serving fields — the source of truth for *showing* a product | net-new table + store module |
| **pgvector** `vp_ann` (`${tenant}::catalog`) | Retrieval index — embeddings + thin metadata to resolve *which* product ids match a query | unchanged shape; still delta-maintained |
| **`product_facts`** | Fast price/currency/availability lookup (already the money-truth channel) | unchanged; already delta-maintained |

`catalog_product` columns (per tenant, keyed by `product_id`):

```
tenant_id            text      not null
product_id           text      not null          -- Shopify product GID, stable key
handle               text      not null          -- URL/permalink handle
title                text      not null
description_html     text                          -- rendered body
description_text     text                          -- plain-text, for grounding snippets
product_type         text
vendor               text
tags                 text[]                         -- for filtering/facets
status               text      not null            -- active | archived | draft
options              jsonb                          -- [{name, values[]}]
variants             jsonb     not null            -- [{variantId, title, sku, price, currency,
                                                   --   availableForSale, inventoryQty, imageUrl, options{}}]
featured_image_url   text
image_urls           text[]
online_store_url     text                          -- canonical storefront URL when present
content_hash         text      not null            -- for delta short-circuit (mirrors pgvector)
synced_at            timestamptz not null          -- last successful sync of THIS row (staleness signal)
deleted_at           timestamptz                    -- soft-delete tombstone (product removed in Shopify)
primary key (tenant_id, product_id)
```

Notes:
- **Variants inline as `jsonb`.** Variants are read as a unit when rendering one product and rarely
  queried across products; a child table would add a join for no serving benefit. Price/availability
  that *is* queried hot stays in `product_facts` (unchanged). The `variants` jsonb is the render
  copy; `product_facts` remains the authoritative fast-path for price/stock. Both are written in the
  same delta transaction from the same Shopify payload, so they cannot disagree beyond one delta.
- **Soft delete, not hard delete.** `deleted_at` tombstones a product removed in Shopify so a
  concurrent serving read never 404s mid-delete and so we can audit removals; a periodic prune
  hard-deletes rows tombstoned longer than a retention window.
- **`content_hash` mirrors the pgvector delta key** so the same "did this product actually change?"
  short-circuit that already guards embedding recompute (`reconcileProducts`) also guards the
  `catalog_product` upsert — no wasted writes.
- Portable shape: columns are platform-neutral; the Shopify-specific field mapping lives only in the
  adapter. A future platform adapter fills the same columns.

### 4.2 Rate-limited Shopify client (NEW `shopify-client.ts`)

One module wraps every Shopify Admin/Storefront/Bulk call behind the existing port. It owns:
- **Cost-aware throttling.** Shopify's Admin GraphQL uses a leaky-bucket *query cost* model; the
  client reads `extensions.cost.throttleStatus` from each response and paces to stay under the
  restore rate. (Exact fields verified against shopify.dev before implementation — flagged as a
  fact-check item, not asserted from memory.)
- **Bounded retry/backoff** on `THROTTLED` and 5xx/timeout, with a hard attempt cap; surfaces a
  typed error upward rather than looping.
- **A single choke point** so backfill and delta share one budget per tenant and cannot collectively
  overrun Shopify.

All existing direct Shopify calls (`runCatalogIndex`, `reconcileProducts`, `storefrontFetch`) are
refactored to route through this client. This is the "no un-throttled Shopify call" half of the
durability invariant.

### 4.3 Backfill — Shopify Bulk Operations (extend `catalog-index.ts`)

The one-time (and re-runnable) full load uses **Shopify Bulk Operations** (async JSONL export of
the whole catalog) instead of paging the Storefront API, so a large catalog backfills in one bulk
job rather than hundreds of throttled pages. The backfill:
1. Kicks off a bulk query for all products+variants, polls for completion via the rate-limited
   client, downloads the JSONL result.
2. Upserts each product into `catalog_product` (+ `product_facts` + enqueues embedding for pgvector),
   using `content_hash` to skip unchanged rows on a re-run.
3. Records progress so a re-run is idempotent and resumable.

`MAX_INDEXED_PRODUCTS = 50000` (existing ceiling) still applies as a safety cap; when a catalog
exceeds it the backfill logs the truncation explicitly (no silent cap — memory
`open-findings-not-in-repo` names silent truncation as a standing hazard).

### 4.4 Delta freshness — extend the existing webhook→queue→reconcile path

The delta pipeline already exists and is reused wholesale:
`catalog-webhook-queue.ts` (message carries `productIds` + `reason`) → `reconcileProducts`
(delta by-id, content-hash short-circuit, upsert/delete). Two extensions:
1. **Persist full fields.** `reconcileProducts` currently writes pgvector thin-metadata +
   `product_facts`; extend it to also upsert the full `catalog_product` row (and set `deleted_at`
   on a delete) in the same transaction, from the same fetched payload.
2. **Inventory deltas.** Subscribe the inventory-level webhook topic so stock changes update
   `product_facts` (and the `catalog_product` variant copy) without a full product refetch.

Webhook subscription + HMAC verification reuse the existing verified adapter
(`shopify-webhook-identity.ts`) and the compliance-webhook requirements already documented there.
No new scope is required for product/inventory webhooks (`read_products`, `read_inventory` — both
already declared on the staging app).

### 4.5 Serving — read local, default-on

A serving seam returns catalog data for the assistant from `catalog_product` + `product_facts` +
pgvector candidate ids, **never** a live Shopify call. Concretely:
- Retrieval resolves candidate `product_id`s from pgvector as today.
- The render/serving layer hydrates those ids from `catalog_product` (full fields) and
  `product_facts` (fresh price/stock) locally.
- The ≤1000-SKU path stops calling `storefrontFetch` on the hot path; it reads the same local store.
  `storefrontFetch` survives only as a backfill/delta fetch behind the rate-limited client.

Because the store is local and durable, catalog serving is **on by default** on staging (owner
directive: all axes enabled by default on staging). The existing enablement registry gates whether
a tenant's catalog is *backfilled/synced*; once synced, serving from local is the default.

## 5. Reuse vs. net-new (grounded in the reuse inventory)

**Reuse unchanged:** pgvector store (`pgvector-store.ts`), `product_facts`
(`postgres-product-facts-store.ts`), webhook→queue plumbing (`catalog-webhook-queue.ts`),
HMAC/webhook identity adapter (`shopify-webhook-identity.ts`), grounding cache wrapper
(`grounding-cache.ts`) as a thin read cache in front of the local store, the enablement registry.

**Extend:** `reconcileProducts` (persist full `catalog_product` fields + inventory deltas);
`catalog-index.ts` backfill (Bulk Operations + write `catalog_product`); the serving path
(`shopify-grounding.ts` / catalog-retriever) to read local instead of live.

**Net-new:** `catalog_product` table + migration + store module (in `state-postgres`);
`shopify-client.ts` rate-limited client (behind the existing commerce/grounding port);
Bulk-Operations backfill driver; inventory-delta application; serving-from-local read path.

## 6. Component boundaries (isolation & testability)

- **`catalog-product-store.ts`** (`state-postgres`) — CRUD over `catalog_product` behind a narrow
  interface (`upsert`, `softDelete`, `getByIds`, `listByTenant`, `pruneTombstoned`). Testable with
  the pgvector testcontainer already in the gate. Knows nothing about Shopify.
- **`shopify-client.ts`** — the only module that knows Shopify's rate-limit wire format. Injectable
  `fetchFn` (mirrors the existing `storefrontFetch` injection at ~:357) so unit tests drive throttle
  branches with a fake. Knows nothing about `catalog_product`.
- **backfill driver** — orchestrates client → store; no wire-format or SQL of its own.
- **delta extension** — lives inside `reconcileProducts`; one transaction writes all three stores.
- **serving read** — depends only on the three stores, never the client.

Each unit answers: *what it does / how you call it / what it depends on* — and none reaches across
a boundary (adapter never touches SQL; store never touches Shopify).

## 7. Data flow

```
BACKFILL (once / re-runnable):
  enablement=on → backfill driver → shopify-client (Bulk Op, throttled)
    → JSONL → upsert catalog_product + product_facts + enqueue embed → pgvector

DELTA (steady state):
  Shopify product/inventory webhook → HMAC verify (existing adapter)
    → catalog-webhook-queue (productIds+reason)
    → reconcileProducts (content-hash short-circuit)
        → upsert/softDelete catalog_product + product_facts + re-embed pgvector  [one txn]

SERVE (hot path, NO Shopify call):
  shopper turn → retrieval (pgvector candidate ids)
    → hydrate from catalog_product + product_facts (local)
    → assistant grounds answer
```

## 8. Error handling & durability behavior

- **Shopify throttled/down during backfill or delta:** the rate-limited client backs off and
  retries within its cap; the local store keeps serving last-known-good. A stuck delta raises the
  per-product `synced_at` age, which is observable/alertable — it never blanks the catalog.
- **Delta arrives for an unknown product (never backfilled):** reconcile fetches and inserts it
  (self-healing); a missed webhook is repaired by the next touch or a periodic reconcile sweep.
- **Product deleted in Shopify:** `deleted_at` tombstone; serving filters tombstoned rows; prune
  removes them after the retention window.
- **Bulk backfill exceeds the 50k ceiling:** truncate + **log explicitly** (no silent cap).
- **Cold start with an empty local store (not yet backfilled):** serving returns empty **only** for
  a tenant with catalog sync not yet enabled — matches today's behavior for that tenant, and the
  fix is to enable/backfill, not a live-fetch fallback that would reintroduce the dependency.

## 9. Testing (ATDD — tests first, per CLAUDE.md §4)

Acceptance criteria → tests, each failing before implementation:

- **Store:** upsert/get/soft-delete/prune round-trips against the pgvector testcontainer; tenant
  isolation (tenant A never reads tenant B); `content_hash` short-circuit skips an unchanged upsert.
- **Rate-limited client:** with a fake `fetchFn`, a `THROTTLED` response triggers backoff-then-retry;
  the attempt cap surfaces a typed error, not an infinite loop; cost pacing stays under a configured
  restore rate.
- **Backfill:** a fake bulk JSONL loads N products into all three stores; a re-run with unchanged
  hashes performs zero rewrites; exceeding the ceiling logs the truncation.
- **Delta:** a product-update webhook payload updates `catalog_product` + `product_facts` + pgvector
  in one transaction; a delete tombstones; an inventory-level webhook updates stock without a full
  product refetch.
- **Serving durability (the invariant):** with the Shopify client stubbed to **throw on every
  call**, a shopper turn still returns the full catalog from the local store. This is the test that
  encodes §3.
- **Portability:** no feature/serving module imports a Shopify symbol directly (grep-style guard,
  mirroring the existing scope-pinning test precedent).

Gate: the full local `merge-gate.sh` set (typecheck, unit, eval, 4× e2e, pgvector testcontainer).
Never set `GOOGLE_CLOUD_PROJECT` for the gate (memory `merge-gate-mock-path`).

## 10. Rollout

- Staging only. Catalog serving-from-local default-on once a tenant is backfilled; enablement
  registry gates backfill/sync per tenant.
- Backfill `palup-skincare-jason` (the >1000-SKU staging store) as the first real exercise — this
  is exactly the store that today shows no products on the sample storefront
  (memory `storefront-demo-catalog-over-1000-skus`); success = the storefront and assistant show
  products with no live Shopify call on the hot path.
- Production promotion (and any prod Shopify scope/PCD questions) is deferred to a §5 human step,
  out of scope here.

## 11. Governance check

- **§3 boundaries:** none crossed. Catalog data is descriptive; no pricing/margin/marketing/model
  change auto-applies. (Price *display* comes from `product_facts`, which already exists and is not
  a decision surface.)
- **Portability (ADR-0001):** all Shopify access behind the client/adapter; store columns neutral.
- **Least privilege:** no new Shopify scope (`read_products`, `read_inventory` already granted on
  staging). No customer/order scope involved.
- **Kill switch / audit:** sync is a background job under the existing enablement registry; disabling
  a tenant halts sync; serving then reads last-known-good local data. Backfill/delta actions log.
- **Secrets:** Shopify credentials via the existing secrets port; never in code/logs.

## 12. Open items to verify during writing-plans (not assert from memory)

1. Shopify Admin GraphQL cost/throttle response fields + Bulk Operations lifecycle — confirm on
   shopify.dev before coding `shopify-client.ts`.
2. Exact current signatures of `reconcileProducts` and `runCatalogIndex` and the serving entry
   point — read before extending (files named in §1/§5).
3. Whether `grounding-cache.ts` should remain in front of the local store or be retired (a local
   Postgres read may be fast enough to drop the cache layer — measure, don't assume).
