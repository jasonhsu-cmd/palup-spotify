# S2 — Serving Unlock (render large catalogs) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a >1000-SKU store actually RENDER products in `/chat` via `CATALOG_RETRIEVAL` — serve the top-K from the S1 pgvector corpus + a by-id `ProductFacts` price hydrate, instead of fetching the whole catalog every turn.

**Architecture:** On the flag-on render path the brain fetches only a brand/policy *shell* (never the full catalog), asks the retriever for top-K ids, builds each `Product` from the corpus row's stable render metadata (`title`, `variantId`), then overlays fresh `price`/`availableForSale` through the existing A1b hydrate-by-id. Nothing here touches `ctx.products`; the flag-off path keeps calling `getContext` and is byte-identical to the golden. The producer, the shell port, the retriever, the index scale bump, and the batch embedder are the supporting changes.

**Tech Stack:** TypeScript (Node, ESM). Packages: `@palup/platform-ports` (ports), `@palup/widget-brain` (the brain + its own port types), `@palup/widget-backend` (Shopify adapter, catalog-index job, catalog-retriever, server composition), `@palup/model-vertex` (embedder). Tests: vitest. Vector backend: S1 pgvector store (already shipped) + the in-memory `VectorPort` for unit/E2E; testcontainer harness `withPgvector`/`startPgvectorContainer` (`packages/state-postgres/test/helpers/pgvector-container.ts`) for the pgvector variant.

**Spec:** `docs/superpowers/specs/2026-08-15-s2-serving-unlock-design.md` (read it fully first). Parent: `docs/superpowers/specs/2026-08-15-catalog-retrieval-scale-design.md`.

## Global Constraints

Every task's requirements implicitly include this section. Copied verbatim from the S2 brief:

- **Test-first (ATDD):** write the failing test, run it RED, then implement to GREEN. Never implement before a red test exists.
- **Never set `GOOGLE_CLOUD_PROJECT`.** Run ALL tests with `env -u GOOGLE_CLOUD_PROJECT …` so backend tests route to the MOCK path (setting it sends integration tests at real Vertex → 5000ms timeouts that look like a regression).
- **Buildable on the MOCK + pgvector-TESTCONTAINER path with a FAKE embed model.** NO real Vertex in any test. The in-memory `VectorPort` + a fake embed model cover most; `withPgvector` is available for the pgvector variant.
- **Ships DARK.** Everything lives behind `catalogRetrievalEnabled` (constructor arg, default `false`). Flag-off must be byte-identical to the goldens (`retrieval-flag-off`, `cards-cart-flag-off`, `citations-flag-off`). The `getShell` call + by-id build live strictly inside the flag-on branch.
- **Do NOT flip any governance flag.** Never set `CATALOG_RETRIEVAL`, `VECTOR_ANN`, `PRODUCT_FACTS_HYDRATION`, or any posture flag on in code, config, or a committed env. Enabling serving is an HITL §5 promotion (S4), out of scope.
- **Portability (ADR-0001):** no Shopify or Vertex types cross a port. Provider specifics stay inside the adapter.
- **Serving a >5000-SKU store requires `VECTOR_ANN=true`** (the brute-force store caps at a 5000-row scan). Document this precondition; do NOT flip it.

**Out of scope (S3/S4 — do NOT build):** freshness reconcile/scheduler, D2 fail-honest staleness ceiling work beyond what already exists, `eval:retrieval`/`shadow` at scale, per-tenant `CATALOG_RETRIEVAL` enablement, retrieval-scoped kill.

---

## File Structure

**Modified**
- `packages/widget-backend/src/jobs/catalog-index.ts` — corpus `VectorRecord.metadata` gains `title` + `variantId` (Task 1); `MAX_INDEXED_PRODUCTS` decouples from serving's ceiling → 50000; index-fetch pages deep (Task 4).
- `packages/platform-ports/src/grounding-port.ts` — new `GroundingShell` + `GroundingPort.getShell` (Task 2).
- `packages/platform-ports/src/index.ts` — export `GroundingShell` (Task 2).
- `packages/platform-ports/src/contract/grounding-port.contract.ts` — contract now covers `getShell` (Task 2).
- `packages/platform-ports/src/grounding-cache.ts` — caching wrapper implements `getShell` (Task 2).
- `packages/widget-brain/src/adapters/static-grounding.ts` — `StaticGroundingAdapter.getShell` (Task 2).
- `packages/widget-backend/src/shopify-grounding.ts` — `getShell` + a brand/policy-only shell fetch + `mapStorefrontToShell`; index-fetch deep page ceiling (Tasks 2, 4).
- `packages/widget-backend/src/model.ts` — the composition-root `router` GroundingPort gains `getShell` (Task 2).
- `packages/widget-brain/src/types.ts` — `RetrievedProduct.metadata`; new `CatalogRetrievalResult`; `CatalogRetrieverPort.retrieve` returns it (Task 3).
- `packages/widget-brain/src/brain.ts` — flag-on render path calls `getShell`, `retrieveViaShell` builds `Product`s from metadata, `systemPrompt` takes a corpus-total for the "N of M" header (Task 3).
- `packages/widget-backend/src/catalog-retriever.ts` — `retrieve` returns hits-with-metadata + `corpusProductCount` (Task 3).
- `packages/model-vertex/src/vertex-adapter.ts` — `embedBatch` gains per-request timeout + retry/backoff + bounded concurrency (Task 5).
- `packages/model-vertex/src/create.ts` — read `PALUP_EMBED_TIMEOUT_MS` / `PALUP_EMBED_MAX_RETRIES` / `PALUP_EMBED_CONCURRENCY` (Task 5).
- `.github/workflows/deploy-staging.yml` — index/deploy config pins `PALUP_EMBED_MODEL`/`PALUP_EMBED_DIMENSION` (Task 5, dark).
- Comments/docs reconciliation (Task 7).

**Created (tests)**
- `packages/widget-backend/test/catalog-index-metadata.test.ts` (Task 1)
- `packages/platform-ports/test/grounding-shell.test.ts` (Task 2)
- `packages/widget-brain/test/serving-unlock.test.ts` (Task 3)
- `packages/widget-backend/test/catalog-retriever-metadata.test.ts` (Task 3)
- `packages/widget-backend/test/index-scale.test.ts` (Task 4)
- `packages/model-vertex/test/vertex-embed-batch.test.ts` (Task 5)
- `packages/widget-backend/test/serving-unlock-e2e.test.ts` (Task 6, headline)

**Known scope boundary (documented, not built):** the allergy/ingredient guardrail rung (`brain.ts:1169`) fetches its own `grounding.getContext(tenantId)` and reads `ctx.products[].ingredients`. It is a *guardrail* rung that returns before the clean sales path — S2 does NOT change it. On a >1000-SKU store an ingredient question therefore degrades through the caching wrapper's safe-empty (honest "I can't confirm from here" + policy fallback), never a wrong answer. Broadening it to the shell/retrieval path is out of S2 scope; call it out in the PR.

---

## Task 1: Producer — corpus metadata carries the stable render fields

**Files:**
- Modify: `packages/widget-backend/src/jobs/catalog-index.ts:649-656` (the `VectorRecord` build)
- Test: `packages/widget-backend/test/catalog-index-metadata.test.ts` (create)

**Interfaces:**
- Consumes: `Product` (`grounding-port.ts:6-52` — `id, title, description, price, variantId?, tags?, availableForSale?, priceConfirmed?`), `PlannedProduct` (`catalog-index.ts:294-299` — `productId, recordId, text, hash`).
- Produces: corpus records whose `metadata` is `{ kind: "product", productId, contentHash, title, variantId? }`. `title` is always present; `variantId` is present only when the source `Product` carried one. `productEmbedText` (the embedded vector text) is UNCHANGED. Consumed by Tasks 3 (retriever passes it through) and 3 (brain builds `Product` from it).

**Build-verify first:** `Product.variantId` is populated by the Shopify adapter (`shopify-grounding.ts:102`, `firstVariantNumericId`) — so the producer can source `variantId` straight from the fetched `GroundingContext.products`. No new fetch field needed.

- [ ] **Step 1: Write the failing test**

