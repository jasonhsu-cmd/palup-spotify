# Durable Catalog Sync (public-app scale) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give PalUp one durable, per-tenant, local source of truth for each merchant's product catalog, backfilled from Shopify via Bulk Operations, kept fresh by webhook deltas through a rate-limited client, and served to the assistant from PalUp's own Postgres so the shopper hot path never calls Shopify.

**Architecture:** Three planes separated by credential and hot/cold path — **Serving** (local Postgres, no Shopify credential), **Delta** (declarative webhooks → existing queue → extended reconcile), **Sync** (per-shop offline Admin token → Bulk Operations backfill + periodic reconcile). A new `catalog_product` table is the render/serving source of truth; pgvector stays the retrieval index and `product_facts` stays the money-fact fast path.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node + Fastify (widget-backend), Postgres via the package `Sql` abstraction (pglite in tests, node-postgres in prod), pgvector, `@palup/platform-ports` ports + adapters, vitest.

**Spec:** `docs/superpowers/specs/2026-08-23-durable-catalog-sync-design.md`
**Governing ADR:** `docs/adr/0022-per-shop-admin-token-for-catalog-sync.md` (Accepted; its **Security-review conditions** F1–F9 + audit are acceptance criteria threaded through the tasks below).

## Global Constraints

*Every task's requirements implicitly include this section. Values are copied verbatim from the spec/ADR/CLAUDE.md.*

