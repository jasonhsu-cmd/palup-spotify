# Credential-and-Enrollment Unification — Design (single Admin token, one ingestion pipeline)

**Date:** 2026-08-24
**Status:** Design (awaiting: ADR amendment for the sole-credential decision → `security-reviewer` → user review → writing-plans). Gated on a refresh-mechanics verification spike (§10) before the cutover is written.
**Plane:** Build-time work producing run-time infra. No §3 money/model/business boundary crossed. Portability-constrained (ADR-0001). Composes with the merged #439 sync plane (`docs/adr/0022-...`, `docs/superpowers/specs/2026-08-23-durable-catalog-sync-design.md`).
**Author:** Claude Code (brainstorming → architectural path).

---

## 1. Problem

At the target scale — **millions of Shopify merchants** — the current catalog/credential wiring cannot work, and it is already failing:

- **Credentials live in two places that desync.** The live serving path reads a merchant's Storefront token from the **DB credential store** (behind `MERCHANT_CRED_READBACK_ENABLED`, default off), but the background `catalog-index` job reads it from a **`PALUP_SECRETS` JSON map keyed by tenant** (`merchant-store.ts` `resolveShopifyStore`). The moment a merchant reinstalls (new delegate token in the DB), the env map goes stale. **This exact failure blocked `palup-skincare-jason` this session: the job fetched the store with a stale `PALUP_SECRETS` token and got `403`.**
- **No fleet enumeration.** `MerchantRegistryPort` has only point lookups — no `list`/`listActive` (a cross-tenant scan was deliberately withheld). So jobs enumerate tenants from a **hand-maintained `SHOPIFY_STORES` env list** (`tenantsToIndex`, `tenantsToSweep`). You cannot hand-list millions of merchants.
- **Two ingestion pipelines with two credentials.** The legacy Storefront `runCatalogIndex` builds the pgvector retrieval corpus with the **Storefront delegate** token; #439's Admin Bulk backfill fills `catalog_product`/`product_facts` with the **Admin** token. Two fetch paths, two tokens, two things to keep in sync.

Consequence: onboarding is manual (add to `SHOPIFY_STORES` + `PALUP_SECRETS`), reinstalls silently break catalogs, and the retrieval corpus + render store can diverge. None of it scales.

## 2. Goal & non-goals