```ts
// packages/widget-backend/test/catalog-index-metadata.test.ts
import { describe, it, expect } from "vitest";
import {
  createInMemoryVectorStore,
  InMemoryRuntimeStore,
  type GroundingContext,
  type ModelPort,
} from "@palup/platform-ports";
import { runCatalogIndex, catalogNamespace } from "../src/jobs/catalog-index.js";

/** A fake embedder: deterministic, dimension-3, so no real Vertex is touched. */
function fakeEmbedModel(): ModelPort {
  return {
    async complete() {
      throw new Error("not used");
    },
    async embed(req) {
      return {
        vectors: req.texts.map((_t, i) => [1, i, 0]),
        dimension: 3,
        model: "fake-embed",
        purpose: req.purpose,
      };
    },
  };
}

function catalogOf(products: GroundingContext["products"]): GroundingContext {
  return { tenantId: "t1", brandName: "Brand", products, policy: { returns: "r", shipping: "s" } };
}

describe("catalog-index producer — render metadata", () => {
  it("writes title and variantId into each corpus record's metadata", async () => {
    const vector = createInMemoryVectorStore();
    const store = new InMemoryRuntimeStore();
    const catalog = async () =>
      catalogOf([
        { id: "p1", title: "Vitamin-C Serum", description: "d", price: "$34", variantId: "111", tags: ["serum"] },
        { id: "p2", title: "Daily Cleanser", description: "d", price: "$18" }, // no variantId
      ]);

    const [report] = await runCatalogIndex({ store, vector, model: fakeEmbedModel(), catalog }, ["t1"]);
    expect(report.outcome).toBe("indexed");

    const rows = await vector.query(catalogNamespace("t1"), { text: "", k: 10 });
    const byId = new Map(rows.map((r) => [(r.metadata as any).productId, r.metadata as any]));
    expect(byId.get("p1")).toMatchObject({ kind: "product", productId: "p1", title: "Vitamin-C Serum", variantId: "111" });
    expect(byId.get("p1").contentHash).toEqual(expect.any(String));
    // variantId is OMITTED (not undefined-valued) when the source has none.
    expect(byId.get("p2")).toMatchObject({ kind: "product", productId: "p2", title: "Daily Cleanser" });
    expect("variantId" in byId.get("p2")).toBe(false);
  });

  it("prunes a delisted product's row on the next index run (corpus is the authoritative set)", async () => {
    const vector = createInMemoryVectorStore();
    const store = new InMemoryRuntimeStore();
    let products = [
      { id: "p1", title: "Serum", description: "d", price: "$34" },
      { id: "p2", title: "Cleanser", description: "d", price: "$18" },
    ];
    const catalog = async () => catalogOf(products);
    await runCatalogIndex({ store, vector, model: fakeEmbedModel(), catalog }, ["t1"]);
    products = products.filter((p) => p.id !== "p2"); // delist p2
    const [r2] = await runCatalogIndex({ store, vector, model: fakeEmbedModel(), catalog }, ["t1"]);
    expect(r2.removed).toBe(1);
    const rows = await vector.query(catalogNamespace("t1"), { text: "", k: 10 });
    expect(rows.map((x) => (x.metadata as any).productId).sort()).toEqual(["p1"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `env -u GOOGLE_CLOUD_PROJECT pnpm vitest run packages/widget-backend/test/catalog-index-metadata.test.ts`
Expected: FAIL — the first test's `title`/`variantId` assertions fail (metadata has only `kind`/`productId`/`contentHash`). (The delisted test may already pass — it pins existing behavior we must not break.)

- [ ] **Step 3: Add title + variantId to the record metadata**

The record is built from `toEmbed` (a `PlannedProduct[]`), which does not carry `title`/`variantId`. Resolve them from the fetched catalog by id. In `indexOneTenant`, `catalog.products` is in scope. Change the record build (`catalog-index.ts:649-656`):

```ts
  // ── write ──
  const byId = new Map(catalog.products.map((p) => [p.id, p]));
  const records: VectorRecord[] = toEmbed.map((p) => {
    const src = byId.get(p.productId);
    // No price/availability in the corpus (unchanged invariant) — only the STABLE render fields the
    // serving path builds a card from (S2). `title` is guaranteed non-empty by planProducts (a product
    // with no indexable text already refused the whole catalog). `variantId` is carried only when present.
    return {
      id: p.recordId,
      vector: vectors.get(p.recordId)!,
      metadata: {
        kind: "product",
        productId: p.productId,
        contentHash: p.hash,
        title: src?.title ?? "",
        ...(src?.variantId ? { variantId: src.variantId } : {}),
      },
    };
  });
```

(Leave the read-back verification at `catalog-index.ts:662-673` unchanged — it keys off `contentHash`, which is still present.)

- [ ] **Step 4: Run test to verify it passes**

Run: `env -u GOOGLE_CLOUD_PROJECT pnpm vitest run packages/widget-backend/test/catalog-index-metadata.test.ts`
Expected: PASS (both tests).

- [ ] **Step 5: Regression — the existing index-job suite still green**

Run: `env -u GOOGLE_CLOUD_PROJECT pnpm vitest run packages/widget-backend/test/catalog-index-job.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/widget-backend/src/jobs/catalog-index.ts packages/widget-backend/test/catalog-index-metadata.test.ts
git commit -m "feat(catalog-index): carry title+variantId in corpus render metadata (dark)"
```

---

## Task 2: Shell port + every implementer

**Files:**
- Modify: `packages/platform-ports/src/grounding-port.ts:61-71` (add `GroundingShell` + `getShell`)
- Modify: `packages/platform-ports/src/index.ts:14-16` (export `GroundingShell`)
- Modify: `packages/platform-ports/src/contract/grounding-port.contract.ts` (cover `getShell`)
- Modify: `packages/platform-ports/src/grounding-cache.ts` (wrapper `getShell`)
- Modify: `packages/widget-brain/src/adapters/static-grounding.ts` (`getShell`)
- Modify: `packages/widget-backend/src/shopify-grounding.ts` (`getShell` + shell fetch + `mapStorefrontToShell`)
- Modify: `packages/widget-backend/src/model.ts:55-71` (router `getShell`)
- Test: `packages/platform-ports/test/grounding-shell.test.ts` (create)

**Interfaces:**
- Produces:
  ```ts
  export interface GroundingShell {
    tenantId: string;
    brandName: string;
    policy: StorePolicy;
  }
  // added to GroundingPort:
  getShell(tenantId: string): Promise<GroundingShell>;
  ```
  `GroundingShell` is `GroundingContext` minus `products`. Consumed by Task 3 (`brain.retrieveViaShell`).
- Consumes: `GroundingContext`, `StorePolicy` (`grounding-port.ts`); `StorefrontData`/`mapStorefrontToContext` shapes (`shopify-grounding.ts`).

> Adding a required method to `GroundingPort` breaks every implementer's compilation until it is added everywhere — so this whole task is ONE coherent unit (the port + all five implementers + the contract). The task-brief named "demo/static adapter, any test doubles"; the *composition-root* implementers (`grounding-cache.ts` wrapper, `model.ts` router) are equally required or `/chat` will not compile.

- [ ] **Step 1: Write the failing contract-driven test**

Extend the shared contract, then write a test that runs it against every adapter.

```ts
// packages/platform-ports/test/grounding-shell.test.ts
import { describe, it, expect } from "vitest";
import { InMemoryRuntimeStore, createCachingGroundingPort, type GroundingPort } from "@palup/platform-ports";
import { StaticGroundingAdapter } from "@palup/widget-brain";