- **Tenant isolation:** `tenant_id text NOT NULL` is the first PRIMARY KEY column; every method calls a `requireTenant(tenantId)` guard that throws on blank; every SQL statement binds `tenant_id=$1`. (Mirrors `postgres-product-facts-store.ts:5-10`.)
- **Portability (ADR-0001):** no Shopify SDK; all Shopify access goes through the new `shopify-client.ts` adapter or existing adapters. Store columns are platform-neutral.
- **Durability invariant (spec §3):** the serving hot path (`grounding.getContext`) calls **no** Shopify surface and holds **no** Shopify credential. A failed sync/refresh never falls back to a hot-path live fetch.
- **Least privilege (F3):** production requests only `read_products`, `read_inventory`. Write scopes (`write_customers`/`write_orders`) are **staging-dev-app-only** and must be hard-excluded from the production default and `shopify.app.toml`.
- **Admin-token custody (F2):** via a `CryptoPort`-backed store using a **distinct key scope** (`"admin-cred"`) and record key (`"admin_offline"`) from the storefront delegate token; **never** the read-only `SecretsPort`; never in code/prompts/logs. Production requires a KMS-backed `CryptoPort` adapter.
- **Two-step revoke (F1):** `app/uninstalled` (unsigned `X-Shopify-Shop-Domain` header) triggers **only reversible** actions (halt + tombstone). Irreversible Admin-token hard-delete + catalog hard-retire run **only** on `shop/redact` (HMAC-covered `shop_domain`).
- **SSRF/egress (F4):** the Admin client host-allowlists the Admin GraphQL endpoint with the existing `SHOP_HOST` regex (`/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i`, `shopify-grounding.ts:204`); the Bulk result-URL download is https-+host-allowlisted and **carries no Admin token**; egress logs never include the token.
- **Kill switch (F5, NN#4):** a sync-plane kill scope exists — `agent:catalog-sync` (agentType const `CATALOG_SYNC_AGENT_TYPE = "catalog-sync"`). Background jobs re-check `matchedKill(store, { tenantId, agentType: CATALOG_SYNC_AGENT_TYPE })` **between steps** and abort promptly; no job continues on a cached token after delete.
- **Refresh (F6):** persist non-secret `expiresAt`; refresh is single-flight per tenant and audited (`action: "admin_token.refresh"`); never a silent in-place update.
- **Confused-deputy (F7):** token exchange validates the session token's shop binding and that the returned token binds to the same shop; the client secret is read via `SecretsPort`, never logged.
- **Data minimization (F8):** persist the `availableForSale` **boolean**, not raw `inventoryQty`; filter `draft`/`archived` products at ingest unless a serving consumer needs them.
- **Audit completeness (NN#5):** mint / refresh / revoke / backfill (incl. the >50k truncation log) / delta all write to the audit log; no silent path.
- **Content hash:** reuse `contentHash(text)` (sha256 over `productEmbedText`, `catalog-index.ts:331-333`) as the delta short-circuit key, mirrored into `catalog_product.content_hash`.
- **Test commands:** `pnpm test` (root vitest, `PGVECTOR_TESTCONTAINER=off`) for the full run; `pnpm vitest run <path>` to scope. **Never set `GOOGLE_CLOUD_PROJECT`** (routes tests to real Vertex — memory `merge-gate-mock-path`). Full gate before merge: `merge-gate.sh` (typecheck, unit, eval, 4× e2e, pgvector testcontainer).
- **Enablement:** staging default-on once a tenant is backfilled; production is a separate human §5 promotion (separate DB + key material, F9). No production enable in this plan.

---

## File Structure

**Net-new files:**
- `packages/platform-ports/src/catalog-product-port.ts` — `CatalogProductPort` interface, `CatalogProductRecord` type, `requireCatalogTenant`, `createInMemoryCatalogProductStore` (contract oracle).
- `packages/platform-ports/contract/catalog-product-port.contract.ts` — shared behavior contract (`runCatalogProductPortContract`).
- `packages/state-postgres/src/postgres-catalog-product-store.ts` — `PostgresCatalogProductStore implements CatalogProductPort` (owns the `catalog_product` table).
- `packages/state-postgres/src/admin-token-store.ts` — `createAdminTokenStore` (CryptoPort-backed, distinct scope/record-key, `expiresAt`, refresh).
- `packages/widget-backend/src/shopify-client.ts` — rate-limited, SSRF-guarded Admin GraphQL + Bulk-Operations client.
- `packages/widget-backend/src/jobs/catalog-backfill.ts` — Bulk-Operations backfill driver.
- `packages/widget-backend/src/jobs/catalog-sync-scheduler.ts` — fleet backfill scheduler + sync-plane kill re-checks.
- `packages/widget-backend/src/local-catalog-grounding.ts` — `GroundingPort` served from local stores.

**Modified files:**
- `packages/state-postgres/src/index.ts` — barrel exports for the two new stores.
- `packages/widget-backend/src/jobs/catalog-index.ts` — thread `catalogProduct?` into `CatalogIndexDeps`; write it at the four extend-lines.
- `packages/widget-backend/src/routes/shopify-install.ts` — capture `grant.accessToken`, custody it (F7 validation).
- `packages/widget-backend/src/routes/shopify-webhooks.ts` — Admin-token teardown split across `app/uninstalled` (halt) / `shop/redact` (delete).
- `packages/widget-backend/src/model.ts` + `server.ts` — construct the new stores; swap grounding to local behind a flag; wire deps; `migrate()`.
- `packages/widget-backend/test/order-attribution-scope-pinning.test.ts` — harden write-scope exclusion (F3).
- `shopify.app.toml` — restore declarative `[[webhooks.subscriptions]]` for catalog + compliance topics.

---

## Task 1: `CatalogProductPort` + in-memory reference + contract

**Files:**
- Create: `packages/platform-ports/src/catalog-product-port.ts`
- Create: `packages/platform-ports/contract/catalog-product-port.contract.ts`
- Modify: `packages/platform-ports/src/index.ts` (add exports)
- Test: `packages/platform-ports/test/catalog-product-port.test.ts`

**Interfaces:**
- Produces: `CatalogProductRecord`, `CatalogProductVariant`, `CatalogProductPort`, `requireCatalogTenant(tenantId): string`, `createInMemoryCatalogProductStore(): CatalogProductPort`, `runCatalogProductPortContract(makeStore)`.

Type shape (mirrors `ProductFact`/`ProductFactsPort`, `product-facts-port.ts:19-52`; **no raw `inventoryQty`** per F8):

```ts
export interface CatalogProductVariant {
  variantId: string;
  title?: string;
  sku?: string;
  price?: string;            // display string, never numeric (mirrors ProductFact.price)
  currency?: string;
  availableForSale?: boolean; // boolean only (F8) — no raw stock count
  imageUrl?: string;
  options?: Record<string, string>;
}
export interface CatalogProductRecord {
  productId: string;         // Shopify product GID
  handle: string;
  title: string;
  descriptionHtml?: string;
  descriptionText?: string;
  productType?: string;
  vendor?: string;
  tags?: string[];
  status: "active" | "archived" | "draft";
  options?: { name: string; values: string[] }[];
  variants: CatalogProductVariant[];
  featuredImageUrl?: string;
  imageUrls?: string[];
  onlineStoreUrl?: string;
  contentHash: string;
  syncedAt: string;          // ISO-8601 UTC
  deletedAt?: string;        // ISO tombstone; unset = live
}
export interface CatalogProductPort {
  getMany(tenantId: string, productIds: string[]): Promise<CatalogProductRecord[]>; // excludes tombstoned
  listByTenant(tenantId: string, opts?: { limit?: number; includeDeleted?: boolean }): Promise<CatalogProductRecord[]>;
  upsertMany(tenantId: string, records: CatalogProductRecord[]): Promise<void>;
  softDeleteMany(tenantId: string, productIds: string[], opts: { at: string }): Promise<void>;
  pruneTombstoned(tenantId: string, opts: { olderThan: string }): Promise<number>;  // hard-delete, returns count
  deleteTenant(tenantId: string): Promise<void>;
}
```

- [ ] **Step 1: Write the failing test**

```ts
// packages/platform-ports/test/catalog-product-port.test.ts
import { describe } from "vitest";
import { createInMemoryCatalogProductStore } from "../src/catalog-product-port.js";
import { runCatalogProductPortContract } from "../contract/catalog-product-port.contract.js";

describe("in-memory CatalogProductPort", () => {
  runCatalogProductPortContract(async () => createInMemoryCatalogProductStore());
});
```

And the contract (real behavior — copy the shape of `createInMemoryProductFactsStore`'s contract):

```ts
// packages/platform-ports/contract/catalog-product-port.contract.ts
import { it, expect } from "vitest";
import type { CatalogProductPort, CatalogProductRecord } from "../src/catalog-product-port.js";

const rec = (id: string, over: Partial<CatalogProductRecord> = {}): CatalogProductRecord => ({
  productId: id, handle: id, title: id, status: "active", variants: [],
  contentHash: "h", syncedAt: "2026-08-23T00:00:00.000Z", ...over,
});

export function runCatalogProductPortContract(make: () => Promise<CatalogProductPort>) {
  it("upsert then getMany returns the row", async () => {
    const s = await make();
    await s.upsertMany("t1", [rec("gid://shopify/Product/1", { title: "Serum" })]);
    const got = await s.getMany("t1", ["gid://shopify/Product/1"]);
    expect(got).toHaveLength(1);
    expect(got[0].title).toBe("Serum");
  });
  it("tenant isolation: t2 cannot read t1's rows", async () => {
    const s = await make();
    await s.upsertMany("t1", [rec("gid://shopify/Product/1")]);
    expect(await s.getMany("t2", ["gid://shopify/Product/1"])).toEqual([]);
  });
  it("blank tenant throws (fail closed)", async () => {
    const s = await make();
    await expect(s.getMany("", ["x"])).rejects.toThrow();
  });
  it("softDelete tombstones: getMany excludes it, includeDeleted lists it", async () => {
    const s = await make();
    await s.upsertMany("t1", [rec("gid://shopify/Product/1")]);
    await s.softDeleteMany("t1", ["gid://shopify/Product/1"], { at: "2026-08-24T00:00:00.000Z" });
    expect(await s.getMany("t1", ["gid://shopify/Product/1"])).toEqual([]);
    const all = await s.listByTenant("t1", { includeDeleted: true });
    expect(all[0].deletedAt).toBe("2026-08-24T00:00:00.000Z");
  });
  it("pruneTombstoned hard-deletes rows tombstoned before the cutoff", async () => {
    const s = await make();
    await s.upsertMany("t1", [rec("gid://shopify/Product/1")]);
    await s.softDeleteMany("t1", ["gid://shopify/Product/1"], { at: "2026-08-24T00:00:00.000Z" });
    const n = await s.pruneTombstoned("t1", { olderThan: "2026-08-25T00:00:00.000Z" });
    expect(n).toBe(1);
    expect(await s.listByTenant("t1", { includeDeleted: true })).toEqual([]);
  });
}
```

- [ ] **Step 2: Run test to verify it fails** — `pnpm vitest run packages/platform-ports/test/catalog-product-port.test.ts` → FAIL (module not found).
- [ ] **Step 3: Implement `catalog-product-port.ts`** — the interface above, `requireCatalogTenant` (throw on blank, mirror `requireProductFactsTenant` at `product-facts-port.ts:56-60`), and `createInMemoryCatalogProductStore` backed by a `Map<string, Map<string, CatalogProductRecord>>` keyed by tenant→productId; `getMany` filters `deletedAt == null`; `pruneTombstoned` deletes where `deletedAt && deletedAt < olderThan`.
- [ ] **Step 4: Add exports** to `packages/platform-ports/src/index.ts` (mirror the product-facts export block ~line 104).
- [ ] **Step 5: Run test to verify it passes** — same command → PASS.
- [ ] **Step 6: Commit**

```bash
git add packages/platform-ports/src/catalog-product-port.ts packages/platform-ports/contract/catalog-product-port.contract.ts packages/platform-ports/src/index.ts packages/platform-ports/test/catalog-product-port.test.ts
git commit -m "feat(ports): CatalogProductPort + in-memory reference + contract"
```

---

## Task 2: `PostgresCatalogProductStore` (owns the `catalog_product` table)

**Files:**
- Create: `packages/state-postgres/src/postgres-catalog-product-store.ts`
- Modify: `packages/state-postgres/src/index.ts`
- Test: `packages/state-postgres/test/postgres-catalog-product-store.test.ts`

**Interfaces:**
- Consumes: `CatalogProductPort`, `CatalogProductRecord` (Task 1); `Sql` (`state-postgres/src/sql.js`).
- Produces: `class PostgresCatalogProductStore implements CatalogProductPort` with `constructor(private readonly sql: Sql)` and `async migrate(): Promise<void>`.

Follow **Shape A** (`postgres-product-facts-store.ts`): one statement per `sql.query()`; `jsonb` columns for `options`/`variants`/`image_urls`; multi-row writes wrapped in `this.sql.tx(...)`.

- [ ] **Step 1: Write the failing test** (pglite in-process, the default harness — copy `postgres-product-facts-store.test.ts:10-24`):

```ts
// packages/state-postgres/test/postgres-catalog-product-store.test.ts
import { describe } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { PostgresCatalogProductStore } from "../src/postgres-catalog-product-store.js";
import { runCatalogProductPortContract } from "@palup/platform-ports/contract/catalog-product-port.contract.js";
import type { Sql } from "../src/sql.js";

function pgliteSql(db: PGlite): Sql {
  const wrap = (r: any) => ({
    query: async (text: string, params: unknown[] = []) => ({ rows: (await r.query(text, params)).rows }),
    tx: () => { throw new Error("nested tx unsupported"); },
  });
  return { query: (t, p) => wrap(db).query(t, p), tx: (fn: any) => db.transaction((c: any) => fn(wrap(c))) } as Sql;
}

describe("PostgresCatalogProductStore (pglite)", () => {
  runCatalogProductPortContract(async () => {
    const s = new PostgresCatalogProductStore(pgliteSql(new PGlite()));
    await s.migrate();
    return s;
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `pnpm vitest run packages/state-postgres/test/postgres-catalog-product-store.test.ts` → FAIL.
- [ ] **Step 3: Implement the store.** `migrate()` (one statement per call):

```ts
async migrate(): Promise<void> {
  await this.sql.query(
    `CREATE TABLE IF NOT EXISTS catalog_product (
       tenant_id text NOT NULL,
       product_id text NOT NULL,
       handle text NOT NULL,
       title text NOT NULL,
       description_html text,
       description_text text,
       product_type text,
       vendor text,
       tags text[],
       status text NOT NULL,
       options jsonb,
       variants jsonb NOT NULL DEFAULT '[]'::jsonb,
       featured_image_url text,
       image_urls text[],
       online_store_url text,
       content_hash text NOT NULL,
       synced_at timestamptz NOT NULL,
       deleted_at timestamptz,
       PRIMARY KEY (tenant_id, product_id))`,
  );
  await this.sql.query(
    `CREATE INDEX IF NOT EXISTS catalog_product_live_idx ON catalog_product (tenant_id) WHERE deleted_at IS NULL`,
  );
}
```

`getMany`: `SELECT ... WHERE tenant_id=$1 AND product_id = ANY($2::text[]) AND deleted_at IS NULL`. `listByTenant`: `WHERE tenant_id=$1` (+ `AND deleted_at IS NULL` unless `includeDeleted`), `LIMIT` when given. `upsertMany`: `this.sql.tx` + per-row `INSERT ... ON CONFLICT (tenant_id, product_id) DO UPDATE SET ...` (clears `deleted_at` on re-upsert). `softDeleteMany`: `UPDATE catalog_product SET deleted_at=$3 WHERE tenant_id=$1 AND product_id=ANY($2::text[])`. `pruneTombstoned`: `DELETE ... WHERE tenant_id=$1 AND deleted_at IS NOT NULL AND deleted_at < $2` returning `rowCount`. `deleteTenant`: `DELETE ... WHERE tenant_id=$1`. Every method starts with `requireCatalogTenant(tenantId)`. Map `jsonb`/`text[]` columns to/from the record shape (mirror `PfRow` at `postgres-product-facts-store.ts:12-19`).
- [ ] **Step 4: Add barrel export** to `packages/state-postgres/src/index.ts`: `export { PostgresCatalogProductStore } from "./postgres-catalog-product-store.js";`
- [ ] **Step 5: Run to verify it passes** — same command → PASS.
- [ ] **Step 6: Commit** — `feat(state-postgres): catalog_product table + PostgresCatalogProductStore`.

---

## Task 3: Rate-limited, SSRF-guarded `shopify-client.ts`

**Files:**
- Create: `packages/widget-backend/src/shopify-client.ts`
- Test: `packages/widget-backend/test/shopify-client.test.ts`

**Interfaces:**
- Produces: `createShopifyAdminClient(opts)` returning `{ graphql(query, variables?): Promise<AdminResponse>, runBulkQuery(query): Promise<{ id: string }>, pollBulk(id): Promise<BulkStatus>, downloadJsonl(url): Promise<string> }`. Injectable `fetchFn: typeof globalThis.fetch = globalThis.fetch` (first positional, mirrors `storefrontFetch` at `shopify-grounding.ts:356`).
- Consumes: `SHOP_HOST` regex (re-declare the same literal — do not import a private).

Constants (verified 2026-08-23, spec Appendix A): throttle info at `extensions.cost.throttleStatus = { maximumAvailable, currentlyAvailable, restoreRate }`. Bulk result served from a Shopify/GCS CDN host — allowlist `SHOPIFY_BULK_RESULT_HOST = /(^|\.)shopifycloud\.com$|(^|\.)storage\.googleapis\.com$/i` (confirm exact host at implementation via a live bulk run; pin conservatively and log any rejected host).

- [ ] **Step 1: Write failing tests** (fake `fetchFn`):

```ts
// packages/widget-backend/test/shopify-client.test.ts
import { describe, it, expect, vi } from "vitest";
import { createShopifyAdminClient } from "../src/shopify-client.js";

const creds = { shopDomain: "demo.myshopify.com", accessToken: "admintok" };

it("rejects a non-*.myshopify.com admin host (SSRF, F4)", async () => {
  const c = createShopifyAdminClient({ fetchFn: vi.fn(), creds: { ...creds, shopDomain: "evil.example.com" } });
  await expect(c.graphql("{ shop { name } }")).rejects.toThrow(/myshopify\.com/);
});

it("backs off then retries on THROTTLED (rate limit)", async () => {
  const fetchFn = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ errors: [{ extensions: { code: "THROTTLED" } }],
      extensions: { cost: { throttleStatus: { maximumAvailable: 1000, currentlyAvailable: 0, restoreRate: 100 } } } }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ data: { shop: { name: "Demo" } } }), { status: 200 }));
  const c = createShopifyAdminClient({ fetchFn, creds, sleep: async () => {} });
  const r = await c.graphql("{ shop { name } }");
  expect(fetchFn).toHaveBeenCalledTimes(2);
  expect(r.data.shop.name).toBe("Demo");
});

