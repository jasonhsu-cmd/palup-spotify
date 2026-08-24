# Credential-and-Enrollment Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Converge PalUp's catalog sync onto one DB-custodied Admin token per merchant and one ingestion pipeline that writes all four local stores, with jobs discovering merchants from the registry — so it scales to millions with zero per-merchant ops and never desyncs on reinstall.

**Architecture:** One Admin/Bulk ingestion driver fetches each catalog once and writes `catalog_product`, `product_facts`, the pgvector embedding corpus, and a new per-tenant `store_profile` (brand/policy). The fleet scheduler enumerates active merchants via a new governed `MerchantRegistryPort.listActive(cursor)`. Serving is 100% local. The Storefront delegate token, the legacy Storefront crawl, `PALUP_SECRETS`-per-tenant tokens, and `SHOPIFY_STORES` lists are retired (made dormant behind the cutover flag; deleted in a follow-up).

**Tech Stack:** TypeScript (ESM, `.js` specifiers), Node + Fastify (widget-backend), Postgres via the `Sql` abstraction (pglite in tests, node-postgres in prod), pgvector, `@palup/platform-ports` ports + adapters, vitest.

**Spec:** `docs/superpowers/specs/2026-08-24-credential-enrollment-unification-design.md`
**Composes with:** the merged #439 sync plane (`docs/superpowers/specs/2026-08-23-durable-catalog-sync-design.md`, `docs/adr/0022-per-shop-admin-token-for-catalog-sync.md`).

## Global Constraints

*Every task's requirements implicitly include this section (verbatim from the spec/ADR/CLAUDE.md).*

