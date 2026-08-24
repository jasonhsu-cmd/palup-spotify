# Durable Product-Catalog Sync — Design (public-app scale)

**Date:** 2026-08-23
**Status:** Design (awaiting owner review → superseding ADR for 0020-D1 → writing-plans)
**Plane:** Build-time work producing run-time infra. Crosses no HITL money/model/business
boundary (§3 of CLAUDE.md). **Supersedes ADR-0020 D1** (Storefront-delegate-only, no persisted
Admin token) — that reversal is a governance/security decision requiring a superseding ADR +
`security-reviewer` pass + owner sign-off (see §6).
**Portability:** ADR-0001 — all Shopify access stays behind a port + adapter; store columns neutral.
**Author:** Claude Code (brainstorming → architectural path). Shopify facts verified on shopify.dev
2026-08-23 — see Appendix A.

---

## 1. Problem & scale target

PalUp's assistant grounds every answer in the merchant's product catalog. The end-state is a
**Shopify public app** on the App Store, installed on **millions of merchant stores** via OAuth,
serving **hundreds of millions of shoppers**, with catalogs up to (and past) the ~50k-SKU design
ceiling. Catalog sync must be correct and durable at that scale.

Today it is neither — catalog data reaches the assistant two ways, **neither a durable source of
truth**:

1. **Small catalogs (≤1000 SKUs)** — fetched live from the Shopify **Storefront API** on demand and
   memoized in a short-TTL cache (`shopify-grounding.ts` `storefrontFetch` ~:356, `MAX_CATALOG_PAGES
   = 4`; `grounding-cache.ts` TTL 1800s). On failure the assistant fails **closed** to an empty
   catalog — the shopper sees no products.
2. **Large catalogs (>1000 SKUs)** — indexed into pgvector (`jobs/catalog-index.ts`
   `runCatalogIndex`, `pgvector-store.ts` namespace `${tenant}::catalog`) with price/availability in
   `product_facts` (`postgres-product-facts-store.ts`). The pgvector row holds only **embedding +
   thin metadata** (`{productId, contentHash, title, variantId, imageUrl}`) — enough to *retrieve* an
   id, not to *render* a product. This is why the >1000-SKU sample store shows nothing unless
   retrieval is enabled (memory `storefront-demo-catalog-over-1000-skus`).