it("gives up with a typed error after the attempt cap (no infinite loop)", async () => {
  const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({ errors: [{ extensions: { code: "THROTTLED" } }] }), { status: 200 }));
  const c = createShopifyAdminClient({ fetchFn, creds, sleep: async () => {}, maxAttempts: 3 });
  await expect(c.graphql("{ shop { name } }")).rejects.toThrow(/throttl/i);
  expect(fetchFn).toHaveBeenCalledTimes(3);
});

it("downloadJsonl rejects a non-allowlisted result host and never sends the admin token", async () => {
  const fetchFn = vi.fn();
  const c = createShopifyAdminClient({ fetchFn, creds });
  await expect(c.downloadJsonl("https://evil.example.com/x.jsonl")).rejects.toThrow(/host/i);
  const okFetch = vi.fn().mockResolvedValue(new Response("{}\n", { status: 200 }));
  const c2 = createShopifyAdminClient({ fetchFn: okFetch, creds });
  await c2.downloadJsonl("https://storage.googleapis.com/bucket/x.jsonl");
  const headers = (okFetch.mock.calls[0][1]?.headers ?? {}) as Record<string, string>;
  expect(JSON.stringify(headers)).not.toContain("admintok"); // F4: no token on pre-signed download
});
```

- [ ] **Step 2: Run to verify they fail** — `pnpm vitest run packages/widget-backend/test/shopify-client.test.ts` → FAIL.
- [ ] **Step 3: Implement `shopify-client.ts`.** `graphql()`: guard `SHOP_HOST.test(creds.shopDomain)` before any fetch (throw the myshopify.com message, mirroring `shopify-grounding.ts:377`); POST to `https://${shopDomain}/admin/api/${version}/graphql.json` with header `X-Shopify-Access-Token: creds.accessToken`; on a `THROTTLED` error code (or HTTP 429/5xx) sleep (from `throttleStatus.restoreRate` when present, else exponential backoff) and retry up to `maxAttempts` (default 5); throw a typed `ShopifyThrottleError`/`ShopifyClientError` when exhausted. `runBulkQuery(query)`: wrap in the `bulkOperationRunQuery` mutation, return `{ id }`. `pollBulk(id)`: query `currentBulkOperation`/node, return `{ status, url?, objectCount? }`. `downloadJsonl(url)`: validate `new URL(url).protocol === "https:"` and host matches `SHOPIFY_BULK_RESULT_HOST`, fetch **without** the `X-Shopify-Access-Token` header (pre-signed URL), return text. Egress log helper never includes the token (mirror `shopify-grounding.ts:282-298`). Accept `sleep` + `maxAttempts` as injectable opts for tests.
- [ ] **Step 4: Run to verify they pass** — same command → PASS.
- [ ] **Step 5: Commit** — `feat(widget-backend): rate-limited SSRF-guarded Shopify Admin/Bulk client`.