describe("GroundingShell — brand+policy only, no products", () => {
  const adapters: Array<[string, () => GroundingPort]> = [
    ["static", () => new StaticGroundingAdapter()],
    ["caching(static)", () => createCachingGroundingPort(new StaticGroundingAdapter(), new InMemoryRuntimeStore())],
  ];
  for (const [name, make] of adapters) {
    it(`${name}: getShell returns tenant, brand and policy`, async () => {
      const shell = await make().getShell("demo");
      expect(shell.tenantId).toBe("demo");
      expect(shell.brandName.length).toBeGreaterThan(0);
      expect(typeof shell.policy.returns).toBe("string");
      expect(typeof shell.policy.shipping).toBe("string");
      // The shape carries NO products key at all.
      expect("products" in (shell as object)).toBe(false);
    });
  }
});
```

Also add to `grounding-port.contract.ts` (inside `runGroundingPortContract`):

```ts
    it("getShell returns the same brand + policy as getContext, without products", async () => {
      const a = makeAdapter();
      const ctx = await a.getContext("demo");
      const shell = await a.getShell("demo");
      expect(shell.tenantId).toBe(ctx.tenantId);
      expect(shell.brandName).toBe(ctx.brandName);
      expect(shell.policy).toEqual(ctx.policy);
      expect("products" in (shell as object)).toBe(false);
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `env -u GOOGLE_CLOUD_PROJECT pnpm vitest run packages/platform-ports/test/grounding-shell.test.ts`
Expected: FAIL to COMPILE — `getShell` is not on `GroundingPort`.

- [ ] **Step 3a: Add the port type + export**

`grounding-port.ts` — after `GroundingContext` (line 66) and inside `GroundingPort`:

```ts
export interface GroundingShell {
  tenantId: string;
  brandName: string;
  policy: StorePolicy;
}

export interface GroundingPort {
  /** Tenant-scoped (isolation): only ever returns the given tenant's own catalog/policy. */
  getContext(tenantId: string): Promise<GroundingContext>;
  /**
   * S2 — brand + policy ONLY (no products). The render path fetches this instead of the whole catalog,
   * so it can never hit the catalog-size ceiling. Tenant-scoped exactly like `getContext`.
   */
  getShell(tenantId: string): Promise<GroundingShell>;
}
```

`index.ts:14-16` — add `GroundingShell` to the type export list next to `GroundingContext`.

- [ ] **Step 3b: Static adapter**

`static-grounding.ts` — add to `StaticGroundingAdapter`, reusing `getContext` (the fixtures are tiny; no ceiling concern):

```ts
  async getShell(tenantId: string): Promise<GroundingShell> {
    const { brandName, policy } = await this.getContext(tenantId);
    return { tenantId, brandName, policy };
  }
```

Import `GroundingShell` in the type import at the top of the file.

- [ ] **Step 3c: Caching wrapper**

`grounding-cache.ts` — the wrapper caches/degrades `getContext`; `getShell` is a lightweight passthrough with the SAME timeout + fail-safe discipline (no product pagination to cache, so no TTL cache needed — a shell fetch is one cheap call; degrade to a safe-empty shell on error):

```ts
    async getShell(tenantId: string): Promise<GroundingShell> {
      try {
        const shell = await withTimeout(inner.getShell(tenantId), timeoutMs);
        if (shell.tenantId !== tenantId) throw new Error("grounding tenant mismatch");
        return shell;
      } catch {
        // Fail CLOSED, exactly like getContext's cold path: a brandless "this store" + empty policy, so the
        // brain grounds honestly rather than inventing or leaking.
        return { tenantId, brandName: "this store", policy: { returns: "", shipping: "" } };
      }
    },
```

Import `GroundingShell` in the type import at the top.

- [ ] **Step 3d: Shopify adapter — shell fetch that never paginates**

`shopify-grounding.ts` — add a brand/policy-only query, a pure mapper, an injectable shell-fetch type, and `getShell` on the adapter:

```ts
/** Shop brand + policy ONLY — no products connection, so this is ALWAYS a single round-trip and can
 *  never approach the catalog page ceiling. */
const STOREFRONT_SHELL_QUERY = `query PalUpGroundingShell {
  shop { name refundPolicy { body } shippingPolicy { body } }
}`;

export type StorefrontShellFetch = (creds: ShopifyStoreCreds) => Promise<StorefrontData>;

/** Pure mapping: shell response → GroundingShell. Stamps the REQUESTED tenantId, bounds merchant text. */
export function mapStorefrontToShell(tenantId: string, data: StorefrontData): GroundingShell {
  const policy: StorePolicy = {
    returns: bound(data.shop?.refundPolicy?.body, MAX_DESC),
    shipping: bound(data.shop?.shippingPolicy?.body, MAX_DESC),
  };
  return { tenantId, brandName: bound(data.shop?.name, MAX_TITLE) || "this store", policy };
}

/** One-shot shell fetch: shop/policy only. Same host guard + token header + timeout as `storefrontFetch`,
 *  but no pagination loop. */
export function storefrontShellFetch(
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
  opts: { version?: string; timeoutMs?: number; log?: (info: StorefrontEgressLog) => void } = {},
): StorefrontShellFetch {
  const version = opts.version ?? STOREFRONT_API_VERSION;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PAGE_TIMEOUT_MS;
  const log = opts.log ?? ((info: StorefrontEgressLog) => console.log("[grounding.shopify] " + JSON.stringify(info)));
  return async (creds) => {
    if (!SHOP_HOST.test(creds.shopDomain)) {
      throw new Error("refusing Shopify fetch: shopDomain is not a *.myshopify.com host");
    }
    const url = `https://${creds.shopDomain}/api/${version}/graphql.json`;
    const start = Date.now();
    let status = 0;
    let ok = false;
    try {
      const res = await fetchFn(url, {
        method: "POST",
        headers: { "content-type": "application/json", "Shopify-Storefront-Private-Token": creds.accessToken },
        body: JSON.stringify({ query: STOREFRONT_SHELL_QUERY }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      status = res.status;
      ok = res.ok;
      if (!res.ok) throw new Error("Shopify Storefront API request failed");
      const json = (await res.json()) as { data?: StorefrontData; errors?: Array<{ message?: string }> };
      if (Array.isArray(json.errors) && json.errors.length) throw new Error("Shopify Storefront GraphQL error");
      return json.data ?? {};
    } finally {
      try { log({ host: creds.shopDomain, status, ok, ms: Date.now() - start, page: 0 }); } catch { /* ignore */ }
    }
  };
}
```

Update `createShopifyGroundingAdapter` to accept an injectable shell fetch and implement `getShell`:

```ts
export function createShopifyGroundingAdapter(
  creds: ShopifyStoreCreds,
  fetchImpl: StorefrontFetch = storefrontFetch(),
  shellFetchImpl: StorefrontShellFetch = storefrontShellFetch(),
): GroundingPort {
  return {
    async getContext(tenantId: string): Promise<GroundingContext> {
      const data = await fetchImpl(creds);
      return mapStorefrontToContext(tenantId, data);
    },
    async getShell(tenantId: string): Promise<GroundingShell> {
      const data = await shellFetchImpl(creds);
      return mapStorefrontToShell(tenantId, data);
    },
  };
}
```

Add `GroundingShell` to the type import at the top (`import type { GroundingContext, GroundingPort, GroundingShell, Product, StorePolicy } from "@palup/platform-ports";`).

- [ ] **Step 3e: Composition-root router**

`model.ts` — the `router` object (`model.ts:55-69`) needs `getShell`. It mirrors `getContext`'s credential routing but uses the shell path (fixtures reuse the static adapter's `getShell`):

```ts
    async getShell(tenantId: string): Promise<GroundingShell> {
      const outcome = await resolveStorefrontCredential(tenantId, {
        secrets,
        credRead: opts.credRead,
        readbackEnabled: opts.readbackEnabled,
        shopDomainFor: opts.shopDomainFor,
      });
      if (outcome.status === "live")
        return createShopifyGroundingAdapter(outcome.creds, opts.shopifyFetch).getShell(tenantId);
      if (outcome.status === "refuse") throw new GroundingCredentialUnreadableError(outcome.reason);
      return fixtures.getShell(tenantId);
    },
```

Add `GroundingShell` to the type import at the top of `model.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `env -u GOOGLE_CLOUD_PROJECT pnpm vitest run packages/platform-ports/test/grounding-shell.test.ts packages/platform-ports/test/grounding-cache.test.ts`
Expected: PASS.

- [ ] **Step 5: Full compile + any other implementers**

Run: `env -u GOOGLE_CLOUD_PROJECT pnpm -r build` (or the repo's typecheck). Any remaining `GroundingPort` implementer that does not compile (an eval harness double, `packages/eval/src/*`, `control-plane/src/live-grader.ts`, or a test double) gets a one-line `getShell` delegating to its `getContext` (`const { brandName, policy } = await this.getContext(t); return { tenantId: t, brandName, policy };`). Fix each until the workspace compiles.
Expected: clean build.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(grounding): add GroundingShell + getShell to the port and every adapter"
```

---

## Task 3: Serving rewire — render from the shell + retrieved metadata

**Files:**
- Modify: `packages/widget-brain/src/types.ts:163-192` (`RetrievedProduct`, `CatalogRetrievalResult`, `CatalogRetrieverPort`)
- Modify: `packages/widget-brain/src/brain.ts` (`systemPrompt` header at :191/:230-232; `retrieveCandidates` → `retrieveViaShell` at :949-988; `groundedMessages` ctx/retrieval at :1009-1013)
- Modify: `packages/widget-backend/src/catalog-retriever.ts:96-158` (return the new result)
- Test: `packages/widget-brain/test/serving-unlock.test.ts` (create)
- Test: `packages/widget-backend/test/catalog-retriever-metadata.test.ts` (create)

**Interfaces:**
- Consumes: `GroundingShell`/`getShell` (Task 2); corpus `metadata.title`/`metadata.variantId` (Task 1); `Product` (`grounding-port.ts:6-52`); `hydrateProductFacts` (`hydrate-facts.ts:51`); `CatalogManifest.products` (`catalog-index.ts:174`).
- Produces:
  ```ts
  export interface RetrievedProduct {
    productId: string;
    score: number;
    /** S2 — the corpus row's render metadata (title, variantId, …). Opaque to the brain except for the
     *  known keys it reads; NEVER carries price/availability (those live in ProductFactsPort). */
    metadata?: Record<string, unknown>;
  }
  export interface CatalogRetrievalResult {
    hits: RetrievedProduct[];
    /** manifest.products — the corpus size, for the render path's "N of M" prompt header. */
    corpusProductCount: number;
  }
  export interface CatalogRetrieverPort {
    retrieve(ctx: { tenantId: string; query: string; k: number }): Promise<CatalogRetrievalResult>;
  }
  ```
  Consumed by `brain.retrieveViaShell` and Task 6.

> **Design decision (spec left it open):** the "N of M" corpus count comes from the retriever's own manifest read (`manifest.products`), returned as `CatalogRetrievalResult.corpusProductCount`. The brain has no `RuntimeStatePort`, and the retriever already reads the manifest on every call — one round-trip, no second port method.

- [ ] **Step 1: Write the failing brain test**

```ts
// packages/widget-brain/test/serving-unlock.test.ts
import { describe, it, expect } from "vitest";
import type { GroundingPort, ModelPort, ProductFactsPort } from "@palup/platform-ports";
import { createInMemoryProductFactsStore } from "@palup/platform-ports";
import { createBrain, DEFAULT_POLICY } from "../src/index.js";
import type { CatalogRetrieverPort, Signals } from "../src/types.js";

/** A grounding port whose getContext THROWS (proving the render path never calls it) but whose getShell
 *  returns brand+policy. */
function shellOnlyGrounding(): GroundingPort {
  return {
    async getContext() {
      throw new Error("getContext must not be called on the retrieval render path");
    },
    async getShell(tenantId) {
      return { tenantId, brandName: "BigStore", policy: { returns: "30 days", shipping: "free" } };
    },
  };
}

/** A retriever returning two hits WITH render metadata + a corpus size of 1500. */
function fakeRetriever(): CatalogRetrieverPort {
  return {
    async retrieve() {
      return {
        corpusProductCount: 1500,
        hits: [
          { productId: "p-serum", score: 0.9, metadata: { kind: "product", productId: "p-serum", title: "Glow Serum", variantId: "v1" } },
          { productId: "p-cream", score: 0.8, metadata: { kind: "product", productId: "p-cream", title: "Night Cream" } },
        ],
      };
    },
  };
}

/** Captures the system prompt so we can assert what was rendered. */
function capturingModel(): { model: ModelPort; system: () => string } {
  let sys = "";
  return {
    system: () => sys,
    model: {
      async complete(req) {
        sys = req.messages.find((m) => m.role === "system")?.content ?? "";
        return { text: "Here are two options.", model: "mock" };
      },
      async embed() {
        throw new Error("brain does not embed");
      },
    },
  };
}

const K = 12;
const signals: Signals = { tenantId: "t1" };

describe("S2 — serving unlock render path", () => {
  it("renders top-K products built from corpus metadata + fresh ProductFacts price, no getContext", async () => {
    const facts = createInMemoryProductFactsStore();
    await facts.upsertMany("t1", [
      { productId: "p-serum", price: "$40", availableForSale: true, updatedAt: new Date().toISOString() },
      { productId: "p-cream", price: "$55", updatedAt: new Date().toISOString() },
    ]);
    const { model, system } = capturingModel();
    const brain = createBrain(
      model, shellOnlyGrounding(), DEFAULT_POLICY, undefined, "shopper-demo",
      undefined, false, false, false, false,
      fakeRetriever(),   // catalogRetriever
      true,              // catalogRetrievalEnabled
      K,                 // catalogRetrievalK
      false, false, false, false, // citations/cards/cart/serverGuard
      facts as ProductFactsPort, // productFactsPort
      true,              // productFactsHydrationEnabled
    );
    const decision = await brain.decide(signals, "I want a serum");
    const prompt = system();
    expect(decision.flags).toContain("retrieval:applied");
    expect(prompt).toContain("Glow Serum ($40)");
    expect(prompt).toContain("Night Cream ($55)");
    // "N of M" reads the corpus count from the manifest, not ctx.products.
    expect(prompt).toContain("CATALOG (2 of 1500 products");
  });

  it("fails OPEN with no catalog block when retrieval throws (no full catalog to fall back to)", async () => {
    const throwingRetriever: CatalogRetrieverPort = {
      async retrieve() {
        throw new Error("corpus unavailable");
      },
    };
    const { model, system } = capturingModel();
    const brain = createBrain(
      model, shellOnlyGrounding(), DEFAULT_POLICY, undefined, "shopper-demo",
      undefined, false, false, false, false,
      throwingRetriever, true, K,
    );
    const decision = await brain.decide(signals, "I want a serum");
    expect(decision.flags).toContain("retrieval:unavailable");
    // Brand + policy still present; no product lines.
    expect(system()).toContain("BigStore");
    expect(system()).not.toContain("Glow Serum");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `env -u GOOGLE_CLOUD_PROJECT pnpm vitest run packages/widget-brain/test/serving-unlock.test.ts`
Expected: FAIL — `getContext` throws (render path still calls it) and the return-type mismatch fails to compile.

- [ ] **Step 3a: Types**

`types.ts` — add `metadata?` to `RetrievedProduct` (:163-169), add `CatalogRetrievalResult`, and change `CatalogRetrieverPort.retrieve` (:190-192) to return `Promise<CatalogRetrievalResult>` (exact shapes in the Interfaces block above).

- [ ] **Step 3b: `systemPrompt` takes a corpus total**

`brain.ts` — add a parameter and use it in the header only. Signature (`brain.ts:162-167`):

```ts
function systemPrompt(
  policy: Policy,
  ctx?: GroundingContext,
  retrieved?: Product[],
  citations?: { map: CitationMap; rendered?: Product[] },
  corpusTotal?: number, // S2 — the corpus size for the "N of M" header on the shell/retrieval path
): string {
```

Header (`brain.ts:230-232`), fall back to `ctx.products.length` so the pre-S2 / flag-off shape is byte-identical when `corpusTotal` is absent:

```ts
  const catalogHeader = retrieved
    ? `CATALOG (${retrieved.length} of ${corpusTotal ?? ctx!.products.length} products, selected for this question - NOT the whole catalog):`
    : "CATALOG:";
```

- [ ] **Step 3c: Replace `retrieveCandidates` with `retrieveViaShell`**

`brain.ts:949-988` — delete `retrieveCandidates` (its `ctx.products.length <= k` short-circuit at :960 and its `byId = new Map(ctx.products.map(...))` resolver at :975 are gone) and add:

```ts
  // S2 — the RENDER path: fetch a brand/policy SHELL (never the whole catalog), retrieve top-K ids, and
  // BUILD each Product from the corpus row's stable render metadata (title/variantId). Price/availability
  // are overlaid later by the A1b hydrate. NEVER THROWS: every failure resolves to "no catalog block",
  // because there is no full catalog to fall back to on this path (that is the whole point of the shell).
  const retrieveViaShell = async (
    retriever: CatalogRetrieverPort,
    tenantId: string,
    query: string,
    flags: string[],
  ): Promise<{ ctx: GroundingContext | undefined; rendered?: Product[]; corpusTotal?: number }> => {
    const k = Math.max(1, Math.floor(catalogRetrievalK));
    let shell;
    try {
      shell = await grounding!.getShell(tenantId);
    } catch {
      flags.push("retrieval:unavailable");
      return { ctx: undefined }; // no brand/policy ⇒ generic assistant prompt (ctx undefined)
    }
    const ctx: GroundingContext = { tenantId: shell.tenantId, brandName: shell.brandName, products: [], policy: shell.policy };
    let result;
    try {
      result = await retriever.retrieve({ tenantId, query, k });
    } catch {
      flags.push("retrieval:unavailable");
      return { ctx }; // brand+policy, but no catalog block
    }
    const rendered: Product[] = [];
    const seen = new Set<string>();
    for (const hit of result.hits) {
      if (seen.has(hit.productId)) continue;
      const md = (hit.metadata ?? {}) as { title?: unknown; variantId?: unknown };
      const title = typeof md.title === "string" ? md.title : "";
      if (!title) continue; // a row with no render title is unusable — drop it rather than render blank
      seen.add(hit.productId);
      rendered.push({
        id: hit.productId,
        title,
        description: "", // corpus carries no description for render; price filled by hydrate below
        price: "",
        ...(typeof md.variantId === "string" && md.variantId ? { variantId: md.variantId } : {}),
      });
      if (rendered.length >= k) break; // the port's k is a request, not a promise — enforce it here too
    }
    if (rendered.length === 0) {
      flags.push("retrieval:unavailable");
      return { ctx, corpusTotal: result.corpusProductCount };
    }
    flags.push("retrieval:applied");
    return { ctx, rendered, corpusTotal: result.corpusProductCount };
  };
```

- [ ] **Step 3d: Branch `groundedMessages` on the flag**

`brain.ts:1009-1013` — replace the unconditional `getContext` + `retrieved` computation:

```ts
    // S2 — the RENDER path uses getShell + retrieval; every other path (and flag-off) uses getContext,
    // byte-identically. `corpusTotal` reaches systemPrompt for the "N of M" header.
    let ctx: GroundingContext | undefined;
    let retrieved: Product[] | undefined;
    let corpusTotal: number | undefined;
    if (catalogRetrievalEnabled && catalogRetriever && grounding && retrieval && retrieval.query.trim() !== "") {
      const built = await retrieveViaShell(catalogRetriever, tenantId, retrieval.query, retrieval.flags);
      ({ ctx, rendered: retrieved, corpusTotal } = built);
    } else {
      ctx = grounding ? await grounding.getContext(tenantId) : undefined;
    }
```

The A1b hydrate block (`brain.ts:1019-1031`) is UNCHANGED — it already reads `retrieved` and overlays via `hydrateProductFacts`. Update the final `systemPrompt` call (`brain.ts:1062`) to pass the total:

```ts
      { role: "system" as const, content: systemPrompt(policy, ctx, hydrated, citations, corpusTotal) + systemExtra + pageBlock + cartBlock },
```

- [ ] **Step 3e: Retriever returns the new result**

`catalog-retriever.ts:96-158` — return `{ hits, corpusProductCount }`, carry `m.metadata` on each hit, and read the count from the manifest (already fetched at :103):

```ts
    async retrieve({ tenantId, query, k }): Promise<CatalogRetrievalResult> {
      const text = query.trim();
      if (!text) throw new CatalogRetrievalUnavailable("catalog-retrieval: refusing to embed a blank query");
      const limit = Math.max(0, Math.floor(k));

      const manifest = await deps.store.get<CatalogManifest>({ tenantId }, MANIFEST_COLLECTION, MANIFEST_KEY);
      if (!manifest) {
        throw new CatalogRetrievalUnavailable(
          "catalog-retrieval: no catalog corpus is indexed for this tenant (run `pnpm catalog:index --tenant <id>`)",
        );
      }
      const corpusProductCount = manifest.products;
      if (limit === 0) return { hits: [], corpusProductCount };
      // ... (purpose check, canEmbed, embed, pin check, vector query — all UNCHANGED) ...

      const matches = await deps.vector.query(catalogNamespace(tenantId), { vector, k: limit });
      const hits: RetrievedProduct[] = [];
      for (const m of matches) {
        const productId = productIdOf(m.metadata);
        if (!productId) continue;
        if (!(m.score > 0)) continue;
        hits.push({ productId, score: m.score, ...(m.metadata ? { metadata: m.metadata } : {}) });
      }
      return { hits, corpusProductCount };
    },
```

Update the import to pull `CatalogRetrievalResult` from `@palup/widget-brain`.

- [ ] **Step 3f: Backend retriever test**

```ts
// packages/widget-backend/test/catalog-retriever-metadata.test.ts
import { describe, it, expect } from "vitest";
import { createInMemoryVectorStore, InMemoryRuntimeStore, type ModelPort } from "@palup/platform-ports";
import { createCatalogRetriever } from "../src/catalog-retriever.js";
import { runCatalogIndex, catalogNamespace } from "../src/jobs/catalog-index.js";

function fakeEmbed(): ModelPort {
  return {
    async complete() { throw new Error("unused"); },
    async embed(req) {
      // "serum" texts point along axis 0, others along axis 1 — a query for "serum" ranks serum first.
      return {
        vectors: req.texts.map((t) => (/serum/i.test(t) ? [1, 0, 0] : [0, 1, 0])),
        dimension: 3, model: "gemini-embedding-2", purpose: req.purpose,
      };
    },
  };
}

describe("catalog-retriever returns hits-with-metadata + corpus count", () => {
  it("carries title/variantId metadata and manifest.products", async () => {
    const vector = createInMemoryVectorStore();
    const store = new InMemoryRuntimeStore();
    const catalog = async () => ({
      tenantId: "t1", brandName: "B", policy: { returns: "r", shipping: "s" },
      products: [
        { id: "p1", title: "Glow Serum", description: "d", price: "$40", variantId: "v1", tags: ["serum"] },
        { id: "p2", title: "Cleanser", description: "d", price: "$18" },
      ],
    });
    await runCatalogIndex({ store, vector, model: fakeEmbed(), catalog }, ["t1"]);
    const retriever = createCatalogRetriever({ store, vector, model: fakeEmbed() });
    const { hits, corpusProductCount } = await retriever.retrieve({ tenantId: "t1", query: "serum please", k: 5 });
    expect(corpusProductCount).toBe(2);
    expect(hits[0].productId).toBe("p1");
    expect(hits[0].metadata).toMatchObject({ title: "Glow Serum", variantId: "v1" });
  });
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `env -u GOOGLE_CLOUD_PROJECT pnpm vitest run packages/widget-brain/test/serving-unlock.test.ts packages/widget-backend/test/catalog-retriever-metadata.test.ts`
Expected: PASS.

- [ ] **Step 5: Flag-off goldens byte-identical + existing retrieval/retriever suites**

Run: `env -u GOOGLE_CLOUD_PROJECT pnpm vitest run packages/widget-brain/test/retrieval-flag-off.test.ts packages/widget-brain/test/cards-cart-flag-off.test.ts packages/widget-brain/test/citations-flag-off.test.ts packages/widget-brain/test/catalog-retrieval.test.ts packages/widget-backend/test/catalog-retriever.test.ts packages/widget-backend/test/retrieval-eval.test.ts`
Expected: PASS. `catalog-retrieval.test.ts` / `catalog-retriever.test.ts` / `retrieval-eval.test.ts` will need their fake retrievers + `.retrieve` assertions updated to the new `{ hits, corpusProductCount }` shape (these are same-package tests, update them as part of GREEN). The three flag-off goldens MUST pass unchanged — if a golden moves, the `getShell`/build leaked out of the flag-on branch; fix the branch, never the golden.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(brain): render >1000-SKU stores from shell + retrieved corpus metadata (dark)"
```

---

## Task 4: Scale the index — 50k ceiling, deep index-fetch, pgvector precondition

**Files:**
- Modify: `packages/widget-backend/src/jobs/catalog-index.ts:121-129` (`MAX_INDEXED_PRODUCTS`, `VECTOR_SCAN_ROWS_MIRRORED` note)
- Modify: `packages/widget-backend/src/shopify-grounding.ts` (add `MAX_INDEX_CATALOG_PAGES`; `shopifyCatalogSource` uses a deep-page fetch)
- Modify: `packages/widget-backend/src/jobs/catalog-index.ts:865-875` (`shopifyCatalogSource` default fetch)
- Test: `packages/widget-backend/test/index-scale.test.ts` (create)
- Reconcile: `packages/widget-backend/test/catalog-index-job.test.ts` (the constant the old ceiling test reads)

**Interfaces:**
- Consumes: `MAX_CATALOG_PRODUCTS`, `STOREFRONT_PAGE_SIZE`, `storefrontFetch` (`shopify-grounding.ts`).
- Produces: `MAX_INDEXED_PRODUCTS = 50000` (index-side, decoupled from serving's `MAX_CATALOG_PRODUCTS = 1000`); `MAX_INDEX_CATALOG_PAGES = 200` (index-fetch page ceiling, separate from serving's `MAX_CATALOG_PAGES = 4`).

> **Spec-vs-code note:** `MAX_INDEXED_PRODUCTS` is today `= MAX_CATALOG_PRODUCTS` (an alias, `catalog-index.ts:121`), and `VECTOR_SCAN_ROWS_MIRRORED = 5000` (`:129`) with an invariant test asserting `MAX_INDEXED_PRODUCTS < 5000`. Raising the index ceiling to 50000 therefore (a) DECOUPLES it from serving's fetch ceiling and (b) supersedes the brute-force-scan invariant — which only applies to the non-`VECTOR_ANN` store. On the S1 pgvector (HNSW) path there is no 5000-row scan cap, so the coupling is retired, not merely bumped.

- [ ] **Step 1: Write the failing scale test**

```ts
// packages/widget-backend/test/index-scale.test.ts
import { describe, it, expect } from "vitest";
import { MAX_INDEXED_PRODUCTS } from "../src/jobs/catalog-index.js";
import { MAX_CATALOG_PRODUCTS, MAX_CATALOG_PAGES, MAX_INDEX_CATALOG_PAGES, STOREFRONT_PAGE_SIZE } from "../src/shopify-grounding.js";

describe("S2 index scale", () => {
  it("indexes up to 50000 products, decoupled from serving's 1000 fetch ceiling", () => {
    expect(MAX_INDEXED_PRODUCTS).toBe(50000);
    expect(MAX_CATALOG_PRODUCTS).toBe(1000); // serving's per-turn getContext ceiling is UNCHANGED
    expect(MAX_INDEXED_PRODUCTS).toBeGreaterThan(MAX_CATALOG_PRODUCTS);
  });
  it("the index-fetch can page the whole 50k, separate from serving's 4-page cap", () => {
    expect(MAX_CATALOG_PAGES).toBe(4); // serving per-turn: unchanged
    expect(MAX_INDEX_CATALOG_PAGES).toBe(MAX_INDEXED_PRODUCTS / STOREFRONT_PAGE_SIZE); // 200
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `env -u GOOGLE_CLOUD_PROJECT pnpm vitest run packages/widget-backend/test/index-scale.test.ts`
Expected: FAIL — `MAX_INDEXED_PRODUCTS` is 1000; `MAX_INDEX_CATALOG_PAGES` does not exist.

- [ ] **Step 3a: Decouple + raise the index ceiling**

`catalog-index.ts:121` — replace the alias:

```ts
/**
 * THE INDEX CEILING — the largest catalog this job will index. S2 raised it to the full ADR-0020 ~50k
 * design ceiling: batch embedding (Task 5) makes it tractable, and the serving path no longer renders the
 * whole catalog per turn (it retrieves top-K via getShell), so this is DECOUPLED from serving's own fetch
 * ceiling (`MAX_CATALOG_PRODUCTS`, still 1000). Crossing it HARD-FAILS the tenant rather than indexing a
 * part of it (the #180 truncation argument, unchanged).
 *
 * The brute-force `MAX_SCAN_ROWS` (5000) coupling no longer applies: serving a corpus this size requires
 * `VECTOR_ANN=true` (the S1 pgvector HNSW store), whose query does not do an id-ordered LIMIT scan. On the
 * legacy brute-force store a >5000 corpus WOULD silently truncate at query time — which is exactly why the
 * VECTOR_ANN precondition is documented (S2 spec §D-backend) and must be true before a >5000-SKU store is
 * served. This job does not read `VECTOR_ANN`; it only writes the corpus.
 */
export const MAX_INDEXED_PRODUCTS = 50000;
```

Update the `VECTOR_SCAN_ROWS_MIRRORED` doc comment (`:123-129`) to state the invariant now holds only for the non-`VECTOR_ANN` store, and that on pgvector the corpus may exceed it. Keep the constant (other call sites read it) but the "`MAX_INDEXED_PRODUCTS` must stay below it" clause is retired.

- [ ] **Step 3b: Deep index-fetch page ceiling**

`shopify-grounding.ts` — after `MAX_CATALOG_PAGES` (`:153`):

```ts
/**
 * The INDEX job's page ceiling — deep enough to page the whole `MAX_INDEXED_PRODUCTS` (50000 / 250 = 200
 * pages). SEPARATE from `MAX_CATALOG_PAGES` (serving's per-turn cap, still 4): the offline index job pays
 * ~200 sequential round-trips once, the /chat path never does. `getContext` keeps its 4-page cap so serving
 * can never page 50k per turn.
 */
export const MAX_INDEX_CATALOG_PAGES = 200;
```

- [ ] **Step 3c: Point the index source at the deep fetch**

`catalog-index.ts:865-875` — `shopifyCatalogSource`'s default `fetchImpl` currently is `storefrontFetch()` (4-page cap). Import `MAX_INDEX_CATALOG_PAGES` and change the default so the INDEX source pages deep, while `getContext` in `model.ts` keeps its own default 4-page fetch untouched:

```ts
export function shopifyCatalogSource(
  secrets: SecretsPort,
  fetchImpl: StorefrontFetch = storefrontFetch(globalThis.fetch, { maxPages: MAX_INDEX_CATALOG_PAGES }),
  domains: Record<string, string> = parseStoreDomains(),
): CatalogSource {
```

Add `MAX_INDEX_CATALOG_PAGES` to the `shopify-grounding.js` import at the top of `catalog-index.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `env -u GOOGLE_CLOUD_PROJECT pnpm vitest run packages/widget-backend/test/index-scale.test.ts`
Expected: PASS.

- [ ] **Step 5: Reconcile the old ceiling invariant test**

Run: `env -u GOOGLE_CLOUD_PROJECT pnpm vitest run packages/widget-backend/test/catalog-index-job.test.ts`
Expected: the assertion pinning `MAX_INDEXED_PRODUCTS === MAX_CATALOG_PRODUCTS` and/or `MAX_INDEXED_PRODUCTS < VECTOR_SCAN_ROWS_MIRRORED` now fails. Update those assertions to the S2 reality: `MAX_INDEXED_PRODUCTS === 50000`, decoupled from serving, and drop the brute-force-scan coupling (leave a comment pointing at the `VECTOR_ANN` precondition). Do NOT loosen the ceiling-exceeded / hard-fail behaviour tests — a catalog above 50000 must still refuse.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(catalog-index): raise index ceiling to 50k, decouple from serving; deep index-fetch"
```

---

## Task 5: Batch embeddings — timeout, retry/backoff, bounded concurrency + the 1536 pin

**Files:**
- Modify: `packages/model-vertex/src/vertex-adapter.ts` (`VertexEmbedConfig` + `embedBatch`)
- Modify: `packages/model-vertex/src/create.ts:140-163` (read the new envs)
- Modify: `.github/workflows/deploy-staging.yml` (pin `PALUP_EMBED_MODEL`/`PALUP_EMBED_DIMENSION`, dark — no `CATALOG_RETRIEVAL`)
- Test: `packages/model-vertex/test/vertex-embed-batch.test.ts` (create)

**Interfaces:**
- Consumes: `EmbedRequest`/`EmbedResponse` (`model-port.ts:84-121`), `requireEmbedAlignment`, `requireEmbedInputs`.
- Produces: `VertexEmbedConfig` gains `timeoutMs?`, `maxRetries?`, `concurrency?`; `embedBatch` runs chunks through a bounded-concurrency pool, each chunk wrapped in a per-request timeout + retry/backoff, preserving order and all-or-nothing.

> **Build-verify (world fact, re-confirm at build):** `gemini-embedding-2`'s exact model-id string + GA status on Vertex (docs show both a GA-style and a preview page as of 2026-08-15). Confirm with `pnpm model:smoke` / a fresh doc check before serving. **Fallback:** `gemini-embedding-001` @ 3072 (S1's `halfvec(3072)` path). The pin is CONFIG-ONLY (`PALUP_EMBED_MODEL` / `PALUP_EMBED_DIMENSION`, already read by `create.ts:124,144`); no adapter code decides it. `gemini-embedding-2` is not in the `EMBED_MAX_BATCH` table, so `maxBatchForEmbedModel` returns 1 — the SDK routes `gemini*`-non-001 through the single-content path ([E5]) and throws for >1, so 1 is correct; the concurrency below parallelises those single-text requests.

- [ ] **Step 1: Write the failing test**

```ts
// packages/model-vertex/test/vertex-embed-batch.test.ts
import { describe, it, expect } from "vitest";
import { VertexModelAdapter } from "../src/vertex-adapter.js";

/** A transport that fails the first N calls, then succeeds — to prove retry/backoff. Records concurrency. */
function flakyEmbedContent(failFirst: number) {
  let calls = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  return {
    calls: () => calls,
    maxInFlight: () => maxInFlight,
    fn: async (req: { contents: string[]; config?: { outputDimensionality?: number } }) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      calls++;
      const dim = req.config?.outputDimensionality ?? 3;
      try {
        if (calls <= failFirst) throw new Error("transient 503");
        await new Promise((r) => setTimeout(r, 5));
        return { embeddings: req.contents.map(() => ({ values: Array(dim).fill(0.1), statistics: { tokenCount: 3 } })) };
      } finally {
        inFlight--;
      }
    },
  };
}

function adapter(t: ReturnType<typeof flakyEmbedContent>, cfg: Partial<{ maxBatch: number; concurrency: number; maxRetries: number; timeoutMs: number; outputDimensionality: number }> = {}) {
  return new VertexModelAdapter(
    async () => ({ text: "x" }),
    { model: "gemini-3.5-flash" },
    {
      call: t.fn,
      cfg: {
        model: "gemini-embedding-2",
        taskTypes: { document: "RETRIEVAL_DOCUMENT", query: "RETRIEVAL_QUERY" },
        maxBatch: cfg.maxBatch ?? 1,
        outputDimensionality: cfg.outputDimensionality ?? 1536,
        concurrency: cfg.concurrency ?? 4,
        maxRetries: cfg.maxRetries ?? 3,
        timeoutMs: cfg.timeoutMs ?? 1000,
      },
    },
  );
}

describe("vertex embedBatch — timeout, retry, bounded concurrency", () => {
  it("retries a transient failure with backoff and still returns every vector in order", async () => {
    const t = flakyEmbedContent(2); // first 2 chunk-calls throw
    const res = await adapter(t).embed({ texts: ["a", "b", "c", "d"], purpose: "document", tenantId: "t1" });
    expect(res.vectors.length).toBe(4);
    expect(res.dimension).toBe(1536);
    expect(res.model).toBe("gemini-embedding-2");
  });

  it("runs at most `concurrency` requests in flight", async () => {
    const t = flakyEmbedContent(0);
    await adapter(t, { concurrency: 2 }).embed({ texts: ["a", "b", "c", "d", "e", "f"], purpose: "document", tenantId: "t1" });
    expect(t.maxInFlight()).toBeLessThanOrEqual(2);
  });

  it("gives up after maxRetries and rejects the whole batch (all-or-nothing)", async () => {
    const t = flakyEmbedContent(99);
    await expect(adapter(t, { maxRetries: 2 }).embed({ texts: ["a"], purpose: "document", tenantId: "t1" })).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `env -u GOOGLE_CLOUD_PROJECT pnpm vitest run packages/model-vertex/test/vertex-embed-batch.test.ts`
Expected: FAIL — `VertexEmbedConfig` has no `concurrency`/`maxRetries`/`timeoutMs`; the serial loop has no retry (the flaky transport's first failures throw straight out).

- [ ] **Step 3a: Config fields**

`vertex-adapter.ts` — add to `VertexEmbedConfig`:

```ts
  /** Per-provider-request timeout (ms). Undefined ⇒ no timeout (the pre-S2 behaviour). */
  timeoutMs?: number;
  /** Max retries per chunk on a transient failure/timeout. Undefined/0 ⇒ no retry. */
  maxRetries?: number;
  /** Max provider requests in flight at once. Undefined ⇒ 1 (sequential, the pre-S2 behaviour). */
  concurrency?: number;
```

- [ ] **Step 3b: Rewrite `embedBatch` as a bounded pool with timeout + retry**

`vertex-adapter.ts:337-446` — keep every validation (`requireEmbedInputs`, task-type resolution, truncation/dimension/short-batch checks, `requireEmbedAlignment`); replace the sequential `for` loop with an indexed chunk list processed by a bounded worker pool, each chunk request wrapped in timeout + retry/backoff, results placed by chunk index so ORDER is preserved. Sketch (fill the existing per-embedding validation into `validateChunk`):

```ts
  private async embedBatch(embedding: VertexEmbedding, req: EmbedRequest): Promise<EmbedResponse> {
    const { call, cfg } = embedding;
    requireEmbedInputs(req);
    if (!Object.hasOwn(cfg.taskTypes, req.purpose))
      throw new Error(`vertex: no task type configured for embed purpose ${JSON.stringify(req.purpose)}`);
    const taskType = cfg.taskTypes[req.purpose];
    if (!taskType) throw new Error(`vertex: the task type configured for embed purpose ${JSON.stringify(req.purpose)} is blank`);

    const chunkSize = Math.max(1, Math.floor(cfg.maxBatch));
    const concurrency = Math.max(1, Math.floor(cfg.concurrency ?? 1));
    const maxRetries = Math.max(0, Math.floor(cfg.maxRetries ?? 0));

    // Split into ordered chunks; each produces a { vectors, tokens } slice validated in place.
    const chunks: { offset: number; texts: string[] }[] = [];
    for (let o = 0; o < req.texts.length; o += chunkSize) chunks.push({ offset: o, texts: req.texts.slice(o, o + chunkSize) });

    const perChunk: { values: number[][]; tokens: number | undefined }[] = new Array(chunks.length);

    const withTimeout = async <T>(p: Promise<T>): Promise<T> => {
      if (cfg.timeoutMs === undefined) return p;
      return await Promise.race([
        p,
        new Promise<T>((_r, rej) => setTimeout(() => rej(new Error("vertex: embed request timed out")), cfg.timeoutMs)),
      ]);
    };

    const runChunk = async (ci: number): Promise<void> => {
      const { offset, texts } = chunks[ci]!;
      let lastErr: unknown;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          const res = await withTimeout(call({
            model: cfg.model,
            contents: texts,
            config: { taskType, autoTruncate: cfg.autoTruncate ?? false, ...(cfg.outputDimensionality === undefined ? {} : { outputDimensionality: cfg.outputDimensionality }) },
          }));
          perChunk[ci] = this.validateChunk(offset, texts, res, cfg.outputDimensionality); // throws on any anomaly
          return;
        } catch (e) {
          lastErr = e;
          if (attempt < maxRetries) await new Promise((r) => setTimeout(r, Math.min(2000, 100 * 2 ** attempt))); // backoff
        }
      }
      throw lastErr;
    };

    // Bounded pool: at most `concurrency` chunks in flight. First rejection fails the whole batch.
    let next = 0;
    const worker = async (): Promise<void> => { while (next < chunks.length) { const ci = next++; await runChunk(ci); } };
    await Promise.all(Array.from({ length: Math.min(concurrency, chunks.length) }, () => worker()));

    // Reassemble in order + enforce single dimension across chunks.
    const vectors: number[][] = [];
    let dimension = 0;
    let inputTokens = 0;
    let tokensKnown = true;
    for (const c of perChunk) {
      for (const v of c.values) {
        if (dimension === 0) dimension = v.length;
        else if (v.length !== dimension) throw new Error(`vertex: mixed dimensions across chunks (${v.length} vs ${dimension})`);
        vectors.push(v);
      }
      if (c.tokens === undefined) tokensKnown = false; else inputTokens += c.tokens;
    }

    const out: EmbedResponse = { vectors, dimension, model: cfg.model, purpose: req.purpose, ...(tokensKnown ? { usage: { inputTokens } } : {}) };
    requireEmbedAlignment(req, out);
    return out;
  }
```

Extract the existing per-embedding checks (`statistics.truncated`, empty `values`, `outputDimensionality` mismatch, token accumulation) into a private `validateChunk(offset, texts, res, outDim)` that returns `{ values, tokens }` — reuse the EXACT existing error messages so nothing regresses. Update the method's doc comment: the "NO TIMEOUT, deliberately" paragraph (`:331`) and the "Sequential, not parallel" comment (`:358`) are now stale — replace them with the S2 rationale (timeout + retry + bounded concurrency for the 50k index; still all-or-nothing at the port).

- [ ] **Step 3c: `create.ts` reads the envs**

`create.ts:140-163` — thread three envs (reusing `positiveIntEnv`) into the `cfg`:

```ts
  const embedTimeoutMs = positiveIntEnv(process.env.PALUP_EMBED_TIMEOUT_MS) ?? 20000;
  const embedMaxRetries = positiveIntEnv(process.env.PALUP_EMBED_MAX_RETRIES) ?? 3;
  const embedConcurrency = positiveIntEnv(process.env.PALUP_EMBED_CONCURRENCY) ?? 4;
  // ...
      cfg: {
        model: embedModel,
        taskTypes: embedTaskTypes,
        maxBatch: embedMaxBatch,
        timeoutMs: embedTimeoutMs,
        maxRetries: embedMaxRetries,
        concurrency: embedConcurrency,
        ...(embedDimension === undefined ? {} : { outputDimensionality: embedDimension }),
      },
```

- [ ] **Step 3d: Pin the manifest model/dimension (dark) in deploy config**

`.github/workflows/deploy-staging.yml` — add `PALUP_EMBED_MODEL: gemini-embedding-2` and `PALUP_EMBED_DIMENSION: "1536"` to the index/deploy env (NOT `CATALOG_RETRIEVAL`, NOT `VECTOR_ANN`). Add an inline comment: re-confirm `gemini-embedding-2` GA + the exact model-id at build; fallback `gemini-embedding-001`@3072. This only changes what a future `pnpm catalog:index` pins; it serves no shopper (retrieval flag stays off).

- [ ] **Step 4: Run test to verify it passes**

Run: `env -u GOOGLE_CLOUD_PROJECT pnpm vitest run packages/model-vertex/test/vertex-embed-batch.test.ts`
Expected: PASS.

- [ ] **Step 5: Regression — the existing embed suites**

Run: `env -u GOOGLE_CLOUD_PROJECT pnpm vitest run packages/model-vertex/test/vertex-embed.test.ts packages/model-vertex/test/vertex-embed-purpose.test.ts packages/model-vertex/test/vertex-adapter.test.ts`
Expected: PASS (default config = sequential, no timeout, no retry ⇒ behaviour unchanged for the existing tests).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(model-vertex): batch embed with timeout/retry/bounded concurrency; pin 1536 (dark)"
```

---

## Task 6: Headline E2E — a >1000-product store renders top-K in /chat, no full fetch, no ceiling throw

**Files:**
- Test: `packages/widget-backend/test/serving-unlock-e2e.test.ts` (create)

**Interfaces:**
- Consumes: everything above — `runCatalogIndex` (Task 1 metadata), `createCatalogRetriever` (Task 3 result), `createBrain` with `catalogRetrievalEnabled` + `getShell` grounding (Tasks 2–3), `ProductFactsPort` hydrate (existing A1b), the in-memory `VectorPort` + a fake embed model.
- Produces: the S2 acceptance proof.

- [ ] **Step 1: Write the failing E2E test**

```ts
// packages/widget-backend/test/serving-unlock-e2e.test.ts
import { describe, it, expect } from "vitest";
import {
  createInMemoryVectorStore, InMemoryRuntimeStore, createInMemoryProductFactsStore,
  type GroundingContext, type GroundingPort, type ModelPort, type ProductFactsPort,
} from "@palup/platform-ports";
import { createBrain, DEFAULT_POLICY } from "@palup/widget-brain";
import type { Signals } from "@palup/widget-brain";
import { runCatalogIndex } from "../src/jobs/catalog-index.js";
import { createCatalogRetriever } from "../src/catalog-retriever.js";

const DIM = 1536;
/** Deterministic fake embedder: bucket a text onto one of DIM axes by a cheap keyword hash, so a query
 *  and the docs sharing its keyword land on the same axis and rank highest under cosine. Model+dim match
 *  the S2 pin so the corpus pin check passes. */
function fakeEmbed(): ModelPort {
  const axis = (t: string) => {
    const kw = (t.toLowerCase().match(/serum|cleanser|cream|spf|mask/) ?? ["misc"])[0];
    let h = 0; for (const c of kw) h = (h * 31 + c.charCodeAt(0)) % DIM;
    const v = Array(DIM).fill(0); v[h] = 1; return v;
  };
  return {
    async complete() { throw new Error("embedder has no complete"); },
    async embed(req) { return { vectors: req.texts.map(axis), dimension: DIM, model: "gemini-embedding-2", purpose: req.purpose }; },
  };
}

/** >1000 fake products; getContext THROWS a ceiling (proving it is never called on the render path). */
function bigCatalog(n: number) {
  const cats = ["serum", "cleanser", "cream", "spf", "mask"];
  const products = Array.from({ length: n }, (_, i) => ({
    id: `p${i}`, title: `${cats[i % cats.length]} #${i}`, description: `desc ${i}`,
    price: `$${10 + (i % 40)}`, variantId: `v${i}`, tags: [cats[i % cats.length]],
  }));
  return products;
}

describe("S2 headline E2E — >1000-SKU store renders top-K in /chat", () => {
  it("renders retrieved products (metadata + fresh ProductFacts price) with no full-catalog fetch and no ceiling throw", async () => {
    const vector = createInMemoryVectorStore();
    const store = new InMemoryRuntimeStore();
    const facts = createInMemoryProductFactsStore();
    const products = bigCatalog(1500);

    // 1) INDEX the >1000 corpus (index path, deep, mock embed — no real Vertex).
    const catalog = async (): Promise<GroundingContext> => ({ tenantId: "big", brandName: "MegaSkin", policy: { returns: "30d", shipping: "free" }, products });
    const [report] = await runCatalogIndex({ store, vector, model: fakeEmbed(), catalog }, ["big"]);
    expect(report.outcome).toBe("indexed");
    expect(report.written).toBe(1500);

    // 2) fresh ProductFacts price for a couple of serum SKUs.
    await facts.upsertMany("big", [
      { productId: "p0", price: "$99", availableForSale: true, updatedAt: new Date().toISOString() },
    ]);

    // 3) grounding whose getContext throws (never called), getShell returns brand+policy.
    const grounding: GroundingPort = {
      async getContext() { throw new Error("CEILING: whole-catalog fetch must not happen on the render path"); },
      async getShell(tenantId) { return { tenantId, brandName: "MegaSkin", policy: { returns: "30d", shipping: "free" } }; },
    };

    // 4) brain, retrieval + hydration ON, real retriever over the in-memory corpus.
    let system = "";
    const model: ModelPort = {
      async complete(req) { system = req.messages.find((m) => m.role === "system")?.content ?? ""; return { text: "Two great serums:", model: "mock" }; },
      async embed() { throw new Error("brain does not embed"); },
    };
    const retriever = createCatalogRetriever({ store, vector, model: fakeEmbed() });
    const brain = createBrain(
      model, grounding, DEFAULT_POLICY, undefined, "shopper-demo",
      undefined, false, false, false, false,
      retriever, true, 12,
      false, false, false, false,
      facts as ProductFactsPort, true,
    );

    const signals: Signals = { tenantId: "big" };
    const decision = await brain.decide(signals, "show me a serum");

    expect(decision.flags).toContain("retrieval:applied");   // retrieval happened
    expect(decision.reply.length).toBeGreaterThan(0);        // a real reply, no ceiling throw
    expect(system).toContain("CATALOG (");                    // a narrowed block, not the whole catalog
    expect(system).toMatch(/serum #\d+/);                     // serum SKUs rendered from corpus metadata
    expect(system).toContain("$99");                          // fresh ProductFacts price overlaid (p0)
    expect(system).toContain("of 1500 products");             // "N of M" from the manifest count
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `env -u GOOGLE_CLOUD_PROJECT pnpm vitest run packages/widget-backend/test/serving-unlock-e2e.test.ts`
Expected: FAIL first while Tasks 1–3 are incomplete; once they are in, it should PASS. (If run before Task 3, it fails on the return-shape mismatch / `getContext` throw.)

- [ ] **Step 3: No new implementation**

This task adds no code — it composes Tasks 1–5. If it fails after those, debug via `superpowers:systematic-debugging`, fix the responsible task's code (not the test), and re-run.

- [ ] **Step 4: Run test to verify it passes**

Run: `env -u GOOGLE_CLOUD_PROJECT pnpm vitest run packages/widget-backend/test/serving-unlock-e2e.test.ts`
Expected: PASS.

- [ ] **Step 5 (optional): pgvector variant**

If Docker is available, add a second `it` that wraps the same flow in `withPgvector` (from `packages/state-postgres/test/helpers/pgvector-container.ts`), building the vector store over the container `sql` (S1's `createVectorStore(sql)`), to exercise the real HNSW path. Run without `PGVECTOR_TESTCONTAINER=off`.

- [ ] **Step 6: Commit**

```bash
git add packages/widget-backend/test/serving-unlock-e2e.test.ts
git commit -m "test(e2e): >1000-SKU store renders top-K in /chat with no full-catalog fetch"
```

---

## Task 7: Reconcile stale docs/comments + record the VECTOR_ANN precondition

**Files:**
- Modify: `packages/widget-brain/src/brain.ts:636-664` (`DEFAULT_CATALOG_RETRIEVAL_K` doc — the "1000"/"MAX_INDEXED_PRODUCTS 1000"/"5000-row scan" reasoning)
- Modify: `packages/widget-backend/src/jobs/catalog-index.ts` header + `MANIFEST`/ceiling comments (the "nothing reads this corpus" / "1000" lines)
- Modify: `docs/superpowers/specs/2026-08-15-s2-serving-unlock-design.md` (Status → implemented-dark; add the `VECTOR_ANN`-for->5000 precondition callout if not already prominent)
- Modify: `packages/widget-backend/src/catalog-retriever.ts` header (the "returns PRODUCT IDS … never returns text" note now also returns render metadata + corpus count)

**Interfaces:** none (comments/docs only). Leave already-correct docs untouched (no cosmetic rewrites).

- [ ] **Step 1: Reconcile the load-bearing comments**

Edit only the comments made factually wrong by Tasks 1–5:
- `DEFAULT_CATALOG_RETRIEVAL_K` (`brain.ts:636-664`): its argument cites "MAX_INDEXED_PRODUCTS (1000)" and "the whole corpus is always scanned … truncation never engages". Update to: the index ceiling is now 50000; serving a >5000-SKU corpus requires `VECTOR_ANN=true` (pgvector HNSW), and the brute-force scan truncation the old text relied on is exactly what `VECTOR_ANN` avoids.
- `catalog-retriever.ts` header: note it now also returns each hit's render `metadata` (title/variantId) and the corpus size, still NO price/description-as-truth (those come from the live `ProductFactsPort` overlay).
- `catalog-index.ts`: the `MAX_INDEXED_PRODUCTS` block was updated in Task 4; ensure the file header's "NOTHING READS THIS CORPUS … 1000" phrasing is consistent (retrieval still off by default — do not claim it is on).
- S2 spec: flip Status to "implemented behind `catalogRetrievalEnabled` (dark), <date>"; make the `VECTOR_ANN=true` precondition for >5000 SKUs a visible line.

- [ ] **Step 2: Full suite — nothing regressed**

Run: `env -u GOOGLE_CLOUD_PROJECT PGVECTOR_TESTCONTAINER=off pnpm test`
Expected: PASS (comments/docs are inert). Then run the flag-off goldens once more explicitly:
`env -u GOOGLE_CLOUD_PROJECT pnpm vitest run packages/widget-brain/test/retrieval-flag-off.test.ts packages/widget-brain/test/cards-cart-flag-off.test.ts packages/widget-brain/test/citations-flag-off.test.ts`
Expected: byte-identical PASS.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "docs(catalog-retrieval): reconcile S2 comments + record VECTOR_ANN>5000 precondition"
```

---

## Self-Review

**1. Spec coverage** (S2 design §3–§6 + the settled decisions):
- §3.1 Producer metadata (title/variantId), embed text unchanged, delisted pruned → **Task 1**.
- §3.2 `GroundingShell` + `getShell` on the port + Shopify adapter (brand/policy only, no pagination) + all implementers → **Task 2**.
- §3.3 Serving rewire: `getShell` not `getContext`, always-retrieve (no size branch), build `Product` from metadata, reuse A1b hydrate, "N of M" from manifest, fail-open no-catalog-block, flag-off byte-identical → **Task 3**.
- §3.4 Scale: `MAX_INDEXED_PRODUCTS`→50000 decoupled, deep index-fetch pages separate from serving's 4 → **Task 4**.
- §3.5/§2 D-embed batch: timeout+retry/backoff+bounded concurrency; 1536 pin via env → **Task 5**.
- §4 Testing: producer metadata (T1), getShell no-pagination (T2), headline render (T6), flag-off golden (T3 step 5), delisted guard (T1 step 1) → covered.
- §D-backend / §6 VECTOR_ANN>5000 precondition documented → **Task 4 + 7**.
- Governance: no flag flipped anywhere (grep step below).

**2. Placeholder scan:** no "TBD"/"add error handling"/"similar to Task N". Task 5's `validateChunk` explicitly says "reuse the EXACT existing error messages" and points at the source lines rather than hand-waving. Task 6 is composition-only by design (stated). Every code step has real code.

**3. Type consistency:** `GroundingShell { tenantId; brandName; policy }` is produced in Task 2 and consumed identically in Task 3's `retrieveViaShell`. `CatalogRetrievalResult { hits: RetrievedProduct[]; corpusProductCount }` is defined in Task 3 (types.ts), returned by `catalog-retriever.ts` (Task 3e), and destructured as `{ hits, corpusProductCount }` in the retriever + `{ ctx, rendered, corpusTotal }` in the brain — the brain maps `corpusProductCount`→`corpusTotal` at the one call boundary (consistent, renamed once, on purpose). `RetrievedProduct.metadata?` is written by the retriever and read by `retrieveViaShell` (`md.title`/`md.variantId`). `systemPrompt`'s new 5th param `corpusTotal?` matches its single call site. Constants: `MAX_INDEXED_PRODUCTS` (50000), `MAX_INDEX_CATALOG_PAGES` (200 = 50000/250), `MAX_CATALOG_PRODUCTS` (1000, unchanged), `MAX_CATALOG_PAGES` (4, unchanged) — all consistent across Tasks 4 and 6.

**Governance grep (run before the final commit):** `git grep -nE "CATALOG_RETRIEVAL\s*=\s*true|VECTOR_ANN\s*=\s*true|PRODUCT_FACTS_HYDRATION\s*=\s*true"` over the diff must return nothing outside tests (tests pass the flag as a constructor arg, never an env). The `deploy-staging.yml` change (Task 5) must add only `PALUP_EMBED_*`, never a posture flag.