- **Single credential:** the DB-custodied Admin offline token (`admin-token-store`, record key `admin_offline`, scope `admin-cred`) is the ONLY Shopify credential the catalog lifecycle uses. Read-only scopes `read_products`, `read_inventory`. The Storefront delegate token is retired.
- **Serving hot path calls NO Shopify** and holds no Shopify credential; a failed sync/refresh never falls back to a live fetch (there is no fallback anymore).
- **Enumeration:** jobs discover merchants ONLY via `MerchantRegistryPort.listActive` (cursor-paginated, active-only, secret-free, audited) — never `SHOPIFY_STORES`.
- **Cutover safety (Approach B guards):** (1) the refresh-mechanics spike (Task 0a) gates writing Task 6/7; (2) everything ships behind one `CATALOG_UNIFIED` flag, old Storefront code stays dormant in-tree for one release (deletion is a separate follow-up PR).
- **Tenant isolation:** every store + `listActive` binds tenant; blank tenant fails closed.
- **Portability (ADR-0001):** all Shopify access via the client/adapter; store columns neutral.
- **Data minimization (F8):** `availableForSale` boolean only; no raw stock. **Audit (NN#5):** mint/refresh/revoke/backfill(+truncation)/delta/enumeration audited.
- **Governance:** ADR amendment (Task 0b) + `security-reviewer` gate shipping the sole-credential change. No prod enable (F9: separate DB + KMS CryptoPort + human promotion).
- **Test commands:** `pnpm test` (root vitest, `PGVECTOR_TESTCONTAINER=off`); `pnpm vitest run <path>` to scope. NEVER set `GOOGLE_CLOUD_PROJECT`. Full gate before merge: `merge-gate.sh`.

---

## File Structure

**Net-new:**
- `packages/platform-ports/src/store-profile-port.ts` — `StoreProfilePort`, `StoreProfileRecord`, `createInMemoryStoreProfileStore`.
- `packages/platform-ports/contract/store-profile-port.contract.ts` — shared contract.
- `packages/state-postgres/src/postgres-store-profile-store.ts` — `PostgresStoreProfileStore` (table `store_profile`).

**Modified:**
- `packages/platform-ports/src/merchant-registry-port.ts` — add `listActive`.
- `packages/state-postgres/src/postgres-merchant-registry.ts` — implement `listActive` (keyset pagination); `packages/state-postgres/src/index.ts` — exports.
- `packages/widget-backend/src/jobs/catalog-backfill.ts` — unified ingestion: build pgvector embeddings + write `store_profile`.
- `packages/widget-backend/src/jobs/catalog-index.ts` — reconcile writes `store_profile`; `shopifyCatalogSource`/`tenantsToIndex` made dormant behind the flag.
- `packages/widget-backend/src/jobs/catalog-sync-scheduler.ts`, `retention-sweep.ts` — enumerate via `listActive`.
- `packages/widget-backend/src/local-catalog-grounding.ts` — `getShell` from `store_profile`.
- `packages/widget-backend/src/admin-token-refresh.ts` — finalize refresh per Task 0a.
- `packages/widget-backend/src/routes/shopify-install.ts` — custody Admin token ON; delegate-mint gated off under `CATALOG_UNIFIED`.
- `packages/widget-backend/src/model.ts`, `server.ts` — `CATALOG_UNIFIED` cutover; wire `listActive`/`store_profile`; serving local; retire delegate/`PALUP_SECRETS` reads (dormant).
- `packages/widget-backend/test/order-attribution-scope-pinning.test.ts` — extend removal/scope guards.
- `docs/adr/0023-single-admin-credential-and-registry-enumeration.md` — new ADR (Task 0b).

---

## Phase 0 — Gating (must complete before Phase 2)

### Task 0a: SPIKE — verify managed-install token-exchange refresh mechanics

**This is a feasibility spike, not a TDD build.** Output is a written finding that Task 6 consumes. Do not write cutover code.

- [ ] **Step 1: Investigate on shopify.dev** (primary sources, cite URLs + dates): for a managed-install / token-exchange app, (a) does the offline Admin token expire, and if so how is it refreshed (endpoint, grant type, request/response shape)? (b) does exchanging a session token yield a fresh offline token, and what binds it to a shop? (c) what does an expired/invalid Admin token return (401/403 shape)?
- [ ] **Step 2: Confirm against the live dev store** (`palup-skincare-jason`, Admin token already custodied this session): make one authenticated Admin GraphQL call with the custodied token; confirm it works (or reproduces the refresh need).
- [ ] **Step 3: Record findings** in the spec's §10 (edit the spec) as VERIFIED facts with citations: the exact refresh mechanism (or "offline tokens do not expire under our install model → refresh is a no-op / re-auth-on-uninstall only").
- [ ] **Step 4: Decision gate.** If refresh is a well-defined exchange → Task 6 implements it. If offline tokens are non-expiring under our model → Task 6 degrades `getFreshAdminToken` to read-only (no refresh) + document. **If managed-install cannot yield a usable long-lived Admin token at all → STOP: Approach B (retire the fallback) is unsafe; escalate to the human to reconsider keeping the delegate (design decision (ii)).**
- [ ] **Step 5: Commit** the spec edit — `docs(catalog): record verified Shopify Admin-token refresh mechanics (spike)`.

### Task 0b: ADR amendment + security-reviewer

- [ ] **Step 1: Write `docs/adr/0023-single-admin-credential-and-registry-enumeration.md`** (Proposed): records (a) the Admin token becomes the SOLE Shopify credential, retiring the delegate least-privilege read posture of ADR-0020 D1 / ADR-0022; (b) the registry gains a governed `listActive` enumeration (paginated, active-only, secret-free, audited) — why the withheld cross-tenant scan is now offered. Cross-reference ADR-0022. Named human owner.
- [ ] **Step 2: Run the `security-reviewer` subagent** on the ADR + this plan's credential/enumeration surface. Fold conditions into the ADR's "conditions" section.
- [ ] **Step 3: Owner sign-off** flips the ADR to Accepted. (Human gate — not a build agent's.)
- [ ] **Step 4: Commit** — `docs(adr): ADR-0023 single Admin credential + governed registry enumeration`.

---

## Phase 1 — Buildable now (independent of the refresh outcome)

### Task 1: `MerchantRegistryPort.listActive` (governed enumeration)

**Files:** Modify `packages/platform-ports/src/merchant-registry-port.ts`; the in-memory registry (same file / its factory); `packages/state-postgres/src/postgres-merchant-registry.ts`; Test: `packages/state-postgres/test/postgres-merchant-registry.listactive.test.ts` + a port-contract case.

**Interfaces:**
- Produces: `listActive(opts?: { cursor?: string; limit?: number }): Promise<{ items: MerchantSummary[]; nextCursor?: string }>` where `MerchantSummary = { tenantId: string; shopDomain: string; status: "active" }`. Default `limit` 500, max 1000.

- [ ] **Step 1: Write the failing contract test** — seed 3 active + 1 uninstalled merchant; `listActive({limit:2})` returns 2 active items + a `nextCursor`; a second call with that cursor returns the 3rd active item, no uninstalled, no `nextCursor`; assert no token/secret field is present on any item.
- [ ] **Step 2: Run → FAIL** (`pnpm vitest run packages/state-postgres/test/postgres-merchant-registry.listactive.test.ts`).
- [ ] **Step 3: Add `listActive` to the port interface** (`merchant-registry-port.ts`) + the in-memory adapter (filter `status==="active"`, sort by tenantId, slice by cursor).
- [ ] **Step 4: Implement in `PostgresMerchantRegistry`** — keyset pagination: `SELECT tenant_id, shop_domain, status FROM pl_merchant WHERE status='active' AND tenant_id > $cursor ORDER BY tenant_id ASC LIMIT $limit`; `nextCursor` = last `tenant_id` when a full page returned. Add index `CREATE INDEX IF NOT EXISTS pl_merchant_active_idx ON pl_merchant (status, tenant_id)` in `migrate()`. Return only the three allowlist columns. Audit one `registry.list_active` entry per call.
- [ ] **Step 5: Run → PASS**; then `pnpm vitest run packages/state-postgres` (no regression); barrel export if needed.
- [ ] **Step 6: Commit** — `feat(registry): governed listActive(cursor) enumeration (paginated, active-only, secret-free)`.

### Task 2: `store_profile` store (brand + policy, local)

**Files:** Create `packages/platform-ports/src/store-profile-port.ts`, `contract/store-profile-port.contract.ts`, `packages/state-postgres/src/postgres-store-profile-store.ts`; Modify `platform-ports/src/index.ts`, `state-postgres/src/index.ts`; Test: `packages/platform-ports/test/store-profile-port.test.ts`, `packages/state-postgres/test/postgres-store-profile-store.test.ts`.

**Interfaces:**
- Produces: `StoreProfileRecord = { brandName: string; policy: { returns: string; shipping: string; allergens?: string } }`; `StoreProfilePort = { get(tenantId): Promise<StoreProfileRecord | null>; put(tenantId, profile): Promise<void>; deleteTenant(tenantId): Promise<void> }`; `createInMemoryStoreProfileStore()`.

- [ ] **Step 1: Write failing port test + contract** — put/get round-trip; tenant isolation; blank tenant throws; `get` on missing → `null`.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement the port + in-memory ref** (mirror `product-facts-port.ts` shape) + exports.
- [ ] **Step 4: Implement `PostgresStoreProfileStore`** (mirror `PostgresCatalogProductStore`): table `store_profile (tenant_id text NOT NULL, brand_name text, policy jsonb, updated_at timestamptz, PRIMARY KEY (tenant_id))`; `get`/`put` (upsert)/`deleteTenant`; `requireTenant` guard; barrel export. Run the shared contract against pglite.
- [ ] **Step 5: Run → PASS** (`pnpm vitest run packages/platform-ports/test/store-profile-port.test.ts packages/state-postgres/test/postgres-store-profile-store.test.ts`).
- [ ] **Step 6: Commit** — `feat(ports,state-postgres): store_profile store (brand + policy) for local getShell`.

### Task 3: Unified ingestion — embeddings + store_profile from the Admin path

**Files:** Modify `packages/widget-backend/src/jobs/catalog-backfill.ts` (+ `catalog-index.ts` reconcile write-site); Test: `packages/widget-backend/test/catalog-backfill-unified.test.ts`.

**Interfaces:**
- Consumes: `StoreProfilePort` (Task 2); the existing embed path (`ModelPort.embed` + `VectorPort.upsert` used by `catalog-index.ts`); `runCatalogBackfill` deps (#439).
- Produces: backfill writes `catalog_product` + `product_facts` + **pgvector embeddings** + `store_profile` in one pass.

- [ ] **Step 1: Write failing tests** — with a fake bulk JSONL (2 products) + a fake embed model + in-memory vector/store_profile: assert (a) the pgvector corpus namespace `${tenant}::catalog` receives embeddings (was skipped in #439); (b) `store_profile` gets brand/policy; (c) content-hash re-run embeds zero.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.** In `runCatalogBackfill`: after writing `catalog_product`/`product_facts`, compute embedding text (title + tags + description) per product and `vector.upsert(catalogNamespace(tenant), records)` (reuse `catalog-index.ts`'s embed helpers + `contentHash` short-circuit + manifest so the retriever's manifest check passes); fetch shop brand/policy from the Admin response (or a small Admin query — per spec §10.2 verify shape) and `storeProfile.put(tenant, ...)`. Thread `storeProfile` + the embed deps into the backfill deps + the reconcile path (`catalog-index.ts`).
- [ ] **Step 4: Run → PASS**; run existing catalog-backfill/catalog-index tests (no regression).
- [ ] **Step 5: Commit** — `feat(widget-backend): unified ingestion builds pgvector corpus + store_profile from the Admin path`.

> **Implementation note (spec §10.2):** confirm whether Admin Bulk/GraphQL returns shop brand + policies; if not, add a one-shot Admin `shop`/`shopPolicies` query. Do not fabricate the field shape — verify on shopify.dev.

### Task 4: Serving — local `getShell` from `store_profile`

**Files:** Modify `packages/widget-backend/src/local-catalog-grounding.ts`; Test: `packages/widget-backend/test/local-catalog-grounding-shell.test.ts`.

- [ ] **Step 1: Write failing test** — `createLocalCatalogGroundingPort` with an in-memory `store_profile` (brand "Acme", policy set) → `getShell(tenant)` returns that brand/policy **with no shellSource/Shopify call**; missing profile → neutral default (degrade, not throw).
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.** Add a `storeProfile` dep to the local grounding port; `getShell` reads it (fallback to the neutral default #439 already returns); remove the storefront `shellSource` dependency from the local path.
- [ ] **Step 4: Run → PASS**; `pnpm test` for grounding regressions.
- [ ] **Step 5: Commit** — `feat(widget-backend): serve brand/policy from local store_profile (no Storefront on the hot path)`.

### Task 5: Scheduler + retention-sweep enumerate via `listActive`

**Files:** Modify `packages/widget-backend/src/jobs/catalog-sync-scheduler.ts`, `packages/widget-backend/src/jobs/retention-sweep.ts`; Test: extend their test files.

**Interfaces:** Consumes `listActive` (Task 1).

- [ ] **Step 1: Write failing tests** — the scheduler, given a fake registry with 3 active tenants across 2 `listActive` pages, processes all 3 (no `SHOPIFY_STORES` needed); retention-sweep enumerates the same way; a `nextCursor` loop terminates.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.** Add a `registry: Pick<MerchantRegistryPort,"listActive">` dep; replace `tenantsToIndex()`/`tenantsToSweep()` enumeration with a `listActive` cursor loop (keep the old env-based function exported-but-unused, dormant, for the rollback release). Re-check kill/enablement per tenant as today.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `feat(widget-backend): scheduler + retention-sweep enumerate merchants via registry listActive`.

---

## Phase 2 — Refresh + cutover (consume Phase 0; gated on Task 0a/0b)

### Task 6: Admin-token refresh (refresh_token grant) + custody-at-install ON

**Files:** Modify `packages/state-postgres/src/admin-token-store.ts` (schema: add `refresh_token` + expiries), `packages/widget-backend/src/admin-token-refresh.ts`, `packages/widget-backend/src/routes/shopify-install.ts`; Test: `admin-token-store.test.ts` (extend), `admin-token-refresh.test.ts` (extend).

**Verified mechanics (spec §10.1, spike 2026-08-24):** public-app offline token is **expiring** (`expires_in=3600`) with a **`refresh_token`** (`refresh_token_expires_in=7776000` = 90d). Refresh server-side via the stored `refresh_token` (no user); each refresh mints a fresh token+refresh_token (old retired). On `refresh_token` lapse / `401` with no valid refresh_token → **halt sync + re-auth signal** (never a hot-path fetch). `401`=expired, `403`=insufficient.

- [ ] **Step 1: Extend `admin-token-store` schema + API (failing test first).** Store `{ token, expiresAt, refreshToken?, refreshTokenExpiresAt? }` (refreshToken encrypted like the access token; expiries non-secret). `read` returns them; add `refresh(tenantId, { token, expiresAt, refreshToken, refreshTokenExpiresAt }, {actor})` audited `admin_token.refresh`. Test: round-trip incl. refreshToken; refresh replaces both; atomicity (audit-fail rolls back) as in #439.
- [ ] **Step 2: Run → FAIL; implement the store change; PASS.**
- [ ] **Step 3: Refresh loop (failing test, injected exchange fn — endpoint-independent).** `getFreshAdminToken(tenantId)`: if the access token is within a skew window of `expiresAt`, refresh via `exchange` using the stored `refreshToken`; single-flight per tenant; persist via `tokens.refresh`; if `refreshToken` is absent/expired (90d) OR read is `unreadable` → **throw a re-auth-required error** (halt sync, never fall back). Tests: two concurrent calls → one `exchange`; refresh persists + audits; lapsed refresh_token → re-auth error, no `exchange`; valid token in-window → returned without `exchange`.
- [ ] **Step 4: Run → FAIL; implement; PASS.**
- [ ] **Step 5: Install requests the expiring offline token + stores the refresh_token.** In `shopify-install.ts`, request `expiring=1` at token exchange and custody `{ token, expiresAt, refreshToken, refreshTokenExpiresAt }` via `adminTokens.put`; confirm `ADMIN_TOKEN_CUSTODY_ENABLED` wired in server composition. Test: install custodies the refresh_token + expiries (extend the install-admin-token test).
- [ ] **Step 6: Run → PASS + `pnpm typecheck`.**
- [ ] **Step 7: Commit** — `feat: admin-token refresh_token grant lifecycle (store+refresh+install) per verified Shopify mechanics`.

> Note: the exact token-exchange HTTP request/response shape (`grant_type=urn:ietf:params:oauth:grant-type:token-exchange`, `requested_token_type=...offline-access-token`, `expiring=1`, and the refresh_token grant) is quoted in spec §10.1 — implement `exchange` to that shape; tests inject a fake `exchange` so they don't depend on hitting live Shopify.

### Task 7: `CATALOG_UNIFIED` cutover wiring

**Files:** Modify `packages/widget-backend/src/model.ts`, `server.ts`, `routes/shopify-install.ts`; Test: `packages/widget-backend/test/server-catalog-unified-wiring.test.ts`.

- [ ] **Step 1: Write failing wiring test** — with `CATALOG_UNIFIED=true`: serving routes grounding to the local port for every backfilled tenant (no Storefront adapter constructed); install does NOT mint a delegate token; scheduler/reconcile deps carry `storeProfile` + embeds. With the flag off: behavior is byte-identical to today (rollback path intact).
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** the `CATALOG_UNIFIED` flag: flips serving to local (incl. `store_profile` getShell), routes ingestion through the unified backfill, gates the delegate mint OFF at install, wires `listActive` into the scheduler. Old paths remain constructed only when the flag is off (dormant, for rollback).
- [ ] **Step 4: Run → PASS** + `pnpm test`.
- [ ] **Step 5: Commit** — `feat(widget-backend): CATALOG_UNIFIED cutover flag (local serving, Admin-only ingestion, delegate mint off)`.

### Task 8: Removal guards (dormant-for-one-release)

**Files:** Modify `packages/widget-backend/test/order-attribution-scope-pinning.test.ts` (+ a new removal-guard test); no deletion yet.

- [ ] **Step 1: Write failing guard tests** — assert that under `CATALOG_UNIFIED` the serving + ingestion + scheduler paths have NO reference to `resolveShopifyStore`/`PALUP_SECRETS` Storefront token or `SHOPIFY_STORES` tenant enumeration (grep-style, mirroring the scope-pinning precedent); assert the app still declares only read-only scopes.
- [ ] **Step 2: Run → FAIL** (until Task 7's wiring removes those refs from the unified path).
- [ ] **Step 3: Make green** by ensuring the unified path is clean (it should be after Task 7; fix any residual ref). Leave the dormant old code in place (deletion = follow-up PR after one release, per the rollback guard).
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `test(widget-backend): removal guards — unified path uses no PALUP_SECRETS/SHOPIFY_STORES (rollback code stays dormant)`.

### Task 9: Compose, migrate, enable on staging + durability test

**Files:** Modify `packages/widget-backend/src/server.ts`; Test: `packages/widget-backend/test/unified-durability.test.ts`.

- [ ] **Step 1: Write the durability test (encodes the invariant)** — with Shopify stubbed to throw on every call and `CATALOG_UNIFIED=true`, a backfilled tenant's `getContext`, retrieval hydration, AND `getShell` all return full local data (products + brand/policy) with zero Shopify calls.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** any remaining composition wiring (construct `store_profile` store + `.migrate()`; inject `listActive`, `storeProfile`, embeds into the ingestion/scheduler; distinct admin crypto scope). 
- [ ] **Step 4: Run → PASS**; then full `pnpm test` + `pnpm typecheck`; then `merge-gate.sh`.
- [ ] **Step 5: Commit** — `feat(widget-backend): wire credential-and-enrollment unification behind CATALOG_UNIFIED`.
- [ ] **Step 6: Staging enablement (operator/human, not code)** — flip `CATALOG_UNIFIED` + `ADMIN_TOKEN_CUSTODY_ENABLED` on the staging service; run the unified ingestion for `palup-skincare-jason` (Admin token already custodied → no 403); verify the widget shows products + brand/policy with no live Shopify. Production is a separate §5 human promotion (separate DB + KMS CryptoPort).

---

## Self-Review

**Spec coverage:** single Admin credential → Tasks 6,7,8 + ADR 0b; one ingestion pipeline (embeddings + store_profile) → Task 3; listActive enumeration → Task 1 (+5); store_profile/local getShell → Tasks 2,4; retire Storefront/PALUP_SECRETS/SHOPIFY_STORES → Tasks 7,8 (dormant) ; refresh lifecycle → Task 6 (gated by 0a); serving-local durability → Tasks 4,9; ADR amendment + security-reviewer → 0b; cutover + rollback guard → Task 7; refresh spike gate → 0a. All spec sections mapped.

**Placeholder scan:** no TBD/TODO as work items. Task 0a is a spike (output feeds Task 6) — not a placeholder; Task 6 is explicitly gated on it. The two "verify on shopify.dev" notes (refresh mechanics §10.1, brand/policy field shape §10.2) are spec-mandated verifications with a concrete fallback each (the #439-accepted deferral pattern), not vague steps.

**Type consistency:** `listActive`/`MerchantSummary` (Tasks 1,5); `StoreProfilePort`/`StoreProfileRecord` (Tasks 2,3,4,9); `getFreshAdminToken`/`exchange` (Task 6); `CATALOG_UNIFIED` flag (Tasks 7,8,9) — names consistent across tasks.