Why this fails the durability bar the owner set ("live chat must be durable, top-tier US sales
agent") **at public-app scale**:

- **A live Shopify dependency on the hot path.** Every cold-cache turn re-hits Shopify. A Shopify
  incident or throttle degrades the assistant directly. The ≤1000 path has **no local fallback**.
- **No local render/serving source of truth.** Full fields (description, handle, tags, variants,
  options, images, status) live only in Shopify.
- **No rate-limited Shopify client.** Backfill and delta both call Shopify directly with page caps
  and **no cost-aware throttle or backoff** — unsafe across millions of stores.
- **No scalable backfill.** Paging the Storefront API to load millions of large catalogs is the
  operational bottleneck; Shopify's answer (Bulk Operations) needs the Admin API, which ADR-0020 D1
  currently forbids persisting a token for.

## 2. Goal & non-goals

**Goal.** One **durable, per-tenant, local source of truth** for the catalog inside PalUp, designed
for the **public-app multi-tenant** end-state: backfilled once per shop from Shopify via Bulk
Operations, kept fresh by declarative webhook deltas through a **rate-limited** Shopify client, and
served to the assistant **from PalUp's own store** for every catalog size — so the shopper hot path
depends on **neither** Shopify surface.

**Non-goals:**
- Changing retrieval/ranking. pgvector stays the retrieval index; this changes where *render/serving*
  data comes from, not how candidates are *ranked*.
- Non-Shopify platform adapters. The port stays neutral (ADR-0001) so WooCommerce/BigCommerce drop
  in later; only the Shopify adapter is built here.
- Any HITL money/model/business surface. Catalog data is descriptive; nothing here auto-applies a
  §3-gated change.
- Enabling **production**. Staging first (owner directive: staging now, no real shoppers, defer
  legal/human gates to prod). Prod promotion + the D1-superseding ADR sign-off are §5/human steps.

## 3. Durability invariant (every component must meet this)

> **The assistant serves the catalog from PalUp's local store. A live Shopify call is only ever a
> background sync mechanism, never on the shopper's hot path. If Shopify is down, slow, or
> rate-limiting, the shopper still sees the full, last-known-good catalog.**

Corollaries:
- Serving reads hit Postgres only (`catalog_product` + `product_facts` + pgvector ids). No serving
  read calls Shopify.
- Every Shopify call (backfill + delta + reconcile) goes through **one** rate-limited client. No
  feature code calls Shopify directly.
- Freshness is eventually-consistent: a webhook delta updates the local store within seconds
  normally; if behind, the shopper sees slightly stale data, never *no* data. Staleness is
  observable via per-row `synced_at`, with a hard staleness ceiling on money facts (price/stock)
  that makes the agent say "let me confirm current price/availability" rather than quote a stale
  number (ADR-0020 D2 — fail-honest, NN#1).

## 4. Architecture

Three planes, cleanly separated by credential and by hot/cold path:

| Plane | When | Credential | Shopify surface |
|---|---|---|---|
| **Serving** | shopper hot path | none (local Postgres) | **none** |
| **Delta** | real-time, per shop | app-level (declarative webhooks) | Admin webhook delivery |
| **Sync** | background: install backfill + periodic reconcile | per-shop **offline Admin token** | Admin GraphQL (Bulk Operations) |

### 4.1 Serving plane — read local, default-on

Retrieval resolves candidate `product_id`s from pgvector (unchanged). The render/serving layer
hydrates those ids from `catalog_product` (full fields) + `product_facts` (fresh price/stock)
**locally**. The ≤1000-SKU path stops calling `storefrontFetch` on the hot path. Catalog serving is
**on by default** on staging once a tenant is backfilled (owner directive: all axes default-on on
staging); the enablement registry gates whether a tenant is *synced*, and `synced_at` gates
money-fact honesty.

### 4.2 `catalog_product` — the local render/serving source of truth (confirmed decision)

A dedicated per-tenant Postgres table, **alongside** (not replacing) the two existing stores:

| Store | Role | Change |
|---|---|---|
| **`catalog_product`** (NEW) | full product render/serving fields | net-new table + store module |
| pgvector `vp_ann` (`${tenant}::catalog`) | retrieval index (embeddings + thin metadata) | unchanged shape |
| `product_facts` | fast price/currency/availability (money-truth) | unchanged |

Columns (per tenant, keyed by `product_id`):

```
tenant_id, product_id (Shopify product GID, stable key)   -- PK (tenant_id, product_id)
handle, title, description_html, description_text
product_type, vendor, tags text[], status                 -- active | archived | draft
options jsonb                                              -- [{name, values[]}]
variants jsonb  -- [{variantId,title,sku,price,currency,availableForSale,imageUrl,options{}}]
                -- NOTE (security F8): persist the availableForSale BOOLEAN, not raw inventoryQty.
featured_image_url, image_urls text[], online_store_url
content_hash        -- delta short-circuit (mirrors the pgvector delta key)
synced_at timestamptz not null   -- staleness signal
deleted_at timestamptz           -- soft-delete tombstone
```

- **Variants inline as `jsonb`** — read as a unit when rendering one product; the money-hot fields
  (price/stock) also live in `product_facts` (unchanged, authoritative fast path). Both are written
  in the **same delta transaction** from the same payload, so they cannot disagree beyond one delta.
- **Soft delete** (`deleted_at`) so a concurrent serving read never 404s mid-delete and removals are
  auditable; a periodic prune hard-deletes rows past a retention window.
- **`content_hash` mirrors the pgvector delta key** so the existing "did it actually change?"
  short-circuit also guards the `catalog_product` upsert — no wasted writes.
- Columns are platform-neutral; Shopify field mapping lives only in the adapter.

### 4.3 Rate-limited Shopify client (NEW `shopify-client.ts`)

The **only** module that knows Shopify's rate-limit wire format. Behind the existing commerce/
grounding port. Owns (all fields VERIFIED, Appendix A):
- **Cost-aware throttling.** Admin GraphQL is a leaky-bucket *query-cost* model; the client reads
  `extensions.cost.throttleStatus` (`maximumAvailable`, `currentlyAvailable`, `restoreRate`) and
  paces to stay under the per-plan restore rate (50 / 200 / 1000 / 2000 pts/s). Limits are per
  **app+store**, so the budget is naturally per-tenant.
- **Bounded retry/backoff** on `THROTTLED` / 5xx / timeout, hard attempt cap, typed error upward
  (no infinite loop).
- **Single choke point** — backfill, reconcile, and any residual Storefront read share it.

Injectable `fetchFn` (mirrors `storefrontFetch`'s injection ~:357) so unit tests drive throttle
branches with a fake. Knows nothing about `catalog_product`.

**SSRF/egress discipline (ADR-0022 F4).** The client host-allowlists the Admin GraphQL endpoint
(byte-identical to the Storefront `SHOP_HOST` allowlist in `shopify-grounding.ts:204`) before
attaching the Admin token, https-+host-allowlists the Bulk-Operation result `url` (Shopify serves it
pre-signed from a CDN/GCS host — pin those), and **never attaches the Admin token to the result
download** (pre-signed; sending the token to a non-shop host would leak it). Token-free egress logs,
as today.

### 4.4 Backfill — Shopify Bulk Operations (extend `catalog-index.ts`)

One-time (and re-runnable/resumable) full load per shop uses **Bulk Operations** (VERIFIED:
Admin-GraphQL-only, async JSONL export) — not Storefront paging — so a 50k-SKU catalog loads in one
async job off PalUp's request budget:
1. `bulkOperationRunQuery` for all products+variants via the rate-limited client; poll for
   completion; download JSONL.
2. Upsert each product into `catalog_product` (+ `product_facts` + enqueue embedding for pgvector),
   `content_hash`-skipping unchanged rows on a re-run.
3. Record progress → idempotent, resumable.

Concurrency (VERIFIED, corrected from an earlier draft): API ≥2026-01 allows **up to 5 concurrent
bulk query operations per shop**; PalUp runs **one backfill per shop** and controls *fleet* fan-out
(how many shops backfill at once) in the scheduler (§5.3), not by per-shop concurrency. The
`MAX_INDEXED_PRODUCTS = 50000` ceiling still applies; exceeding it **logs the truncation explicitly**
(no silent cap — memory `open-findings-not-in-repo`).

### 4.5 Delta freshness — declarative webhooks → existing queue → extended reconcile

Reuses the existing path wholesale: `catalog-webhook-queue.ts` (message carries `productIds` +
`reason`) → `reconcileProducts` (delta by-id, content-hash short-circuit, upsert/delete). Changes:
1. **Persist full fields.** Extend `reconcileProducts` to also upsert the full `catalog_product` row
   (and set `deleted_at` on a delete) in the **same transaction** that writes pgvector + `product_facts`.
2. **Inventory deltas.** Subscribe `inventory_levels/update` so stock changes update `product_facts`
   (+ the `catalog_product` variant copy) without a full product refetch.
3. **Declarative subscription** (VERIFIED path): `products/create|update|delete` and
   `inventory_levels/update` declared in `shopify.app.toml [[webhooks.subscriptions]]`, pinned to a
   stable API version — Shopify auto-subscribes every shop at install (no per-shop API call). This
   **restores** the declarative webhooks the staging toml lost during the earlier config split.

HMAC verification reuses the existing verified adapter (`shopify-webhook-identity.ts`).

## 5. Public-app multi-tenant model (the part the first draft missed)

### 5.1 Per-shop token custody
A public app receives a **per-shop offline Admin access token** at OAuth install (VERIFIED: default
token, persists across sessions, for background/scheduled jobs). Under **managed install / token
exchange** it is a **refreshable expiring** offline token. Custody design:
- Stored **encrypted, per tenant, via the `CryptoPort`-backed `MerchantCredentialStore`** (the
  existing hardened pattern — AES-256-GCM envelope, per-tenant HKDF key, GCM AAD, atomic audited
  write), under a **distinct record key + key scope** from the storefront delegate token; **not** the
  read-only `SecretsPort` (it has no `put`). **Prod requires a KMS-backed `CryptoPort`.** Never in
  code/logs (CLAUDE.md §5). See ADR-0022 conditions F2.
- **Least privilege:** read-only Admin scopes `read_products`, `read_inventory` only — no write,
  order, or customer scope. Holding `read_inventory` does **not** authorize surfacing stock counts;
  the boolean `availableForSale` contract stays (ADR-0020 §8a). Staging's `write_*` scopes are
  dev-app-only and must be hard-excluded from prod (ADR-0022 F3).
- **Refresh** handled by the custody module (token-exchange refresh): persist non-secret `expiresAt`,
  single-flight per tenant, audited `token.refresh` (ADR-0022 F6).
- **Revoke — two-step by signal trust (ADR-0022 F1):** `app/uninstalled` (unsigned shop header) →
  **reversible** halt sync + `setStatus(uninstalled)` + tombstone only. **`shop/redact`** (HMAC-covered
  `shop_domain`, ~48h post-uninstall) → **irreversible** token hard-delete + catalog retire. A replayed
  `app/uninstalled` with a spoofed header thus cannot destroy an arbitrary tenant's token/catalog.

### 5.2 Compliance webhooks (App Store requirement)
Public-app listing requires subscribing `customers/data_request`, `customers/redact`, `shop/redact`
(VERIFIED). These are **not catalog-specific** but are a listing prerequisite and interact with
`shop/redact` (erase a shop's catalog + token on request). Handlers must return 401 on bad HMAC,
200 on success. This spec **notes** them as a dependency of shipping a public app; the erasure/legal
semantics are owner/legal-gated (deferred to prod).

### 5.3 Fleet backfill scheduling
Backfilling millions of shops is orchestrated, not on-demand:
- Backfill is triggered at install (offline token available) and re-runnable for periodic full
  reconcile (repairs missed webhooks — inevitable at fleet scale).
- A scheduler bounds **how many shops** backfill concurrently (protects PalUp's own compute + the
  embedding pipeline), independent of Shopify's per-shop 5-op allowance.
- Each backfill is idempotent/resumable (§4.4) so a crash resumes without duplication.
- **In-flight halt (ADR-0022 F5):** backfill/reconcile re-check the kill switch + enablement **and**
  token presence between steps (per page/poll) and abort promptly; a **sync-plane-scoped** kill exists
  (distinct from the serving-plane kill), and no job continues on a cached token after delete.

### 5.4 Serving stays local (scale payoff)
With the local store, the **Storefront delegate token's hot-path role disappears** — shopper serving
touches neither Shopify surface. The Admin token is a **sync-plane-only** credential. This is what
makes the assistant durable under a Shopify outage across the whole fleet.

## 6. Governance — this supersedes ADR-0020 D1

ADR-0020 D1 chose "reads on the Storefront delegate token, **no persisted offline Admin token**,
declarative webhooks only" for **lowest blast radius** on a single/dev store. For a public app at
$30B scale that is the wrong end-state, because (a) a public app **already** receives an offline
Admin token at install, (b) the Storefront API has **no bulk export** so fleet backfill needs Bulk
Operations (Admin-only), and (c) fleet-scale missed webhooks require periodic full reconcile, also
Admin-only.

**Required before this ships:**
1. A **superseding ADR** (0020-D1 → new ADR) recording: persist a per-shop offline Admin token,
   read-only `read_products`/`read_inventory`, encrypted secrets-port custody, refresh + revoke-on-
   uninstall, kill-switch + audit. Named human owner (governance-touching).
2. A **`security-reviewer`** pass on the token-custody design (storage, rotation, revocation, blast
   radius, kill switch).
3. **Owner sign-off** on the D1 reversal.

Other §3 checks:
- **§3.1 money/model/business:** none crossed. Catalog data is descriptive; price *display* comes
  from `product_facts` (already exists, not a decision surface).
- **Portability (ADR-0001):** all Shopify access behind the client/adapter; neutral store columns.
- **Kill switch / audit:** sync is a background job under the enablement registry + kill switch;
  disabling a tenant halts sync and serving falls back to last-known-good local data. Every
  backfill/delta/token action logs to the audit log (actor, input, decision, reversal).
- **Secrets:** Admin token + any delegate token via the secrets port; never in code/logs.

## 7. Reuse vs. net-new

**Reuse unchanged:** pgvector store, `product_facts`, webhook→queue plumbing
(`catalog-webhook-queue.ts`), HMAC adapter (`shopify-webhook-identity.ts`), grounding cache as a
thin read cache in front of the local store (or retire it — §12), enablement registry, kill switch.

**Extend:** `reconcileProducts` (persist full `catalog_product` + inventory deltas);
`catalog-index.ts` backfill (Bulk Operations + write `catalog_product`); serving path
(`shopify-grounding.ts` / catalog-retriever) to read local; `shopify.app.toml` (restore declarative
webhook subscriptions).

**Net-new:** `catalog_product` table + migration + store module (`state-postgres`);
`shopify-client.ts` rate-limited client; Bulk-Operations backfill driver; inventory-delta
application; per-shop Admin-token custody (mint/store/refresh/revoke behind the secrets port);
`app/uninstalled` handler; fleet backfill scheduler; serve-from-local read path.

## 8. Component boundaries (isolation & testability)

- **`catalog-product-store.ts`** (`state-postgres`) — CRUD over `catalog_product`
  (`upsert`/`softDelete`/`getByIds`/`listByTenant`/`pruneTombstoned`) behind a narrow interface.
  Tested with the pgvector testcontainer already in the gate. Knows nothing about Shopify.
- **`shopify-client.ts`** — only module that knows Shopify's rate-limit + Bulk-Op wire format.
  Injectable `fetchFn`. Knows nothing about `catalog_product`.
- **token-custody module** — mint/store/refresh/revoke behind the secrets port; the only module that
  holds the Admin token. Knows nothing about SQL or catalog shape.
- **backfill driver / fleet scheduler** — orchestrate client → store; no wire-format or SQL of their own.
- **delta extension** — inside `reconcileProducts`; one transaction writes all three stores.
- **serving read** — depends only on the three stores, never the client or token module.

Each unit answers *what it does / how you call it / what it depends on*, and none reaches across a
boundary (adapter never touches SQL; store never touches Shopify; serving never touches a token).

## 9. Data flow

```
INSTALL (per shop):
  OAuth (managed install / token exchange) → offline Admin token → secrets port (encrypted)
  declarative webhooks auto-subscribed by Shopify

BACKFILL (install + periodic reconcile, fleet-scheduled):
  scheduler → backfill driver → shopify-client (bulkOperationRunQuery, throttled)
    → JSONL → upsert catalog_product + product_facts + enqueue embed → pgvector

DELTA (steady state):
  Shopify products/* or inventory_levels/update webhook → HMAC verify (existing adapter)
    → catalog-webhook-queue → reconcileProducts (content-hash short-circuit)
        → upsert/softDelete catalog_product + product_facts + re-embed pgvector   [one txn]

SERVE (hot path, NO Shopify call):
  shopper turn → retrieval (pgvector candidate ids)
    → hydrate from catalog_product + product_facts (local) → assistant grounds answer

UNINSTALL:
  app/uninstalled webhook → delete token + halt sync + retire catalog (retention policy)
```

## 10. Error handling & durability

- **Shopify throttled/down during backfill/delta:** the client backs off within its cap; local
  store serves last-known-good. A stuck delta raises `synced_at` age (observable/alertable); money
  facts past the staleness ceiling flip to "let me confirm" (fail-honest). Never blanks the catalog.
- **Missed webhook (inevitable at fleet scale):** the periodic Bulk reconcile repairs it; a delta
  for an unknown product self-heals (fetch + insert).
- **Product deleted in Shopify:** `deleted_at` tombstone; serving filters it; prune after retention.
- **Backfill exceeds the 50k ceiling:** truncate + **log explicitly** (no silent cap).
- **Token expired/revoked:** refresh; on `app/uninstalled` or refresh failure, halt sync + surface
  a re-auth signal — never fall back to a live shopper-path Shopify call.
- **Cold start (not yet backfilled):** serving returns empty **only** for a not-yet-synced tenant
  (matches today); the fix is enable/backfill, not a hot-path live fetch.

## 11. Testing (ATDD — tests first, CLAUDE.md §4)

Each acceptance criterion → a test that fails before implementation:
- **Store:** upsert/get/soft-delete/prune round-trips (pgvector testcontainer); tenant isolation
  (A never reads B); `content_hash` short-circuit skips an unchanged upsert.
- **Rate-limited client:** fake `fetchFn` — a `THROTTLED` response backs-off-then-retries; the
  attempt cap surfaces a typed error (no infinite loop); pacing respects a configured restore rate.
- **Backfill:** a fake bulk JSONL loads N products into all three stores; a re-run with unchanged
  hashes does zero rewrites; exceeding the ceiling logs the truncation.
- **Delta:** a product-update webhook updates all three stores in one transaction; a delete
  tombstones; an `inventory_levels/update` webhook updates stock without a full refetch.
- **Token custody:** token stored via the `CryptoPort`-backed store is encrypted-at-rest (never
  plaintext in logs) under a distinct key scope; `app/uninstalled` performs **reversible** halt only
  (a replayed spoofed-header uninstall does **not** delete a victim's token), while `shop/redact`
  performs the irreversible delete + retire; a refresh path renews an expiring token, single-flight
  and audited.
- **SSRF/egress (F4):** the Admin client rejects a non-allowlisted host; the Bulk result-`url`
  download rejects a non-allowlisted host and carries no Admin token.
- **Serving durability (encodes §3):** with the Shopify client stubbed to **throw on every call**, a
  shopper turn still returns the full catalog from the local store.
- **Portability:** no feature/serving module imports a Shopify symbol directly (grep-guard, mirroring
  the existing scope-pinning test precedent).
- **Least-privilege scope pin:** the app declares no scope beyond `read_products`, `read_inventory`
  (+ the already-authorized staging set) — extend the existing `order-attribution-scope-pinning`
  precedent.

Gate: full local `merge-gate.sh` (typecheck, unit, eval, 4× e2e, pgvector testcontainer). Never set
`GOOGLE_CLOUD_PROJECT` for the gate (memory `merge-gate-mock-path`).

## 12. Rollout

- **Staging first.** The staging dev app is **increment 1** of the public-app design — a single
  tenant with its own offline token, exercising the exact same code path, not a different
  architecture.
- Backfill `palup-skincare-jason` (the >1000-SKU staging store that today shows no products) as the
  first real exercise; success = storefront + assistant show products with no live Shopify call on
  the hot path.
- **Production** promotion, the D1-superseding ADR sign-off, the `security-reviewer` custody pass,
  compliance-webhook legal semantics, and any prod scope/PCD questions are deferred to §5/human
  steps — out of scope for the build.

## 13. Open items to verify during writing-plans (not assert from memory)

1. Exact current signatures of `reconcileProducts`, `runCatalogIndex`, and the serving entry point —
   read before extending (files named in §1/§7).
2. Managed-install token-exchange refresh mechanics (endpoint, expiry, refresh trigger) — confirm on
   shopify.dev before coding the custody module.
3. Exact `bulkOperationRunQuery` lifecycle (poll field names, `url` expiry, partial-result handling).
4. Whether `grounding-cache.ts` stays in front of the local store or is retired (measure a local
   Postgres read; don't assume).
5. Per-topic webhook→scope strings — re-confirm the D1 verification (2026-08-07) still holds for the
   pinned API version.

---

## Appendix A — Shopify facts verified 2026-08-23 (shopify.dev)

| # | Fact | Verdict | Source |
|---|---|---|---|
| 1 | Public app gets a per-shop **offline** Admin token at install; persists across sessions; for background/scheduled jobs. Managed install → refreshable expiring offline token. | VERIFIED | shopify.dev/docs/apps/build/authentication-authorization/access-tokens |
| 2 | Bulk Operations = **Admin GraphQL only**, not Storefront; async **JSONL**. | VERIFIED | shopify.dev/docs/api/usage/bulk-operations/queries |
| 3 | Concurrency: API **≥2026-01 allows up to 5 concurrent bulk query ops per shop** (pre-2026-01 was one-per-type). | VERIFIED (corrects an earlier draft) | same as #2 |
| 4 | Storefront API has **no** bulk equivalent; full reads = cursor pagination. | VERIFIED | #2 + shopify.dev/docs/api/usage/pagination-graphql |
| 5 | `read_products` covers Product+ProductVariant (bulk query OK). Per-topic webhook→scope strings not verbatim-quotable now, but ADR-0020 D1 verified them 2026-08-07. | PARTIAL (treat as consistent-with-docs + prior verification) | shopify.dev/docs/api/usage/access-scopes |
| 6 | Uninstall fires `app/uninstalled`; token access ends on uninstall/secret revoke. | VERIFIED | webhook reference + access-tokens page |
| 7 | Webhooks declarable in `shopify.app.toml [[webhooks.subscriptions]]`; Shopify auto-subscribes each shop at install. | VERIFIED | shopify.dev/docs/apps/build/webhooks/subscribe |
| 8 | App Store compliance webhooks: `customers/data_request`, `customers/redact`, `shop/redact`. | VERIFIED | shopify.dev/docs/apps/build/privacy-law-compliance |
| 9 | Admin rate limit = leaky bucket, cost points, restore 50/200/1000/2000 pts/s by plan; `extensions.cost.throttleStatus` = `{maximumAvailable, currentlyAvailable, restoreRate}`; per app+store. | VERIFIED | shopify.dev/docs/api/usage/limits |

shopify.dev pages show no publication date; all fetched 2026-08-23. Assistant knowledge cutoff
Jan 2026 — facts above are from live fetches, not memory.