> **Implementation note (spec §13.3):** confirm the exact `currentBulkOperation` poll fields, `url` expiry, and the real result host on shopify.dev / a live bulk run before finalizing the poll + host allowlist. Log (don't silently drop) any result host that fails the allowlist.

---

## Task 4: Admin-token custody store (`admin-token-store.ts`)

**Files:**
- Create: `packages/state-postgres/src/admin-token-store.ts`
- Modify: `packages/state-postgres/src/index.ts`
- Test: `packages/state-postgres/test/admin-token-store.test.ts`

**Interfaces:**
- Consumes: `RuntimeStatePort`, `CryptoPort` (constructor args, mirror `createMerchantCredentialStore` at `merchant-credential-store.ts:199-203`).
- Produces:
```ts
export const ADMIN_CRED_KEY_SCOPE = "admin-cred";
export const ADMIN_CRED_COLLECTION = "admin_cred";
export const ADMIN_CRED_RECORD_KEY = "admin_offline";
export type AdminTokenRead =
  | { status: "found"; token: string; expiresAt?: string }
  | { status: "missing" }
  | { status: "unreadable"; reason: "undecryptable" | "malformed-record" };
export interface AdminTokenStore {
  put(tenantId: string, token: string, opts: { actor: string; expiresAt?: string }): Promise<void>;
  read(tenantId: string): Promise<AdminTokenRead>;
  refresh(tenantId: string, token: string, opts: { actor: string; expiresAt?: string }): Promise<void>; // audited as admin_token.refresh
  delete(tenantId: string, opts: { actor: string }): Promise<void>;
}
export function createAdminTokenStore(state: RuntimeStatePort, crypto: CryptoPort, opts?: { now?: () => string }): AdminTokenStore;
```

This is a parallel of `merchant-credential-store.ts` with three deltas the research flagged (`merchant-credential-store.ts:79-85` says a second credential kind is "a second key here"): (1) distinct `ADMIN_CRED_*` constants + `adminCredentialAad(tenantId) = \`${ADMIN_CRED_COLLECTION}|${tenantId}|${ADMIN_CRED_RECORD_KEY}\``; (2) stored shape `{ c, expiresAt?, updatedAt }`; (3) a `refresh` op audited as `action: "admin_token.refresh"` (put audits `admin_token.store`, delete audits `admin_token.delete`). Encrypt **before** opening the tx; write + audit in one `state.tx({ tenantId }, ...)`; `read` returns `missing`/`unreadable`/`found` exactly like the merchant store (`:246-258`).

- [ ] **Step 1: Write failing test** (use the in-memory `RuntimeStatePort` + a fake `CryptoPort` — reuse whatever `merchant-credential-store.test.ts` uses for these):

```ts
// packages/state-postgres/test/admin-token-store.test.ts
import { describe, it, expect } from "vitest";
import { createAdminTokenStore, ADMIN_CRED_KEY_SCOPE } from "../src/admin-token-store.js";
// import { makeInMemoryRuntimeStore, fakeCrypto } from "./helpers/..." — reuse the merchant-cred test helpers

it("put then read returns the token + expiresAt", async () => {
  const { store, crypto } = harness();
  const s = createAdminTokenStore(store, crypto);
  await s.put("t1", "atk", { actor: "system:test", expiresAt: "2026-09-01T00:00:00.000Z" });
  expect(await s.read("t1")).toEqual({ status: "found", token: "atk", expiresAt: "2026-09-01T00:00:00.000Z" });
});
it("uses a DISTINCT key scope from merchant-cred (F2)", () => {
  expect(ADMIN_CRED_KEY_SCOPE).toBe("admin-cred");
});
it("tenant isolation: t2 cannot read t1's token", async () => {
  const { store, crypto } = harness();
  const s = createAdminTokenStore(store, crypto);
  await s.put("t1", "atk", { actor: "system:test" });
  expect(await s.read("t2")).toEqual({ status: "missing" });
});
it("delete removes it; read is then missing (not unreadable)", async () => {
  const { store, crypto } = harness();
  const s = createAdminTokenStore(store, crypto);
  await s.put("t1", "atk", { actor: "system:test" });
  await s.delete("t1", { actor: "system:test" });
  expect(await s.read("t1")).toEqual({ status: "missing" });
});
it("refresh replaces the token and writes an admin_token.refresh audit", async () => {
  const { store, crypto, audits } = harness();
  const s = createAdminTokenStore(store, crypto);
  await s.put("t1", "atk", { actor: "system:test" });
  await s.refresh("t1", "atk2", { actor: "system:refresh", expiresAt: "2026-10-01T00:00:00.000Z" });
  expect((await s.read("t1"))).toMatchObject({ token: "atk2" });
  expect(audits().some(a => a.action === "admin_token.refresh")).toBe(true);
});
```

- [ ] **Step 2: Run to verify it fails** → FAIL.
- [ ] **Step 3: Implement** by copying `merchant-credential-store.ts` and applying the three deltas above. Single-flight refresh is enforced by the **caller** (Task 5), not the store; the store just performs an audited replace.
- [ ] **Step 4: Add barrel exports** to `state-postgres/src/index.ts` (`createAdminTokenStore`, `ADMIN_CRED_KEY_SCOPE`, `ADMIN_CRED_RECORD_KEY`, `type AdminTokenStore`, `type AdminTokenRead`).
- [ ] **Step 5: Run to verify it passes** → PASS.
- [ ] **Step 6: Commit** — `feat(state-postgres): CryptoPort-backed admin-token custody (distinct scope, expiresAt, audited refresh)`.

---

## Task 5: Capture + custody the Admin token at install (+ single-flight refresh helper)

**Files:**
- Modify: `packages/widget-backend/src/routes/shopify-install.ts` (~:395-434)
- Create: `packages/widget-backend/src/admin-token-refresh.ts` (single-flight refresh helper)
- Test: `packages/widget-backend/test/shopify-install-admin-token.test.ts`, `packages/widget-backend/test/admin-token-refresh.test.ts`

**Interfaces:**
- Consumes: `AdminTokenStore` (Task 4); the install grant (`grant.accessToken`, `grant.grantedScopes` at `shopify-install.ts:399-403`).
- Produces: `ShopifyInstallDeps.adminTokens?: Pick<AdminTokenStore, "put">` (put-only sink, mirroring the delegate `MerchantCredentialSink` at `:109-111`); `getFreshAdminToken(deps, tenantId): Promise<string>` (single-flight, F6).

The research confirmed the gap: `shopify-install.ts:406-434` creates the delegate token and **discards** `grant.accessToken` after transient webhook registration. This task captures it.

- [ ] **Step 1: Write failing install test** — after a successful install, `deps.adminTokens.put` is called once with the parent `grant.accessToken`, actor `system:shopify-install`, and (F7) only when the returned grant's shop matches the OAuth `state` shop:

```ts
it("custodies grant.accessToken under the admin-token sink on install (F7 shop-binding checked)", async () => {
  const put = vi.fn();
  // ...drive registerShopifyInstallRoutes with adminTokens: { put }, a stub exchange returning
  // grant.accessToken="ADMIN", shop matching state...
  // assert:
  expect(put).toHaveBeenCalledWith(expect.any(String), "ADMIN", expect.objectContaining({ actor: "system:shopify-install" }));
});
it("does NOT custody when the grant's shop != the state shop (confused-deputy, F7)", async () => { /* put not called; install refused */ });
```

- [ ] **Step 2: Run to verify it fails** → FAIL.
- [ ] **Step 3: Implement in `shopify-install.ts`.** After the shop-binding validation (compare grant/callback shop to the signed `state` shop) and after the existing delegate `put` (`:414`), add: `if (deps.adminTokens) await deps.adminTokens.put(tenantId, grant.accessToken, { actor: "system:shopify-install", expiresAt: grant.expiresAt });` Add `adminTokens?` to `ShopifyInstallDeps`. Do **not** log `grant.accessToken`.
- [ ] **Step 4: Write + implement the refresh helper** `admin-token-refresh.ts`:

```ts
// getFreshAdminToken: read token; if expiresAt within a skew window, refresh via token exchange
// through a per-tenant single-flight map so concurrent callers await one refresh (F6).
const inflight = new Map<string, Promise<string>>();
export function makeAdminTokenRefresher(deps: {
  tokens: AdminTokenStore;
  exchange: (tenantId: string, shopDomain: string) => Promise<{ accessToken: string; expiresAt?: string }>;
  shopDomainOf: (tenantId: string) => Promise<string>;
  now?: () => number;
  skewMs?: number;
}) {
  return async function getFreshAdminToken(tenantId: string): Promise<string> {
    const cur = await deps.tokens.read(tenantId);
    if (cur.status === "found" && !expiringSoon(cur.expiresAt, deps.now, deps.skewMs)) return cur.token;
    if (cur.status === "unreadable") throw new Error("admin token unreadable — reinstall required");
    let p = inflight.get(tenantId);
    if (!p) {
      p = (async () => {
        const shop = await deps.shopDomainOf(tenantId);
        const next = await deps.exchange(tenantId, shop);
        await deps.tokens.refresh(tenantId, next.accessToken, { actor: "system:admin-token-refresh", expiresAt: next.expiresAt });
        return next.accessToken;
      })().finally(() => inflight.delete(tenantId));
      inflight.set(tenantId, p);
    }
    return p;
  };
}
```

Test: two concurrent `getFreshAdminToken` calls trigger exactly one `exchange` (single-flight); an unreadable token throws (never a hot-path fallback).
- [ ] **Step 5: Run both tests → PASS.**
- [ ] **Step 6: Commit** — `feat(widget-backend): custody admin token at install + single-flight audited refresh (F6,F7)`.

> **Implementation note (spec §13.2):** confirm token-exchange refresh mechanics + `grant.expiresAt` presence on shopify.dev before finalizing `exchange`.

---

## Task 6: Persist full fields into `catalog_product` from index + reconcile

**Files:**
- Modify: `packages/widget-backend/src/jobs/catalog-index.ts` (`CatalogIndexDeps` :260-283; full-path writes :522/:737/:745/:755; reconcile writes :1050/:1051/:1061/:1073)
- Test: `packages/widget-backend/test/catalog-index-catalog-product.test.ts`

**Interfaces:**
- Consumes: `CatalogProductPort` (Task 1). Add `catalogProduct?: CatalogProductPort` to `CatalogIndexDeps` (mirror the optional `productFacts?` dependency).
- Produces: `catalog_product` rows written on every successful fetch (like `product_facts`, **not** gated by the embed short-circuit — price/variant/image changes must persist even when embed text is unchanged).

- [ ] **Step 1: Write failing test** — drive `reconcileProducts` with an in-memory `CatalogProductPort` + a fake `catalogById` returning one product; assert the full record (title, handle, variants, `availableForSale` boolean, `contentHash`) lands in the store, and a delisted id is soft-deleted:

```ts
it("reconcileProducts upserts full fields to catalog_product and tombstones delisted", async () => {
  const catalogProduct = createInMemoryCatalogProductStore();
  // deps with catalogById returning gid .../1 (fresh) and NOT returning previously-known .../2
  await reconcileProducts({ ...deps, catalogProduct }, "t1", ["gid://shopify/Product/1", "gid://shopify/Product/2"], { reason: "product" });
  expect((await catalogProduct.getMany("t1", ["gid://shopify/Product/1"]))[0].title).toBeDefined();
  expect(await catalogProduct.getMany("t1", ["gid://shopify/Product/2"])).toEqual([]); // tombstoned
});
```

- [ ] **Step 2: Run to verify it fails** → FAIL.
- [ ] **Step 3: Implement.** Add `catalogProduct?` to `CatalogIndexDeps`. Build a `CatalogProductRecord[]` from the fetched products (map to the boolean `availableForSale`, drop raw stock — F8; set `status`, filter `draft`/`archived` unless configured — F8; compute `contentHash` via the existing `contentHash(productEmbedText(p))`). In `reconcileProducts`, after the fetch/plan (near `:1050`), call `await deps.catalogProduct?.upsertMany(tenantId, records)` on every successful fetch, and `await deps.catalogProduct?.softDeleteMany(tenantId, stale, { at: now.toISOString() })` alongside the existing `productFacts.deleteMany` (`:1061`). Mirror the same two calls in the full-path `indexOneTenant` near `:522`/`:755`. Guard each with the same fail-safe try/catch pattern the `productFacts` writes use (`:518-559`). Audit a `catalog_product.write` entry (NN#5) alongside the existing product_facts audit.
- [ ] **Step 4: Run to verify it passes** → PASS.
- [ ] **Step 5: Commit** — `feat(widget-backend): persist full catalog_product fields from index + reconcile (F8 boolean-only)`.

---

## Task 7: Bulk-Operations backfill driver

**Files:**
- Create: `packages/widget-backend/src/jobs/catalog-backfill.ts`
- Test: `packages/widget-backend/test/catalog-backfill.test.ts`

**Interfaces:**
- Consumes: the Task 3 client (`runBulkQuery`/`pollBulk`/`downloadJsonl`), the Task 5 `getFreshAdminToken`, `CatalogProductPort`, `ProductFactsPort`, and the embed enqueue path (reuse `reconcileProducts`/vector upsert).
- Produces: `runCatalogBackfill(deps, tenantId, opts?): Promise<BackfillReport>` — `{ tenantId, productCount, truncated: boolean, outcome }`.

- [ ] **Step 1: Write failing test** — a fake client whose `downloadJsonl` returns 2 product JSONL lines loads 2 rows into `catalog_product` + `product_facts`; a re-run with unchanged `contentHash` performs **zero** rewrites; exceeding `MAX_INDEXED_PRODUCTS` sets `truncated: true` and logs it:

```ts
it("loads bulk JSONL into catalog_product + product_facts; re-run with same hashes is a no-op", async () => { /* ... */ });
it("sets truncated + logs when the catalog exceeds MAX_INDEXED_PRODUCTS (no silent cap)", async () => { /* ... */ });
```

- [ ] **Step 2: Run to verify it fails** → FAIL.
- [ ] **Step 3: Implement.** `runCatalogBackfill`: `token = await getFreshAdminToken(tenantId)`; construct the client with `{ creds: { shopDomain, accessToken: token } }`; `runBulkQuery(PRODUCTS_QUERY)`; poll to completion; `downloadJsonl(url)`; parse JSONL (products + nested variants — Bulk flattens connections into separate lines joined by `__parentId`); map to `CatalogProductRecord[]` + `ProductFact[]`; `upsertMany` both (content-hash skip on re-run); enqueue embeddings via the existing reconcile/vector path; cap at `MAX_INDEXED_PRODUCTS` (50000) and on overflow set `truncated` + `log`/audit the drop (NN#5). Idempotent + resumable (record progress in a manifest KV, mirroring `writeManifestAndAudit`).
- [ ] **Step 4: Run to verify it passes** → PASS.
- [ ] **Step 5: Commit** — `feat(widget-backend): Bulk-Operations catalog backfill driver (idempotent, truncation-logged)`.

> **Implementation note:** the JSONL join-by-`__parentId` shape is a Bulk-Operations detail — confirm against a live bulk export (spec §13.3) before finalizing the parser.

---

## Task 8: Serve grounding from the local store (default-on staging)

**Files:**
- Create: `packages/widget-backend/src/local-catalog-grounding.ts`
- Modify: `packages/widget-backend/src/model.ts` (`createGroundingPort` ~:43), `packages/widget-backend/src/server.ts` (~:519 caching wrap)
- Test: `packages/widget-backend/test/local-catalog-grounding.test.ts`

**Interfaces:**
- Consumes: `CatalogProductPort`, `ProductFactsPort`, and a per-tenant profile KV (`brandName` + `policy`) written by backfill (Task 7) — read via `RuntimeStatePort`.
- Produces: `createLocalCatalogGroundingPort(deps): GroundingPort` implementing `getContext`/`getShell`/`getProductsByIds` (`grounding-port.ts:90-107`) **with no Shopify call**.

- [ ] **Step 1: Write the failing durability test (encodes §3, F-invariant):**

```ts
it("serves the full catalog from local stores with the Shopify client stubbed to THROW", async () => {
  const catalogProduct = createInMemoryCatalogProductStore();
  await catalogProduct.upsertMany("t1", [/* two live records */]);
  const productFacts = createInMemoryProductFactsStore();
  await productFacts.upsertMany("t1", [{ productId: "gid://shopify/Product/1", price: "$10" }]);
  const throwingFetch = () => { throw new Error("Shopify is down"); };
  const grounding = createLocalCatalogGroundingPort({ catalogProduct, productFacts, store, /* profile */ });
  const ctx = await grounding.getContext("t1"); // MUST NOT call Shopify
  expect(ctx.products.length).toBe(2);
  expect(ctx.products[0].price).toBe("$10");
  expect(throwingFetch).not.toHaveBeenCalled?.(); // no Shopify dependency injected at all
});
it("maps CatalogProductRecord + ProductFact -> grounding Product (price/availableForSale from facts)", async () => { /* ... */ });
```

- [ ] **Step 2: Run to verify it fails** → FAIL.
- [ ] **Step 3: Implement `createLocalCatalogGroundingPort`.** `getContext(tenantId)`: `listByTenant(tenantId, { limit: MAX_CATALOG_PRODUCTS })`, hydrate price/`availableForSale` from `productFacts.getMany`, map each `CatalogProductRecord`→`Product` (`grounding-port.ts:6-68`), read `brandName`+`policy` from the profile KV; return `{ tenantId, brandName, products, policy }`. `getShell`: brand+policy only. `getProductsByIds`: `catalogProduct.getMany` + facts hydrate.
- [ ] **Step 4: Swap at the composition root behind a flag.** In `model.ts createGroundingPort` (~:43), when `CATALOG_LOCAL_SERVING` is on (default **true** on staging), build `createLocalCatalogGroundingPort(...)` instead of `createShopifyGroundingAdapter(...)`; keep the Shopify adapter for the backfill/delta path only. Preserve the `createCachingGroundingPort` wrap at `server.ts:519` (a local read is cheap, but the cache stays as a thin read cache — spec §13.4 leaves retiring it to a measured follow-up).
- [ ] **Step 5: Run to verify it passes** → PASS. Then `pnpm test` to confirm no regression in existing grounding tests.
- [ ] **Step 6: Commit** — `feat(widget-backend): serve catalog grounding from local store (durability invariant; default-on staging)`.

---

## Task 9: Two-step teardown on uninstall / redact (F1)

**Files:**
- Modify: `packages/widget-backend/src/routes/shopify-webhooks.ts` (`ShopifyWebhookDeps` :189-220; `handleAppUninstalled` :381-425; `handleShopRedact` :686-784)
- Test: `packages/widget-backend/test/shopify-webhooks-admin-token.test.ts`

**Interfaces:**
- Consumes: `AdminTokenStore` (delete) + `CatalogProductPort` (soft-delete / prune). Add `adminTokens?: Pick<AdminTokenStore, "delete">` and `catalogProduct?: CatalogProductPort` to `ShopifyWebhookDeps`.

- [ ] **Step 1: Write failing tests (the F1 security property):**

```ts
it("app/uninstalled (header-sourced) does NOT delete the admin token (reversible only)", async () => {
  // POST app/uninstalled with a valid-HMAC body but spoofable header
  // assert adminTokens.delete NOT called; registry.setStatus(uninstalled) called; catalog_product tombstoned (reversible)
});
it("shop/redact (HMAC-covered shop_domain) DOES delete the admin token + hard-retire the catalog", async () => {
  // assert adminTokens.delete called; catalogProduct.pruneTombstoned / deleteTenant called
});
```

- [ ] **Step 2: Run to verify they fail** → FAIL.
- [ ] **Step 3: Implement.** In `handleAppUninstalled` (after `setStatus(uninstalled)` at `:420`): add `await deps.catalogProduct?.softDeleteMany(...)` **or** leave the existing `eraseCatalogCorpus` for the vector corpus and additionally tombstone `catalog_product` (reversible). Do **not** call `adminTokens.delete` here (F1). In `handleShopRedact` on the applied path (`:758-781`): add `await deps.adminTokens?.delete(tenantId, { actor: "system:shop-redact" })` and `await deps.catalogProduct?.deleteTenant(tenantId)` (irreversible), audited (AUDIT-FIRST per the file header `:106-119`). On the kill-deferred path, follow the existing deferred pattern (audit `shop.redact_deferred`, do not hard-delete).
- [ ] **Step 4: Run to verify they pass** → PASS.
- [ ] **Step 5: Commit** — `feat(widget-backend): two-step admin-token/catalog teardown (reversible on uninstall, irreversible on shop/redact) [F1]`.

---

## Task 10: Restore declarative webhook subscriptions (`shopify.app.toml`)

**Files:**
- Modify: `shopify.app.toml`
- Test: `packages/widget-backend/test/shopify-app-toml-webhooks.test.ts`

- [ ] **Step 1: Write failing test** — read `shopify.app.toml` from repo root and assert it declares `[[webhooks.subscriptions]]` covering every `CATALOG_TOPICS` value + every `COMPLIANCE_TOPICS` value + `app/uninstalled`, at a pinned `api_version`:

```ts
import { CATALOG_TOPICS, COMPLIANCE_TOPICS, UNINSTALL_TOPIC } from "../src/shopify-webhook-identity.js";
it("shopify.app.toml declares catalog + compliance + uninstall webhook subscriptions", () => {
  const toml = readFileSync(join(repoRoot, "shopify.app.toml"), "utf8");
  for (const t of [...CATALOG_TOPICS, ...COMPLIANCE_TOPICS, UNINSTALL_TOPIC]) {
    expect(toml, `missing webhook subscription: ${t}`).toContain(t);
  }
  expect(toml).toMatch(/api_version\s*=/);
});
```

- [ ] **Step 2: Run to verify it fails** → FAIL (declarative webhooks were dropped in the earlier config split).
- [ ] **Step 3: Implement** — add `[[webhooks.subscriptions]]` blocks to `shopify.app.toml` for `products/create|update|delete`, `inventory_levels/update`, the three compliance topics, and `app/uninstalled`, each pointing at the corresponding `WEBHOOK_ROUTES` path (`shopify-webhooks.ts:122-138`), at the pinned `api_version` already in the file.
- [ ] **Step 4: Run to verify it passes** → PASS.
- [ ] **Step 5: Commit** — `feat(shopify): restore declarative catalog/compliance webhook subscriptions in app config`.

---

## Task 11: Fleet backfill scheduler + sync-plane kill scope (F5)

**Files:**
- Create: `packages/widget-backend/src/jobs/catalog-sync-scheduler.ts`
- Modify: `packages/state-postgres/src/runtime-kill-registry.ts` (add `CATALOG_SYNC_AGENT_TYPE`)
- Test: `packages/widget-backend/test/catalog-sync-scheduler.test.ts`

**Interfaces:**
- Consumes: `runCatalogBackfill` (Task 7), `matchedKill` (`runtime-kill-registry.ts:37`), the enablement registry (`catalog-retrieval-enablement.ts`).
- Produces: `CATALOG_SYNC_AGENT_TYPE = "catalog-sync"`; `runCatalogSyncScheduler(deps, opts): Promise<SchedulerReport>` bounding concurrency + re-checking the kill switch between shops.

- [ ] **Step 1: Write failing tests:**

```ts
it("skips a tenant whose sync plane is killed (agent:catalog-sync)", async () => {
  await armKill(store, `agent:${CATALOG_SYNC_AGENT_TYPE}`, "maintenance");
  const report = await runCatalogSyncScheduler({ ...deps }, { tenantIds: ["t1"] });
  expect(report.skipped).toContain("t1");
  expect(deps.backfill).not.toHaveBeenCalled();
});
it("aborts an in-flight backfill promptly when the kill arms between steps", async () => { /* backfill deps re-check matchedKill per step */ });
it("bounds concurrency to the configured max", async () => { /* N tenants, max=2 -> never >2 concurrent */ });
```

- [ ] **Step 2: Run to verify they fail** → FAIL.
- [ ] **Step 3: Implement.** Add `CATALOG_SYNC_AGENT_TYPE` to `runtime-kill-registry.ts`. `runCatalogSyncScheduler`: for each tenant, check `catalogRetrievalEnabledFor` + `matchedKill(store, { tenantId, agentType: CATALOG_SYNC_AGENT_TYPE })` before starting; run backfills through a concurrency-limited pool; thread a `shouldAbort()` closure (re-checks `matchedKill`) into `runCatalogBackfill` so it re-checks between poll/page steps and aborts (F5). Also thread the same `shouldAbort` + a token-presence re-read into the backfill loop so no step runs on a deleted token.
- [ ] **Step 4: Run to verify they pass** → PASS.
- [ ] **Step 5: Commit** — `feat(widget-backend): fleet catalog-sync scheduler + sync-plane kill scope (F5)`.

---

## Task 12: Harden scope pinning (F3) + audit-completeness assertions (NN#5)

**Files:**
- Modify: `packages/widget-backend/test/order-attribution-scope-pinning.test.ts`
- Test: (same file + a new `packages/widget-backend/test/catalog-sync-audit.test.ts`)

- [ ] **Step 1: Write failing scope-pinning assertions** — extend the existing anti-creep test so **write** scopes are hard-excluded from the code-level default and (for the production posture) from `shopify.app.toml`:

```ts
it("no write scope is a code-level install default (write_* is staging-dev-app-only) [F3]", () => {
  const scopes = INSTALL_SCOPES_DEFAULT.split(",").map(s => s.trim());
  for (const w of ["write_products", "write_customers", "write_orders", "write_inventory"]) {
    expect(scopes).not.toContain(w);
  }
});
it("the admin sync scopes are exactly read_products,read_inventory (least privilege) [F3]", () => {
  // assert the constant the install uses for the admin OAuth scope request is read-only
  expect(ADMIN_SYNC_SCOPES).toEqual(["read_products", "read_inventory"]);
});
```

(Introduce a `ADMIN_SYNC_SCOPES` constant if one does not exist, colocated with `ORDER_ATTRIBUTION_ADMIN_SCOPE` in `shopify-webhook-identity.ts`, and reference it from the install wiring.)
- [ ] **Step 2: Write failing audit test** — mint/refresh/delete/backfill/delta each emit an audit entry; assert on the in-memory store's audit log that the actions `admin_token.store`, `admin_token.refresh`, `admin_token.delete`, `catalog_product.write`, and the backfill truncation log all appear (NN#5).
- [ ] **Step 3: Run to verify they fail** → FAIL.
- [ ] **Step 4: Implement** any missing constant/audit call surfaced by the tests (most audit calls were added in Tasks 4/6/7/9 — this task closes gaps).
- [ ] **Step 5: Run to verify they pass** → PASS.
- [ ] **Step 6: Commit** — `test(widget-backend): pin least-privilege scopes + audit completeness for catalog sync (F3, NN#5)`.

---

## Task 13: Compose, migrate, and enable on staging

**Files:**
- Modify: `packages/widget-backend/src/server.ts` (construct the two new stores + client wiring; `migrate()`; inject deps into install/webhooks/backfill; grounding swap flag)
- Test: `packages/widget-backend/test/server-catalog-sync-wiring.test.ts`

**Interfaces:**
- Consumes: everything above. Constructs `PostgresCatalogProductStore(runtimeResult.sql)` (guarded `instanceof … migrate()` at the `server.ts:463`/`:855-860` pattern), `createAdminTokenStore(store, adminCredCrypto())` with a **distinct** crypto scope (`createAesGcmCrypto(secrets, { secretName: "MEMORY_ENCRYPTION_KEY__admin-cred" })` or the scope-aware path — mirror `merchantCredCrypto()` at `server.ts:423-435`), and the Task 3 client factory.

- [ ] **Step 1: Write failing wiring test** — booting the server test harness with the catalog-sync flags on constructs the catalog-product store and injects `catalogProduct` into the grounding path + `adminTokens` into install/webhook deps (assert via the existing `opts?.*` test seams, mirroring `merchantCredentials` at `server.ts:1228-1229`).
- [ ] **Step 2: Run to verify it fails** → FAIL.
- [ ] **Step 3: Implement the wiring.** Construct the stores behind flags (`CATALOG_LOCAL_SERVING` default-on staging, `ADMIN_TOKEN_CUSTODY_ENABLED`, `CATALOG_BACKFILL_ENABLED`); expose test seams; call `.migrate()`; inject `catalogProduct` into `CatalogIndexDeps` (`server.ts` ~:881) and into the local grounding port; inject `adminTokens` into `registerShopifyInstallRoutes` (:1304) and `registerShopifyWebhookRoutes` (:1554); use the distinct admin crypto scope (F2).
- [ ] **Step 4: Run to verify it passes** → PASS.
- [ ] **Step 5: Full gate** — `pnpm test` (all green), then `merge-gate.sh`. **Do not set `GOOGLE_CLOUD_PROJECT`.**
- [ ] **Step 6: Commit** — `feat(widget-backend): wire durable catalog sync (stores, client, grounding swap, migrate) behind staging flags`.
- [ ] **Step 7: Staging enablement (operator, not code)** — after merge + deploy: set the catalog-sync flags on the staging service, run `runCatalogSyncScheduler` for `palup-skincare-jason`, and verify the storefront + assistant show products with **no** live Shopify call on the hot path (the >1000-SKU store from memory `storefront-demo-catalog-over-1000-skus`). Production enable is a separate §5 human promotion (F9: separate DB + key material) — **out of scope for this plan.**

---

## Self-Review

**Spec coverage:** §4.1 serving→Task 8; §4.2 store→Tasks 1-2; §4.3 client→Task 3; §4.4 backfill→Task 7; §4.5/§5 delta+declarative webhooks→Tasks 6,10; §5.1 custody→Tasks 4,5,9; §5.3 fleet scheduler→Task 11; §6 governance (least-priv/kill/audit)→Tasks 11,12; durability invariant→Task 8 test. ADR-0022 conditions: F1→Task 9; F2→Tasks 4,13; F3→Task 12; F4→Task 3; F5→Task 11; F6→Task 5; F7→Task 5; F8→Tasks 1,6; F9→Task 13 (prod deferred); audit NN#5→Task 12. All covered.

**Placeholder scan:** no TBD/TODO left as work items; the three "Implementation note" callouts are spec §13 verify-on-shopify.dev items (bulk-op lifecycle, token-exchange refresh, result host) explicitly deferred to implementation and each has a concrete conservative default to code against.

**Type consistency:** `CatalogProductRecord`/`CatalogProductPort` names/fields identical across Tasks 1,2,6,8,9. `AdminTokenStore`/`ADMIN_CRED_KEY_SCOPE` consistent Tasks 4,5,9,13. `CATALOG_SYNC_AGENT_TYPE` consistent Tasks 11,12. `getFreshAdminToken` produced in Task 5, consumed in Task 7.