**Goal.** One durable credential-and-enrollment model that scales to millions with **zero per-merchant ops** and **no desync on reinstall/rotation**:
- **One credential per merchant** — the DB-custodied **Admin offline token** (read-only `read_products`/`read_inventory`), with refresh + revoke (#439's `admin-token-store`). The Storefront delegate token is **retired**.
- **One ingestion pipeline** — an Admin/Bulk driver that fetches each catalog **once** and writes **all four local stores**: `catalog_product`, `product_facts`, the **pgvector embedding corpus**, and a per-tenant **`store_profile`** (brand + policy). The legacy Storefront crawl is retired.
- **Automatic enrollment** — install already writes a registry row + custodies the token; jobs **discover merchants from the registry** via a new `listActive(cursor)`.
- **Serving 100% local** — the shopper hot path reads only local stores; no Shopify surface, ever.

**Non-goals:** changing the retrieval/ranking model; non-Shopify platform adapters (the port stays neutral); any HITL money/model/business surface; enabling anything in **production** (staging-first; prod is a separate §5 human promotion, separate DB + key material).

## 3. Locked decisions (from brainstorming)

- **(B) Converge to one ingestion pipeline** (not just unify credential access).
- **(i) Single Admin token; retire the Storefront delegate**; serving fully local, incl. brand/policy.
- **(i) Governed `listActive(cursor)` on the registry** (paginated, active-only, secret-free, audited) — one merchant list, cannot drift.
- **Approach B — big-bang unified rewrite** (single cutover), with two non-negotiable safety guards baked in (§9): a **refresh-mechanics verification** before the cutover is written, and a **one-flag rollback** (old Storefront code stays in-tree for one release).

## 4. Architecture

One unified catalog-sync pipeline. Per merchant, exactly one Shopify credential — the DB-custodied Admin offline token. One ingestion driver fetches via Bulk Operations and writes four local stores. The fleet scheduler discovers merchants via `listActive`. Serving reads local only. The same cutover **removes** the Storefront crawl, the Storefront delegate token, the `PALUP_SECRETS`-per-tenant token path, and `SHOPIFY_STORES` tenant enumeration.

Planes (credential + hot/cold path):

| Plane | When | Credential | Shopify surface |
|---|---|---|---|
| Serving | shopper hot path | none (local Postgres) | **none** |
| Delta | real-time per shop | app-level declarative webhooks | Admin webhook delivery |
| Sync | background: install backfill + periodic reconcile | per-shop **Admin offline token** (DB) | Admin GraphQL (Bulk Operations) |

## 5. Components (with current seams)

- **Registry enumeration (net-new).** Add to `MerchantRegistryPort` (`platform-ports/src/merchant-registry-port.ts:139-162`) and `PostgresMerchantRegistry` (`state-postgres/src/postgres-merchant-registry.ts:183`):
  `listActive(opts: { cursor?: string; limit?: number }): Promise<{ items: { tenantId: string; shopDomain: string; status: MerchantStatus }[]; nextCursor?: string }>` — cursor-paginated (keyset on `tenant_id`), `status='active'` only, returns only the secret-free allowlist columns (never a token), one audited call per page. This is the deliberately-withheld cross-tenant surface, added as a governed enumeration (see §8).
- **`store_profile` store (net-new).** Per-tenant `{ brandName, policy: { returns, shipping, allergens? } }` in Postgres (or a `RuntimeStatePort` KV), written by ingestion, read by serving `getShell`. Replaces the Storefront `getShell` fetch.
- **Unified ingestion driver.** Generalize #439's `runCatalogBackfill` (`widget-backend/src/jobs/catalog-backfill.ts`) to be the single ingestion: Admin-Bulk fetch → map to rich records → write `catalog_product` + `product_facts` + **embed → pgvector** + `store_profile`. Content-hash short-circuit; idempotent/resumable; `MAX_INDEXED_PRODUCTS=50000` cap with explicit truncation log. The **embedding step moves here** (it was deliberately skipped in #439) — embeddings computed from the Admin-shape text (title + tags + description).
- **Delta/reconcile.** Extend `reconcileProducts` (`catalog-index.ts`) so a webhook re-fetches the changed products in the full Admin shape (the `catalogProductAdminSource` seam #439 added) and writes all four stores; inventory-level deltas update `product_facts` + the variant copy.
- **Admin-token lifecycle (finish #439).** Turn on custody-at-install (`ADMIN_TOKEN_CUSTODY_ENABLED`); implement + **verify** managed-install token-exchange **refresh** (single-flight, audited — `admin-token-refresh.ts`); revoke on `shop/redact` (already two-step per ADR-0022 F1).
- **Serving.** The local grounding port (`widget-backend/src/local-catalog-grounding.ts`) serves `getContext`/`getProductsByIds`/`getShell` entirely from `catalog_product` + `product_facts` + `store_profile` + pgvector. The retrieval render path hydrates from `catalog_product` (from #439 Task 8b). The Storefront adapter (`shopify-grounding.ts` `createShopifyGroundingAdapter`) is removed from the serving path.
- **Scheduler.** `catalog-sync-scheduler.ts` (#439) enumerates via `listActive` (replacing `SHOPIFY_STORES`), bounded fleet concurrency, sync-plane kill scope (`agent:catalog-sync`), per-tenant kill/enablement re-checks between steps.
- **Removal (same cutover).** Delete: the Storefront crawl (`runCatalogIndex` + `shopifyCatalogSource`), `resolveShopifyStore` + the `PALUP_SECRETS` Storefront-token read (`merchant-store.ts:94-160`), `SHOPIFY_STORES` tenant enumeration (`tenantsToIndex`, `tenantsToSweep` → use `listActive`), and the Storefront **delegate-token mint** at install (`shopify-install.ts` `createDelegateAccessToken` + its `credentials.put`). `retention-sweep` enumerates via `listActive` too.

## 6. Data flow

```
INSTALL:  OAuth → Admin offline token → DB (admin-token-store)  +  registry row (create/activate)

SYNC (scheduler):  listActive(cursor) → per tenant → getFreshAdminToken → Bulk Operations fetch
                    → catalog_product + product_facts + pgvector(embed) + store_profile   [one pass]

DELTA:    products/* or inventory webhook → HMAC verify → queue → reconcile (Admin re-fetch)
                    → same four stores

SERVE (hot path, NO Shopify):  shopper → retrieval (pgvector ids) → hydrate catalog_product + product_facts;
                    getShell → store_profile; getContext ≤cap → local. Never a live Shopify call.
```

## 7. Error handling

- **Admin fetch/refresh failure:** serving stays on last-known-good local data — there is **no live fallback anymore** (the delegate path is gone), so a failed sync degrades freshness, never availability. A failed refresh **halts sync + raises a re-auth signal**; it must never trigger a hot-path Shopify call (structurally impossible — serving holds no Shopify credential).
- **Not-yet-synced tenant:** serving returns fixtures/empty until the first sync completes (matches today for an unindexed tenant).
- **Truncation** at the 50k ceiling: explicit log + audit (no silent cap).
- **Enumeration:** always cursor-paginated; no unbounded scan; a page failure is retried, not fatal to the fleet run.
- **Per-tenant isolation:** every store + `listActive` binds tenant; a blank tenant fails closed.

## 8. Governance

- **§3 boundaries:** none crossed (catalog data is descriptive; price display remains `product_facts`, an existing non-decision surface).
- **ADR amendment required.** Making the Admin token the **sole** Shopify credential retires the delegate-token least-privilege read posture that ADR-0020 D1 established and ADR-0022 partly retained. That is a deliberate governance change → a **new/superseding ADR** + a **`security-reviewer`** pass (token now single point of catalog access; confirm read-only scope, custody, refresh, revoke, blast radius). The `listActive` enumeration surface is recorded in the same ADR (why the withheld cross-tenant scan is now offered, in governed/paginated/secret-free form).
- **Least privilege:** Admin scopes stay `read_products`/`read_inventory` only; write scopes remain staging-dev-app-only and excluded from prod (existing scope-pinning test, extended).
- **Kill switch / audit:** sync under the enablement registry + `agent:catalog-sync` kill; every mint/refresh/revoke/backfill/delta/enumeration audited (NN#5). Serving falls back to last-known-good local on any halt.
- **Secrets:** Admin token via the CryptoPort-backed store (distinct key scope, ADR-0022 F2); prod requires KMS-backed CryptoPort + separate DB/key material (F9). Prod enable = separate human promotion.

## 9. Migration / cutover (Approach B — big-bang, with guards)

Single cutover, but not reckless:
1. **Refresh-verification spike (gating, §10):** confirm managed-install token-exchange refresh mechanics on shopify.dev + a live dev-store exchange **before** the cutover code is written. We are retiring the fallback; the Admin-refresh path must be proven, not assumed (verify-before-ship).
2. Build the unified pipeline + `listActive` + `store_profile` + serving-local + removals as one program, behind a single **`CATALOG_UNIFIED`** cutover flag.
3. **Rollback lever:** keep the old Storefront crawl + delegate path in the tree (dormant) for **one release**; the cutover flag flips serving/sync to the unified path. If staging misbehaves, flip back. Delete the dormant Storefront code in a **follow-up** PR once the unified path is proven on staging.
4. Staging cutover on `palup-skincare-jason` first (its Admin token is already custodied from this session's install) — this is the durable fix for the `403` that blocked it.
5. Production is a separate §5 human promotion.

## 10. Open items to verify at implementation (not asserted from memory)

1. ~~Managed-install token-exchange refresh mechanics — gates the cutover.~~ **VERIFIED (spike, shopify.dev 2026-08-24, `.../authentication-authorization/access-tokens`):**
   - Public apps must use the **expiring** offline Admin token: `expires_in=3600` (1h). Non-expiring offline tokens are being retired for public apps — **migrate by January 2027**.
   - The expiring offline token comes with a **`refresh_token`** (`refresh_token_expires_in=7776000` → **90 days**). Refresh is **server-side, no user**: "When no merchant session is active, such as for background jobs and webhooks, use the stored `refresh_token` to renew an expiring offline token server-side, without user interaction." Each refresh mints a fresh token+refresh_token; older ones are retired immediately (one refreshable offline token per app+store).
   - Fallback when the 90-day `refresh_token` has lapsed (plane idle >90 days) OR during an active embedded session: **re-run token exchange** with a fresh session ID token (needs a merchant session).
   - Errors: `401 Unauthorized` = token expired; `403 Forbidden` = valid token, insufficient access.
   - **Decisive: Admin-token-only (no Storefront fallback) is VIABLE — QUALIFIED.** Design must therefore: (a) request `expiring=1` at install and **store the `refresh_token` + both expiries** (a schema addition to `admin-token-store`, which today holds only the access token + `expiresAt`); (b) run a **mandatory refresh loop** (refresh before `expires_in`, single-flight per tenant, audited); (c) on `refresh_token` lapse / a `401` with no valid refresh_token, **halt sync + raise a re-auth signal** (never a hot-path fetch); (d) not depend on any non-expiring/static token.
   - Live dev-store confirmation deferred to staging-enable time (per the pre-flight ruling — needs the DB-custodied token + deploy access).
2. Whether the Admin **Bulk/GraphQL** response can supply **brand name + shop policies** for `store_profile` (else a small separate Admin query at sync time). Confirm on shopify.dev.
3. `bulkOperationRunQuery` lifecycle + `nodes(ids:)` shape (carried from #439 — still not live-verified).
4. Keyset-pagination shape for `listActive` against the real `pl_merchant` table at scale (index on `(status, tenant_id)`).
5. That no consumer outside the two known Storefront-token call sites + the `SHOPIFY_STORES` enumerators breaks when the env paths are removed (grep-guarded removal tests).
