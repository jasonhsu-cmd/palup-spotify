# S3 — Freshness at Scale Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep a >1000-SKU (up to 50k) `CATALOG_RETRIEVAL` corpus fresh at scale — an ANN-safe reconcile driven by a per-tenant id→contentHash ledger, targeted by-id refresh from webhooks, per-tenant coalesce/debounce, a ≤15-min fail-honest serve-time staleness ceiling, and a deployed hourly scheduled backstop — without full-catalog crawls per change and without the ANN-unsafe `vector.query({text:""})` enumerate S2 surfaced.

**Architecture:** The authoritative record of "what is indexed and at what content hash" moves out of the vector store (which exposes no `listIds`/enumerate and *throws* on a text query on the S1 pgvector engine) and into a chunked RuntimeState KV ledger, written in the *same transaction* as the corpus manifest + audit. Reconcile diffs that ledger against the live catalog. Webhooks carry changed product id(s) so only those SKUs are re-fetched/embedded/upserted; bursts coalesce per tenant. Serving keeps a hard 15-min staleness ceiling so a stale price is never quoted. An hourly Cloud Run Job is the missed-event backstop. Everything ships dark.

**Tech Stack:** TypeScript, Node, Fastify, Vitest, `@palup/platform-ports` (VectorPort, RuntimeStatePort, ProductFactsPort, ModelPort), `@palup/state-postgres` (`PgVectorStore`, `PostgresProductFactsStore`), Shopify Storefront GraphQL, Cloud Run Jobs + Cloud Scheduler, testcontainers (real pgvector).

**Spec:** `docs/superpowers/specs/2026-08-16-s3-freshness-at-scale-design.md` (the authority — read it fully first; this plan argues from it).

## Global Constraints

Every task's requirements implicitly include this section. Copied verbatim from the spec (§ D-S3, §F, §G) and the operating manual:

- **Test-first (ATDD).** Write the failing test, watch it fail, then implement to green. Every acceptance criterion is covered by a test before implementation.
- **`env -u GOOGLE_CLOUD_PROJECT` on every test command.** Setting `GOOGLE_CLOUD_PROJECT` routes backend integration tests to real Vertex → 5000ms timeouts that look like a regression. Never set it for `pnpm test` / `pnpm eval` / the merge gate.
- **Mock + pgvector-testcontainer paths only. NO real Vertex.** Use the deterministic fake embedder (char-code buckets, calls the real `requireEmbedInputs`/`requireEmbedAlignment` validators). No credentials, no network in tests.
- **Ships dark. Do NOT flip `CATALOG_RETRIEVAL`, `VECTOR_ANN`, `MEMORY_ADR_ACCEPTED`, or `PRODUCT_FACTS_HYDRATION`.** No S3 code sets a governance/serving flag. Enabling serving stays a HITL-POLICY §5 named-owner promotion.
- **The seven merge-gate steps are unchanged** (Typecheck; Unit + port-contract tests; eval gate; Application E2E; Control-plane E2E; Embed round-trip E2E; pgvector ANN adapter (testcontainer)). You MAY add test files to the `test:pgvector` npm script's file list — the *step name* stays the same; the spec explicitly says "the pgvector step now also covers the ANN-safe reconcile."
- **No VectorPort interface change.** Do not add `listIds`/`count`/`enumerate` — the ledger is the whole point. VectorPort stays the 4 methods (`upsert`/`query`/`deleteById`/`deleteNamespace`).
- **Portability (ADR-0001 / NN#3).** No vendor SQL or provider SDK in feature code — all cloud access through the ports. No Shopify type crosses a port.
- **Secrets never printed.** The Storefront token stays on the SecretsPort→header path; error strings are class-only, PII/credential-free (the `runCatalogIndex` rule).
- **Governance.** This work is **human-merged by jason** (deploy infra + embedding spend + it touches the freshness/money surface); the `gcloud` applies are his. **#295 stays blocked** (needs S4's per-tenant flag + retrieval-scoped kill).
- **OUT OF SCOPE (S4, do not build):** per-tenant `CATALOG_RETRIEVAL` enablement; retrieval-scoped kill; `eval:`/`shadow:` at scale; the precise `inventory_item_id → productId` map; tenant-list-from-registry (the `SHOPIFY_STORES` blind-spot).

---

## Pre-flight conflict note (shared files — read before parallelizing)

Several tasks edit the same files. Execute in numeric order; if you parallelize, these are the seams:

| File | Tasks that touch it | Seam |
|---|---|---|
| `packages/widget-backend/src/jobs/catalog-index.ts` | **1** (edit `runCatalogClear`, import ledger module), **2** (rewrite `indexOneTenant` + `writeManifestAndAudit`), **5** (add `reconcileProducts`, `CatalogByIdSource`, extend `CatalogIndexDeps`) | Task 2 rewrites the middle of `indexOneTenant` (lines ~494–752) and the `writeManifestAndAudit` signature. Task 1 only touches `runCatalogClear` (~836–868) and the import block. Task 5 only *adds* new exports at the end + one field to `CatalogIndexDeps`. Land 1 → 2 → 5. |
| `packages/widget-backend/src/catalog-webhook-queue.ts` | **3** (extend `catalogReconcileMessage` payload + `ReconcileReason`), **6** (extend `subscribeCatalogReconcile` to route through the coalescer) | Task 3 changes the message shape + subscribe callback signature; Task 6 wraps the reconcile fn. Land 3 → 6. |
| `packages/widget-backend/src/routes/shopify-webhooks.ts` | **3** (id-extraction in `handleCatalogChange`) | Single task; no conflict. |
| `packages/widget-backend/src/shopify-grounding.ts` | **4** (add `storefrontFetchByIds` + `shopifyCatalogByIdSource`) | Additive only. |
| `packages/widget-backend/src/server.ts` | **5** (wire `catalogById` + targeted reconcile), **6** (wire coalescer), **7** (change `PRODUCT_FACTS_MAX_AGE_MS` default) | Task 5 edits the reconcile-worker block (~1056–1124); Task 6 edits the same block to insert the coalescer; Task 7 edits one line at ~600. Land 5 → 6; 7 is independent. |
| `packages/widget-backend/src/shopify-webhook-identity.ts` | **3** (add `productIdOf`) | Additive only. |

---

## Task 1: Corpus-state ledger (read/write/erase) in RuntimeState KV

**Files:**
- Create: `packages/widget-backend/src/jobs/catalog-ledger.ts`
- Modify: `packages/widget-backend/src/jobs/catalog-index.ts` (import the ledger module; extend `runCatalogClear` to drop ledger chunks — `~836-868`)
- Test: `packages/widget-backend/test/catalog-ledger.test.ts`

**Interfaces:**
- Consumes: `RuntimeStatePort`, `RuntimeStateTx`, `MANIFEST_COLLECTION` (`"catalog_index"`), `MANIFEST_KEY` (`"manifest"`) from `catalog-index.ts`; `catalogRecordId(productId)` → `"product:<id>"`.
- Produces (used by Tasks 2 & 5):
  - `LEDGER_KEY_PREFIX = "ledger:"`, `LEDGER_CHUNK_SIZE = 10_000`
  - `interface CorpusLedgerChunk { version: 1; at: string; entries: Record<string, string> }` (entries: `recordId` → `contentHash`)
  - `ledgerChunkKey(index: number): string` → `"ledger:0000"` (4-digit zero-pad)
  - `readCorpusLedger(store: RuntimeStatePort, tenantId: string): Promise<Map<string, string>>` (asserts every id starts with `"product:"`)
  - `listLedgerChunkKeys(store: RuntimeStatePort, tenantId: string): Promise<string[]>`
  - `chunkLedgerEntries(entries: Map<string, string>, at: string, chunkSize?: number): CorpusLedgerChunk[]`
  - `writeLedgerInTx(t: RuntimeStateTx, chunks: CorpusLedgerChunk[], priorChunkKeys: string[]): Promise<void>`
  - `deleteLedgerInTx(t: RuntimeStateTx, priorChunkKeys: string[]): Promise<void>`

- [ ] **Step 1: Write the failing test** — `packages/widget-backend/test/catalog-ledger.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { InMemoryRuntimeStore } from "@palup/platform-ports";
import {
  LEDGER_CHUNK_SIZE,
  ledgerChunkKey,
  readCorpusLedger,
  listLedgerChunkKeys,
  chunkLedgerEntries,
  writeLedgerInTx,
  deleteLedgerInTx,
  type CorpusLedgerChunk,
} from "../src/jobs/catalog-ledger.js";
import { MANIFEST_COLLECTION, MANIFEST_KEY } from "../src/jobs/catalog-index.js";

const AT = "2026-08-16T00:00:00.000Z";

function ledgerOf(n: number): Map<string, string> {
  const m = new Map<string, string>();
  for (let i = 0; i < n; i++) m.set(`product:gid://shopify/Product/${i}`, `hash-${i}`);
  return m;
}

describe("corpus-state ledger — chunked KV round-trip in the catalog_index collection", () => {
  it("chunkLedgerEntries splits at the chunk size, deterministically (sorted ids)", () => {
    const chunks = chunkLedgerEntries(ledgerOf(LEDGER_CHUNK_SIZE + 5), AT);
    expect(chunks).toHaveLength(2);
    expect(Object.keys(chunks[0]!.entries)).toHaveLength(LEDGER_CHUNK_SIZE);
    expect(Object.keys(chunks[1]!.entries)).toHaveLength(5);
    expect(chunks[0]!.version).toBe(1);
    expect(chunks[0]!.at).toBe(AT);
  });

  it("writes chunks and reads them back merged into one map (>chunk-size)", async () => {
    const store = new InMemoryRuntimeStore();
    const entries = ledgerOf(LEDGER_CHUNK_SIZE + 3);
    await store.tx({ tenantId: "acme" }, async (t) => {
      await writeLedgerInTx(t, chunkLedgerEntries(entries, AT), []);
    });
    const read = await readCorpusLedger(store, "acme");
    expect(read.size).toBe(entries.size);
    expect(read.get("product:gid://shopify/Product/0")).toBe("hash-0");
    expect(read.get(`product:gid://shopify/Product/${LEDGER_CHUNK_SIZE + 2}`)).toBe(`hash-${LEDGER_CHUNK_SIZE + 2}`);
  });

  it("a rewrite that SHRINKS prunes the now-unused chunk keys", async () => {
    const store = new InMemoryRuntimeStore();
    await store.tx({ tenantId: "acme" }, async (t) => {
      await writeLedgerInTx(t, chunkLedgerEntries(ledgerOf(LEDGER_CHUNK_SIZE + 3), AT), []);
    });
    expect(await listLedgerChunkKeys(store, "acme")).toEqual([ledgerChunkKey(0), ledgerChunkKey(1)]);
    const priorKeys = await listLedgerChunkKeys(store, "acme");
    await store.tx({ tenantId: "acme" }, async (t) => {
      await writeLedgerInTx(t, chunkLedgerEntries(ledgerOf(2), AT), priorKeys);
    });
    expect(await listLedgerChunkKeys(store, "acme")).toEqual([ledgerChunkKey(0)]);
    expect((await readCorpusLedger(store, "acme")).size).toBe(2);
  });

  it("readCorpusLedger ignores the manifest key and refuses a non-product id (foreign-guard intrinsic)", async () => {
    const store = new InMemoryRuntimeStore();
    await store.put({ tenantId: "acme" }, MANIFEST_COLLECTION, MANIFEST_KEY, { model: "m", dimension: 4 });
    await store.put({ tenantId: "acme" }, MANIFEST_COLLECTION, ledgerChunkKey(0), {
      version: 1,
      at: AT,
      entries: { "subject:leak": "x" },
    } satisfies CorpusLedgerChunk);
    await expect(readCorpusLedger(store, "acme")).rejects.toThrow(/non-product id/);
  });

  it("deleteLedgerInTx removes exactly the given chunk keys", async () => {
    const store = new InMemoryRuntimeStore();
    await store.tx({ tenantId: "acme" }, async (t) => {
      await writeLedgerInTx(t, chunkLedgerEntries(ledgerOf(3), AT), []);
    });
    const keys = await listLedgerChunkKeys(store, "acme");
    await store.tx({ tenantId: "acme" }, async (t) => {
      await deleteLedgerInTx(t, keys);
    });
    expect(await listLedgerChunkKeys(store, "acme")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `env -u GOOGLE_CLOUD_PROJECT pnpm exec vitest run packages/widget-backend/test/catalog-ledger.test.ts`
Expected: FAIL — `Cannot find module '../src/jobs/catalog-ledger.js'`.

- [ ] **Step 3: Create the ledger module** — `packages/widget-backend/src/jobs/catalog-ledger.ts`

```ts
import type { RuntimeStatePort, RuntimeStateTx } from "@palup/platform-ports";
import { MANIFEST_COLLECTION } from "./catalog-index.js";

// S3 §B — the AUTHORITATIVE per-tenant id→contentHash ledger for a catalog corpus, in RuntimeState KV.
//
// WHY KV AND NOT THE VECTOR STORE. VectorPort deliberately exposes no listIds/count/enumerate
// (vector-port.ts) — adding one is non-portable (MEMORY-GO-LIVE-CHECKLIST). And the S1 pgvector engine
// THROWS on a text-modality "list everything" query (pgvector-store.ts: vector-query-only). So the set of
// indexed record ids and their content hashes lives HERE, in the same `catalog_index` collection as the
// manifest, and is written in the SAME `store.tx` as the manifest + audit so all three commit atomically.
//
// SHAPE. One or more chunk records keyed `ledger:<NNNN>`, each `{ version, at, entries }` where `entries`
// maps a corpus record id (`product:<gid>`) to its embedded-text contentHash. A 50k id+hash map is a few
// MB; chunking at LEDGER_CHUNK_SIZE keeps each KV value well under any value-size limit.

/** Chunk-key prefix within MANIFEST_COLLECTION. Distinct from MANIFEST_KEY ("manifest"). */
export const LEDGER_KEY_PREFIX = "ledger:";

/** Ids+hashes per chunk record. 10k * (~40-char id + 64-char hash) ≈ ~1MB/chunk — safe headroom. */
export const LEDGER_CHUNK_SIZE = 10_000;

/** One persisted ledger chunk. `version` lets a future migration recognise an old shape. */
export interface CorpusLedgerChunk {
  version: 1;
  at: string;
  /** recordId (`product:<gid>`) → contentHash. */
  entries: Record<string, string>;
}

/** Deterministic chunk key: `ledger:0000`, `ledger:0001`, … (zero-padded so lexical order == numeric). */
export function ledgerChunkKey(index: number): string {
  return `${LEDGER_KEY_PREFIX}${String(index).padStart(4, "0")}`;
}

/** All chunk keys currently persisted for this tenant, oldest-index first. */
export async function listLedgerChunkKeys(store: RuntimeStatePort, tenantId: string): Promise<string[]> {
  const rows = await store.list<CorpusLedgerChunk>({ tenantId }, MANIFEST_COLLECTION);
  return rows
    .map((r) => r.key)
    .filter((k) => k.startsWith(LEDGER_KEY_PREFIX))
    .sort();
}

/**
 * Read the whole ledger, merged into one `recordId → contentHash` map. Never touches the vector store.
 * FOREIGN-GUARD IS INTRINSIC: the ledger only ever holds `product:*` ids this job wrote, so it asserts
 * that here — a non-product id in the ledger is corruption, not a delisted product, and reconcile must
 * refuse it rather than ever `deleteById` something it did not write (the `:542-549` guard, preserved).
 */
export async function readCorpusLedger(store: RuntimeStatePort, tenantId: string): Promise<Map<string, string>> {
  const rows = await store.list<CorpusLedgerChunk>({ tenantId }, MANIFEST_COLLECTION);
  const out = new Map<string, string>();
  for (const { key, value } of rows) {
    if (!key.startsWith(LEDGER_KEY_PREFIX)) continue; // skip the manifest key
    for (const [id, hash] of Object.entries(value?.entries ?? {})) {
      if (!id.startsWith("product:")) {
        throw new Error(
          `corpus ledger for ${tenantId} contains a non-product id ${id} — refusing to reconcile a ledger ` +
            "it does not own (it must only ever hold product: ids this job wrote)",
        );
      }
      out.set(id, hash);
    }
  }
  return out;
}

/** Split a `recordId → contentHash` map into persisted chunks. Ids are SORTED so the chunking is stable
 *  across runs (a given id lands in the same chunk unless the corpus size crosses a boundary). */
export function chunkLedgerEntries(
  entries: Map<string, string>,
  at: string,
  chunkSize: number = LEDGER_CHUNK_SIZE,
): CorpusLedgerChunk[] {
  const size = Math.max(1, Math.floor(chunkSize));
  const ids = [...entries.keys()].sort();
  const chunks: CorpusLedgerChunk[] = [];
  for (let i = 0; i < ids.length; i += size) {
    const slice = ids.slice(i, i + size);
    const e: Record<string, string> = Object.create(null);
    for (const id of slice) e[id] = entries.get(id)!;
    chunks.push({ version: 1, at, entries: e });
  }
  return chunks;
}

/**
 * Write `chunks` and prune any prior chunk key not overwritten (so a corpus that shrank from 6 chunks to
 * 3 does not leave 3 orphan chunks). MUST be called inside the same `store.tx` as the manifest + audit.
 * `priorChunkKeys` is read (via `listLedgerChunkKeys`) BEFORE the tx opens — the tx handle has no `list`.
 */
export async function writeLedgerInTx(
  t: RuntimeStateTx,
  chunks: CorpusLedgerChunk[],
  priorChunkKeys: string[],
): Promise<void> {
  const written = new Set<string>();
  for (let i = 0; i < chunks.length; i++) {
    const key = ledgerChunkKey(i);
    await t.put(MANIFEST_COLLECTION, key, chunks[i]);
    written.add(key);
  }
  for (const key of priorChunkKeys) {
    if (!written.has(key)) await t.delete(MANIFEST_COLLECTION, key);
  }
}

/** Erasure (ADR-0015): drop every ledger chunk for this tenant. Call inside the clear's `store.tx`. */
export async function deleteLedgerInTx(t: RuntimeStateTx, priorChunkKeys: string[]): Promise<void> {
  for (const key of priorChunkKeys) await t.delete(MANIFEST_COLLECTION, key);
}
```

- [ ] **Step 4: Run the ledger test to verify it passes**

Run: `env -u GOOGLE_CLOUD_PROJECT pnpm exec vitest run packages/widget-backend/test/catalog-ledger.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Write the failing erasure test** — append to `packages/widget-backend/test/catalog-ledger.test.ts`

```ts
import { createInMemoryVectorStore } from "@palup/platform-ports";
import { runCatalogClear, catalogNamespace, catalogRecordId } from "../src/jobs/catalog-index.js";

describe("erasure — runCatalogClear drops the tenant ledger chunks (ADR-0015)", () => {
  it("removes the ledger records along with the corpus and manifest", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const ns = catalogNamespace("acme");
    await vector.upsert(ns, [{ id: catalogRecordId("gid://shopify/Product/1"), vector: [1, 0, 0, 0] }]);
    await store.put({ tenantId: "acme" }, MANIFEST_COLLECTION, MANIFEST_KEY, {
      model: "fake-embed-4d",
      dimension: 4,
      purpose: "document",
      products: 1,
      at: AT,
      ceiling: 50000,
    });
    await store.tx({ tenantId: "acme" }, async (t) => {
      await writeLedgerInTx(t, chunkLedgerEntries(ledgerOf(3), AT), []);
    });

    const report = await runCatalogClear({ store, vector }, "acme");

    expect(report.confirmed).toBe(true);
    expect(await listLedgerChunkKeys(store, "acme")).toEqual([]);
    expect(await store.get({ tenantId: "acme" }, MANIFEST_COLLECTION, MANIFEST_KEY)).toBeNull();
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `env -u GOOGLE_CLOUD_PROJECT pnpm exec vitest run packages/widget-backend/test/catalog-ledger.test.ts -t "drops the tenant ledger"`
Expected: FAIL — `listLedgerChunkKeys` still returns `["ledger:0000"]` (clear does not drop the ledger yet).

- [ ] **Step 7: Wire ledger drop into `runCatalogClear`** — `packages/widget-backend/src/jobs/catalog-index.ts`

Add to the existing import block near the top (after the `../shopify-grounding.js` import):

```ts
import { deleteLedgerInTx, listLedgerChunkKeys } from "./catalog-ledger.js";
```

In `runCatalogClear`, read the chunk keys before the tx and delete them inside it. Change:

```ts
  await deps.store.tx({ tenantId }, async (t) => {
    await t.delete(MANIFEST_COLLECTION, MANIFEST_KEY);
    await t.audit(
```

to:

```ts
  // S3 §F — the ledger is per-tenant KV; erasing the corpus must also erase its ledger chunks (ADR-0015).
  // Read the chunk keys before the tx (the tx handle has no `list`), delete them inside it.
  const ledgerChunkKeys = await listLedgerChunkKeys(deps.store, tenantId);
  await deps.store.tx({ tenantId }, async (t) => {
    await t.delete(MANIFEST_COLLECTION, MANIFEST_KEY);
    await deleteLedgerInTx(t, ledgerChunkKeys);
    await t.audit(
```

- [ ] **Step 8: Run the ledger test suite + typecheck to verify green**

Run: `env -u GOOGLE_CLOUD_PROJECT pnpm exec vitest run packages/widget-backend/test/catalog-ledger.test.ts && env -u GOOGLE_CLOUD_PROJECT pnpm -w exec tsc -b`
Expected: PASS (6 tests) and a clean typecheck.

- [ ] **Step 9: Commit**

```bash
git add packages/widget-backend/src/jobs/catalog-ledger.ts packages/widget-backend/src/jobs/catalog-index.ts packages/widget-backend/test/catalog-ledger.test.ts
git commit -m "feat(catalog-index): corpus-state ledger in RuntimeState KV + erasure drop (S3 §B/§F, ships dark)"
```

---

## Task 2: ANN-safe reconcile — diff the ledger, remove every `query({text:""})`

**Files:**
- Modify: `packages/widget-backend/src/jobs/catalog-index.ts` (`indexOneTenant` reconcile block `~494-752`; `writeManifestAndAudit` `~762-793`)
- Modify: `package.json` (add the pgvector reconcile test to the `test:pgvector` script list)
- Test: `packages/widget-backend/test/catalog-index-ledger-reconcile.test.ts` (mock path + grep-guard)
- Test: `packages/widget-backend/test/catalog-index-pgvector-reconcile.test.ts` (HEADLINE, real pgvector testcontainer)

**Interfaces:**
- Consumes (from Task 1): `readCorpusLedger`, `listLedgerChunkKeys`, `chunkLedgerEntries`, `writeLedgerInTx`.
- Produces: `writeManifestAndAudit(deps, tenantId, manifest, counts, ledger)` — new 5th param `ledger: { entries: Map<string,string>; priorChunkKeys: string[] }`. `runCatalogIndex` / `indexOneTenant` signatures are unchanged for callers.

**Design decisions (from spec §B; state these in the code comments):**
1. `indexOneTenant` NEVER calls `deps.vector.query(ns, { text: "" })` again — the enumerate (`:509`), the migration probe refusal (`:510-516`), and the read-back verify (`:692-703`) are all removed. The ledger is the record of what is indexed; the durable `upsert` is already all-or-nothing in one transaction (its own comment), and a ledger/store drift self-heals on the next `--reindex`.
2. `stale` is `ledger ids ∉ plan`. On `--reindex` or when the ledger is empty (migration / first S3 run), `stale = []` — no ledger ⇒ unknown prior set ⇒ **never blind-delete**; build the ledger from the plan and let a later `--reindex` prune legacy orphans.
3. Foreign-guard is intrinsic (the ledger only holds `product:` ids; `readCorpusLedger` asserts it). `deleteById(stale)` can only ever delete ledger ids, which are `product:` ids this job wrote.
4. The pin check still runs on the first embed batch against the existing manifest, so a model/dimension/purpose change still costs one batch, not a catalog.

- [ ] **Step 1: Write the failing mock-path test** — `packages/widget-backend/test/catalog-index-ledger-reconcile.test.ts`

```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi } from "vitest";
import {
  InMemoryRuntimeStore,
  createInMemoryVectorStore,
  requireEmbedInputs,
  type EmbedRequest,
  type EmbedResponse,
  type GroundingContext,
  type ModelPort,
  type Product,
  type VectorPort,
} from "@palup/platform-ports";
import { runCatalogIndex, catalogNamespace, catalogRecordId, type CatalogSource } from "../src/jobs/catalog-index.js";
import { readCorpusLedger } from "../src/jobs/catalog-ledger.js";

function fakeModel(dimension = 4, model = "fake-embed-4d"): ModelPort {
  return {
    async complete() {
      return { text: "ok", model };
    },
    async embed(req: EmbedRequest): Promise<EmbedResponse> {
      requireEmbedInputs(req);
      const vectors = req.texts.map((t) => {
        const v = new Array(dimension).fill(0);
        for (let i = 0; i < t.length; i++) v[i % dimension] += t.charCodeAt(i) % 7;
        return v;
      });
      return { vectors, model, dimension, purpose: req.purpose };
    },
  };
}

function product(id: string, title: string): Product {
  return { id, title, description: `${title} desc`, price: "$10", tags: [title], availableForSale: true };
}

function catalogOf(products: Product[]): CatalogSource {
  return async (tenantId): Promise<GroundingContext | undefined> => ({
    tenantId,
    brandName: "Acme",
    products,
    policy: { returns: "", shipping: "" },
  });
}

const P1 = product("gid://shopify/Product/1", "alpha");
const P2 = product("gid://shopify/Product/2", "beta");
const P3 = product("gid://shopify/Product/3", "gamma");

describe("S3 §B — reconcile diffs the ledger (new/changed/stale), never enumerates the vector store", () => {
  it("first run (no ledger) indexes everything and writes a ledger; a clean re-run is unchanged (no spend)", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const model = fakeModel();
    const catalog = catalogOf([P1, P2]);

    const [r1] = await runCatalogIndex({ store, vector, model, catalog }, ["acme"]);
    expect(r1!.outcome).toBe("indexed");
    expect(r1!.embedded).toBe(2);
    expect((await readCorpusLedger(store, "acme")).size).toBe(2);

    const embedSpy = vi.spyOn(model, "embed");
    const [r2] = await runCatalogIndex({ store, vector, model, catalog }, ["acme"]);
    expect(r2!.outcome).toBe("unchanged");
    expect(embedSpy).not.toHaveBeenCalled();
  });

  it("a changed hash re-embeds ONLY that product; a delisted product is deleteById'd exactly once", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const model = fakeModel();
    await runCatalogIndex({ store, vector, model, catalog: catalogOf([P1, P2, P3]) }, ["acme"]);

    const deleteSpy = vi.spyOn(vector, "deleteById");
    const embedSpy = vi.spyOn(model, "embed");
    // P2 changed (new title => new embed text => new hash); P3 delisted; P1 unchanged.
    const P2b = product("gid://shopify/Product/2", "beta-renamed");
    const [r] = await runCatalogIndex({ store, vector, model, catalog: catalogOf([P1, P2b]) }, ["acme"]);

    expect(r!.outcome).toBe("indexed");
    expect(r!.embedded).toBe(1); // only P2b
    expect(r!.removed).toBe(1); // only P3
    const deletedIds = deleteSpy.mock.calls.flatMap((c) => c[1]);
    expect(deletedIds).toEqual([catalogRecordId(P3.id)]);
    const ledger = await readCorpusLedger(store, "acme");
    expect([...ledger.keys()].sort()).toEqual([catalogRecordId(P1.id), catalogRecordId(P2.id)]);
    // P1's hash unchanged, so embed was called once (for P2b) — no re-spend on P1.
    expect(embedSpy.mock.calls.flatMap((c) => c[0].texts)).toHaveLength(1);
  });

  it("no product in the reconcile calls vector.query with a text modality", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const querySpy = vi.spyOn(vector, "query");
    await runCatalogIndex({ store, vector, model: fakeModel(), catalog: catalogOf([P1, P2]) }, ["acme"]);
    await runCatalogIndex({ store, vector, model: fakeModel(), catalog: catalogOf([P1]) }, ["acme"]);
    const textQueries = querySpy.mock.calls.filter(([, q]) => typeof q.text === "string");
    expect(textQueries).toEqual([]);
  });

  it("GREP-GUARD: indexOneTenant/writeManifestAndAudit contain no `query(...{ text: \"\" })` enumerate", () => {
    const src = readFileSync(fileURLToPath(new URL("../src/jobs/catalog-index.ts", import.meta.url)), "utf8");
    // The reconcile path must never re-introduce the ANN-unsafe enumerate. `runCatalogClear` (the erase
    // path) is out of this guard's scope — it is exercised only on the brute-force store.
    const reconcileRegion = src.slice(src.indexOf("async function indexOneTenant"), src.indexOf("export async function runCatalogClear"));
    expect(reconcileRegion).not.toMatch(/\.query\([^)]*text\s*:\s*""/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `env -u GOOGLE_CLOUD_PROJECT pnpm exec vitest run packages/widget-backend/test/catalog-index-ledger-reconcile.test.ts`
Expected: FAIL — the grep-guard fails (the enumerate is still present) and the `deleteById`/embed-count assertions fail (reconcile still diffs the vector store).

- [ ] **Step 3: Rewrite the reconcile block in `indexOneTenant`** — `packages/widget-backend/src/jobs/catalog-index.ts`

Add to the import block:

```ts
import { chunkLedgerEntries, listLedgerChunkKeys, readCorpusLedger, writeLedgerInTx } from "./catalog-ledger.js";
```

Replace the whole span from the `// Enumerate the existing corpus.` comment (`~496`) down to the end of the `if (toEmbed.length === 0 && stale.length === 0 && !opts.reindex) { … }` block (`~610`) with:

```ts
  // S3 §B — the corpus id→hash set comes from the LEDGER (RuntimeState KV), NOT a vector enumerate. The
  // S2-parked ANN-unsafe `deps.vector.query(ns, { text: "" })` is gone: it silently truncated at 5000 on
  // the brute-force store and THREW on the S1 pgvector store, so a >5000-SKU pgvector index could not be
  // reconciled at all. `readCorpusLedger` asserts every id is a `product:` id, so the old foreign-guard is
  // intrinsic — reconcile can only ever `deleteById` ids this job wrote.
  const priorChunkKeys = opts.reindex ? [] : await listLedgerChunkKeys(deps.store, tenantId);
  const ledger = opts.reindex ? new Map<string, string>() : await readCorpusLedger(deps.store, tenantId);

  const manifest = await deps.store.get<CatalogManifest>(ctx, MANIFEST_COLLECTION, MANIFEST_KEY);

  const wanted = new Set(plan.map((p) => p.recordId));
  // NEW/CHANGED: a plan record whose ledger hash differs (or is absent) must be re-embedded. UNCHANGED: a
  // ledger hash equal to the plan hash is skipped — preserving the content-hash "free re-run" optimization.
  const toEmbed = plan.filter((p) => ledger.get(p.recordId) !== p.hash);
  // STALE: ledger ids no longer in the plan (delisted). MIGRATION SAFETY: an empty ledger (first S3 run, or
  // a corpus built pre-S3) means the prior set is UNKNOWN, so nothing is deleted — build the ledger from the
  // plan and let a later `--reindex` prune legacy orphans (spec §B "Migration"). `--reindex` erased the
  // namespace above, so its stale set is also empty.
  const stale = opts.reindex || ledger.size === 0 ? [] : [...ledger.keys()].filter((id) => !wanted.has(id));

  if (toEmbed.length === 0 && stale.length === 0 && !opts.reindex) {
    // Nothing to do. The ledger is authoritative and committed atomically with the manifest, so a manifest
    // whose count matches the ledger size describes this corpus exactly.
    if (manifest && manifest.purpose && manifest.products === ledger.size) {
      return {
        tenantId,
        outcome: "unchanged",
        products: plan.length,
        embedded: 0,
        written: 0,
        removed: 0,
        model: manifest.model,
        dimension: manifest.dimension,
      };
    }
    // Manifest count drifted from the ledger (e.g. a crash between the corpus write and the manifest write
    // in a pre-S3 record) — repair the COUNT without re-embedding, carrying provenance forward verbatim. A
    // manifest with no recorded purpose cannot be repaired into one (that would invent provenance).
    if (!manifest || !manifest.purpose) {
      throw new CatalogRefusal(
        "failed",
        "the corpus has no manifest purpose to carry forward and nothing to embed, so its vector space " +
          "cannot be stated honestly — rebuild explicitly with --reindex",
      );
    }
    const repaired: CatalogManifest = {
      model: manifest.model,
      dimension: manifest.dimension,
      purpose: manifest.purpose,
      products: ledger.size,
      at: now().toISOString(),
      ceiling: maxProducts,
    };
    await writeManifestAndAudit(
      deps,
      tenantId,
      repaired,
      { products: plan.length, embedded: 0, written: 0, removed: 0, reindex: false, repaired: true },
      { entries: ledger, priorChunkKeys },
    );
    return {
      tenantId,
      outcome: "manifest-repaired",
      products: plan.length,
      embedded: 0,
      written: 0,
      removed: 0,
      model: repaired.model,
      dimension: repaired.dimension,
    };
  }
```

Then update the embed loop's pin check: it currently reads `if (manifest && existing.length > 0 && !opts.reindex)`. Replace `existing.length > 0` with `ledger.size > 0`:

```ts
      if (manifest && ledger.size > 0 && !opts.reindex) {
        const mismatch = pinMismatch(manifest, res);
```

Then, in the `// ── write ──` section, delete the read-back verify block entirely — remove from `// READ THE RESULT BACK.` (`~691`) through the `if (missing.length > 0) { … }` close (`~703`), and replace with:

```ts
  // NO READ-BACK ENUMERATE (S3 §B). The old `query(ns, { text: "" })` read-back is gone — it required the
  // text-modality enumerate the S1 pgvector store rejects. `upsert` is all-or-nothing inside the durable
  // adapter's single transaction (postgres-vector-store.ts), and the LEDGER we write below (atomically with
  // the manifest + audit) is the record of what is indexed. A rare upsert/ledger drift self-heals on the
  // next `--reindex` (which erases + rebuilds from scratch).
```

Then update the final write. The `finalCount` line stays (`opts.reindex ? records.length : wanted.size`). Change the `writeManifestAndAudit` call to pass the new ledger param. Replace:

```ts
  await writeManifestAndAudit(deps, tenantId, written, {
    products: plan.length,
    embedded: toEmbed.length,
    written: records.length,
    removed: stale.length,
    reindex: opts.reindex === true,
    repaired: false,
  });
```

with:

```ts
  // The new ledger reflects the WHOLE corpus (plan == wanted): unchanged records keep their hash, changed
  // ones get the new hash, stale ones are dropped. On --reindex the corpus is exactly the plan too.
  const newLedger = new Map(plan.map((p) => [p.recordId, p.hash]));
  await writeManifestAndAudit(
    deps,
    tenantId,
    written,
    {
      products: plan.length,
      embedded: toEmbed.length,
      written: records.length,
      removed: stale.length,
      reindex: opts.reindex === true,
      repaired: false,
    },
    { entries: newLedger, priorChunkKeys },
  );
```

- [ ] **Step 4: Extend `writeManifestAndAudit` to write the ledger in the same tx**

Change the signature and body:

```ts
async function writeManifestAndAudit(
  deps: CatalogIndexDeps,
  tenantId: string,
  manifest: CatalogManifest,
  counts: { products: number; embedded: number; written: number; removed: number; reindex: boolean; repaired: boolean },
  ledger: { entries: Map<string, string>; priorChunkKeys: string[] },
): Promise<void> {
  const at = manifest.at;
  await deps.store.tx({ tenantId }, async (t) => {
    await t.put(MANIFEST_COLLECTION, MANIFEST_KEY, manifest);
    // S3 §B — the ledger commits ATOMICALLY with the manifest + audit (one tx), so the three can never
    // disagree about what is indexed. Prunes any prior chunk key the new corpus no longer fills.
    await writeLedgerInTx(t, chunkLedgerEntries(ledger.entries, at), ledger.priorChunkKeys);
    await t.audit(
```

(The `t.audit(...)` call body is unchanged.)

- [ ] **Step 5: Run the mock-path test to verify it passes**

Run: `env -u GOOGLE_CLOUD_PROJECT pnpm exec vitest run packages/widget-backend/test/catalog-index-ledger-reconcile.test.ts`
Expected: PASS (4 tests, incl. the grep-guard).

- [ ] **Step 6: Run the existing catalog-index job suite (no regression)**

Run: `env -u GOOGLE_CLOUD_PROJECT pnpm exec vitest run packages/widget-backend/test/catalog-index-job.test.ts packages/widget-backend/test/catalog-index-metadata.test.ts`
Expected: PASS. If a test asserted the old `query({text:""})` enumerate or the read-back, update it to assert the ledger diff instead (the behavior is equivalent, the mechanism moved to KV). Note any such edit in the commit body.

- [ ] **Step 7: Write the HEADLINE pgvector-testcontainer test** — `packages/widget-backend/test/catalog-index-pgvector-reconcile.test.ts`

```ts
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import {
  InMemoryRuntimeStore,
  requireEmbedInputs,
  type EmbedRequest,
  type EmbedResponse,
  type GroundingContext,
  type ModelPort,
  type Product,
} from "@palup/platform-ports";
import { PgVectorStore, type Sql } from "@palup/state-postgres";
import { startPgvectorContainer, PGVECTOR_AVAILABLE } from "@palup/state-postgres/test/helpers/pgvector-container";
import { runCatalogIndex, catalogNamespace, type CatalogSource } from "../src/jobs/catalog-index.js";
import { readCorpusLedger } from "../src/jobs/catalog-ledger.js";

// HEADLINE (S3 §B/§G): the S2-parked bug, now closed. A >5000-entry ledger reconcile runs on the REAL
// pgvector HNSW store (which THROWS on a text-modality query) with ZERO `query({text:""})` calls and no
// throw. This is why the pgvector merge-gate step now also covers the ANN-safe reconcile.

const DIMENSION = 8;

function fakeModel(): ModelPort {
  return {
    async complete() {
      return { text: "ok", model: "fake-embed-8d" };
    },
    async embed(req: EmbedRequest): Promise<EmbedResponse> {
      requireEmbedInputs(req);
      const vectors = req.texts.map((t) => {
        const v = new Array(DIMENSION).fill(0);
        for (let i = 0; i < t.length; i++) v[i % DIMENSION] += (t.charCodeAt(i) % 5) + 1;
        return v;
      });
      return { vectors, model: "fake-embed-8d", dimension: DIMENSION, purpose: req.purpose };
    },
  };
}

function bigCatalog(n: number, renameFirst = 0): CatalogSource {
  return async (tenantId): Promise<GroundingContext> => {
    const products: Product[] = [];
    for (let i = 0; i < n; i++) {
      products.push({
        id: `gid://shopify/Product/${i}`,
        title: i < renameFirst ? `title-${i}-v2` : `title-${i}`,
        description: `desc-${i}`,
        price: "$10",
        tags: [`tag-${i % 50}`],
        availableForSale: true,
      });
    }
    return { tenantId, brandName: "Big", products, policy: { returns: "", shipping: "" } };
  };
}

describe.skipIf(!PGVECTOR_AVAILABLE)("HEADLINE — >5000-entry ledger reconcile on real pgvector", () => {
  let sql: Sql;
  let stop: () => Promise<void>;

  beforeAll(async () => {
    ({ sql, stop } = await startPgvectorContainer());
    await new PgVectorStore(sql, { dimension: DIMENSION, efSearch: 40 }).migrate();
  }, 120_000);

  afterAll(async () => {
    await stop?.();
  }, 120_000);

  it("indexes 6000 SKUs, then reconciles a delta, with zero text-modality queries and no throw", async () => {
    await sql.query("TRUNCATE vp_ann");
    const store = new InMemoryRuntimeStore();
    const vector = new PgVectorStore(sql, { dimension: DIMENSION, efSearch: 40 });
    const model = fakeModel();
    const querySpy = vi.spyOn(vector, "query");

    const [first] = await runCatalogIndex({ store, vector, model, catalog: bigCatalog(6000) }, ["big"], {});
    expect(first!.outcome).toBe("indexed");
    expect(first!.written).toBe(6000);
    expect((await readCorpusLedger(store, "big")).size).toBe(6000);

    // Reconcile a delta: rename the first 3 products (changed) and drop the last 1000 (stale) -> 5000 left.
    const [second] = await runCatalogIndex(
      { store, vector, model, catalog: bigCatalog(5000, 3) },
      ["big"],
      {},
    );
    expect(second!.outcome).toBe("indexed");
    expect(second!.embedded).toBe(3); // only the 3 renamed
    expect(second!.removed).toBe(1000); // the delisted tail
    expect((await readCorpusLedger(store, "big")).size).toBe(5000);

    // The whole run never issued a text-modality query (which PgVectorStore would have thrown on).
    const textQueries = querySpy.mock.calls.filter(([, q]) => typeof (q as { text?: unknown }).text === "string");
    expect(textQueries).toEqual([]);
  }, 120_000);
});
```

> If `@palup/state-postgres/test/helpers/pgvector-container` does not resolve from widget-backend, add a `"./test/helpers/*"` entry to `@palup/state-postgres`'s `package.json` `exports`, or copy the ~40-line helper to `packages/widget-backend/test/helpers/pgvector-container.ts`. Also add `testcontainers` to `packages/widget-backend`'s `devDependencies` (already in the lockfile via `@palup/state-postgres`) — this is the one dependency reference this task needs; do not add any other.

- [ ] **Step 8: Add the HEADLINE test to the pgvector merge-gate step** — `package.json`

Append the new file to the `test:pgvector` script's space-separated list (keep the step *name* "pgvector ANN adapter (testcontainer)" unchanged in `ci.yml`):

```json
    "test:pgvector": "vitest run packages/state-postgres/test/pgvector-container.smoke.test.ts packages/state-postgres/test/pgvector-store.migrate.test.ts packages/state-postgres/test/pgvector-store.upsert.test.ts packages/state-postgres/test/pgvector-store.query.test.ts packages/state-postgres/test/pgvector-store.erasure.test.ts packages/state-postgres/test/pgvector-store.contract.test.ts packages/state-postgres/test/vector-factory.ann.test.ts packages/widget-backend/test/catalog-index-pgvector-reconcile.test.ts",
```

- [ ] **Step 9: Run the HEADLINE test against a real container**

Run: `pnpm test:pgvector` (Docker must be running; `env -u GOOGLE_CLOUD_PROJECT` is fine but this suite needs no Vertex). If Docker is unavailable locally, run only the new file with `PGVECTOR_TESTCONTAINER` unset and Docker up: `env -u GOOGLE_CLOUD_PROJECT pnpm exec vitest run packages/widget-backend/test/catalog-index-pgvector-reconcile.test.ts`.
Expected: PASS — 6000 indexed, delta reconciled (embedded=3, removed=1000), zero text queries, no `PgVectorTextQueryUnsupported`.

- [ ] **Step 10: Commit**

```bash
git add packages/widget-backend/src/jobs/catalog-index.ts package.json packages/widget-backend/test/catalog-index-ledger-reconcile.test.ts packages/widget-backend/test/catalog-index-pgvector-reconcile.test.ts
git commit -m "feat(catalog-index): ANN-safe reconcile via the ledger diff; drop the text-query enumerate (S3 §B, closes the S2-parked bug)"
```

---

## Task 3: Webhook payload carries changed product id(s) + per-topic id extraction

**Files:**
- Modify: `packages/widget-backend/src/catalog-webhook-queue.ts` (`catalogReconcileMessage`, add `ReconcileReason`)
- Modify: `packages/widget-backend/src/shopify-webhook-identity.ts` (add `productIdOf`)
- Modify: `packages/widget-backend/src/routes/shopify-webhooks.ts` (`handleCatalogChange` `~377-390`)
- Test: `packages/widget-backend/test/catalog-webhook-queue.test.ts` (extend), `packages/widget-backend/test/shopify-webhooks-catalog.test.ts` (new or extend existing webhook test)

**Interfaces:**
- Produces:
  - `type ReconcileReason = "product" | "inventory" | "full"`
  - `SHOPIFY_PRODUCT_GID_PREFIX = "gid://shopify/Product/"`
  - `catalogReconcileMessage(tenantId, topic, webhookId, nowMs, extra?: { productIds?: string[]; reason?: ReconcileReason })` — payload becomes `{ tenantId, topic, at, productIds?, reason }`.
  - `productIdOf(body): string | undefined` — the numeric product id from a `products/*` body (same numeric discipline as `customerIdOf`).

- [ ] **Step 1: Write the failing queue test** — extend `packages/widget-backend/test/catalog-webhook-queue.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { catalogReconcileMessage } from "../src/catalog-webhook-queue.js";

describe("S3 §C — reconcile message carries changed product ids + a reason", () => {
  it("carries productIds and reason:product for a product topic", () => {
    const msg = catalogReconcileMessage("acme", "products/update", "wh-1", 1000, {
      productIds: ["gid://shopify/Product/7"],
      reason: "product",
    });
    expect(msg.payload).toMatchObject({
      tenantId: "acme",
      topic: "products/update",
      productIds: ["gid://shopify/Product/7"],
      reason: "product",
    });
    expect(msg.tenantKey).toBe("acme");
    expect(msg.id).toBe("wh-1");
  });

  it("defaults to reason:full with no productIds when nothing is passed (the backstop path)", () => {
    const msg = catalogReconcileMessage("acme", "products/create", undefined, 2000);
    expect(msg.payload).toMatchObject({ tenantId: "acme", reason: "full" });
    expect((msg.payload as { productIds?: unknown }).productIds).toBeUndefined();
    expect(msg.id).toBe("acme:products/create:2000");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `env -u GOOGLE_CLOUD_PROJECT pnpm exec vitest run packages/widget-backend/test/catalog-webhook-queue.test.ts -t "reconcile message carries"`
Expected: FAIL — `catalogReconcileMessage` takes 4 args and its payload has no `productIds`/`reason`.

- [ ] **Step 3: Extend `catalogReconcileMessage`** — `packages/widget-backend/src/catalog-webhook-queue.ts`

```ts
/** Why a reconcile fired, so the worker can target (or fall back to a full crawl). `product` = precise ids
 *  present; `inventory` = a coarse inventory tick (no product id derivable from the Storefront token — see
 *  §C); `full` = re-derive the whole catalog (the backstop path). */
export type ReconcileReason = "product" | "inventory" | "full";

export function catalogReconcileMessage(
  tenantId: string,
  topic: string,
  webhookId: string | undefined,
  nowMs: number,
  extra: { productIds?: string[]; reason?: ReconcileReason } = {},
): QueueMessage {
  const reason: ReconcileReason = extra.reason ?? "full";
  return {
    id: webhookId ?? `${tenantId}:${topic}:${nowMs}`,
    type: `catalog.${topic}`,
    tenantKey: tenantId,
    payload: {
      tenantId,
      topic,
      at: new Date(nowMs).toISOString(),
      reason,
      ...(extra.productIds && extra.productIds.length > 0 ? { productIds: extra.productIds } : {}),
    },
  };
}
```

- [ ] **Step 4: Write the failing `productIdOf` test** — extend a webhook-identity test file (e.g. `packages/widget-backend/test/shopify-webhook-identity.test.ts`; create if absent)

```ts
import { describe, it, expect } from "vitest";
import { productIdOf } from "../src/shopify-webhook-identity.js";

describe("S3 §C — productIdOf: the numeric product id from a products/* body", () => {
  it("reads a numeric id", () => {
    expect(productIdOf({ id: 788032119674292922 } as Record<string, unknown>)).toBe("788032119674292922");
  });
  it("reads an all-digits string id", () => {
    expect(productIdOf({ id: "12345" } as Record<string, unknown>)).toBe("12345");
  });
  it("refuses a float, a GID, an object, null, or empty (never coerces)", () => {
    expect(productIdOf({ id: 1.5 } as Record<string, unknown>)).toBeUndefined();
    expect(productIdOf({ id: "gid://shopify/Product/1" } as Record<string, unknown>)).toBeUndefined();
    expect(productIdOf({ id: {} } as Record<string, unknown>)).toBeUndefined();
    expect(productIdOf({ id: null } as Record<string, unknown>)).toBeUndefined();
    expect(productIdOf({} as Record<string, unknown>)).toBeUndefined();
  });
});
```

- [ ] **Step 5: Run it to verify it fails**

Run: `env -u GOOGLE_CLOUD_PROJECT pnpm exec vitest run packages/widget-backend/test/shopify-webhook-identity.test.ts -t "productIdOf"`
Expected: FAIL — `productIdOf` is not exported.

- [ ] **Step 6: Add `productIdOf`** — `packages/widget-backend/src/shopify-webhook-identity.ts` (after `customerIdOf`)

```ts
/**
 * The top-level product id from a `products/*` webhook body as a BARE DECIMAL STRING, or `undefined`.
 * Shopify's product webhooks carry `"id": <number>` (e.g. `788032119674292922`). Same numeric discipline
 * as `customerIdOf`: a non-negative safe integer or an all-digits string only — everything else refuses,
 * so a hostile value can never be interpolated into a corpus record id or a Storefront GID. `matchesPayloadShape`
 * has already required `id` present for these topics; this validates it.
 */
export function productIdOf(body: Record<string, unknown>): string | undefined {
  const id = body.id;
  if (typeof id === "number") return Number.isSafeInteger(id) && id >= 0 ? String(id) : undefined;
  if (typeof id === "string" && /^\d+$/.test(id)) return id;
  return undefined;
}
```

- [ ] **Step 7: Write the failing handler test** — `packages/widget-backend/test/shopify-webhooks-catalog.test.ts`

Follow the existing webhook test's harness (raw-body HMAC, an injected `queue` whose `publish` records messages, a durable in-memory registry). The assertions:

```ts
// (Harness: build a signed products/update delivery with body { id: 7 }, a signed products/delete with
// body { id: 9 }, and a signed inventory_levels/update with body { inventory_item_id: 3 }. Post each to
// its route with a valid HMAC over the raw bytes and X-Shopify-Shop-Domain for a registered tenant.)

it("products/update enqueues a targeted reconcile with the GID and reason:product", async () => {
  await postSigned(WEBHOOK_ROUTES.productsUpdate, "products/update", { id: 7 });
  expect(published).toHaveLength(1);
  expect(published[0]!.payload).toMatchObject({
    reason: "product",
    productIds: ["gid://shopify/Product/7"],
  });
});

it("products/delete enqueues reason:product with the GID (the worker deletes without a fetch)", async () => {
  await postSigned(WEBHOOK_ROUTES.productsDelete, "products/delete", { id: 9 });
  expect(published[0]!.payload).toMatchObject({ reason: "product", productIds: ["gid://shopify/Product/9"] });
});

it("inventory_levels/update enqueues reason:inventory with NO productIds (no per-event crawl)", async () => {
  await postSigned(WEBHOOK_ROUTES.inventoryLevelsUpdate, "inventory_levels/update", { inventory_item_id: 3 });
  expect(published[0]!.payload).toMatchObject({ reason: "inventory" });
  expect((published[0]!.payload as { productIds?: unknown }).productIds).toBeUndefined();
});
```

- [ ] **Step 8: Run it to verify it fails**

Run: `env -u GOOGLE_CLOUD_PROJECT pnpm exec vitest run packages/widget-backend/test/shopify-webhooks-catalog.test.ts`
Expected: FAIL — the enqueued payload has no `productIds`/`reason` yet.

- [ ] **Step 9: Extend `handleCatalogChange`** — `packages/widget-backend/src/routes/shopify-webhooks.ts`

Add to the identity import block: `productIdOf`, and to the queue import: `SHOPIFY_PRODUCT_GID_PREFIX` (define it in `catalog-webhook-queue.ts` — `export const SHOPIFY_PRODUCT_GID_PREFIX = "gid://shopify/Product/";`), and `CATALOG_TOPICS` (already imported). Replace the enqueue at `~387`:

```ts
  if (await deps.killCheck(tenantId)) return "halted_deferred";
  if (await alreadyHandled(deps, tenantId, topic, v.webhookId)) return "already_handled";
  // S3 §C — carry the changed product id when the topic is precise. products/* bodies carry the numeric id;
  // corpus record ids use the Storefront GID, so build it here so the worker can fetch/upsert/delete exactly
  // that SKU. inventory_levels/update carries an inventory_item_id, NOT a product id, and the Storefront
  // delegate token cannot resolve it — so it enqueues reason:"inventory" with NO ids and triggers no crawl
  // (freshness for it comes from the hourly backstop §E + the 15-min serve-time ceiling §D). The worker
  // still NEVER trusts the body beyond these ids: it re-fetches the named products' CURRENT state.
  let productIds: string[] | undefined;
  let reason: ReconcileReason = "full";
  if (topic === "products/create" || topic === "products/update" || topic === "products/delete") {
    const numeric = productIdOf(v.body);
    if (numeric) {
      productIds = [`${SHOPIFY_PRODUCT_GID_PREFIX}${numeric}`];
      reason = "product";
    }
    // A products/* delivery whose id we cannot validate falls back to reason:"full" (a safe whole-catalog
    // reconcile) rather than guessing.
  } else if (topic === "inventory_levels/update") {
    reason = "inventory";
  }
  await deps.queue.publish(
    CATALOG_RECONCILE_TOPIC,
    catalogReconcileMessage(tenantId, topic, v.webhookId, deps.now(), { ...(productIds ? { productIds } : {}), reason }),
  );
  await markHandled(deps, tenantId, topic, v.webhookId);
  return "applied";
```

Add `ReconcileReason` and `SHOPIFY_PRODUCT_GID_PREFIX` to the `catalog-webhook-queue.js` import at the top of the file (line 7):

```ts
import { CATALOG_RECONCILE_TOPIC, catalogReconcileMessage, SHOPIFY_PRODUCT_GID_PREFIX, type ReconcileReason } from "../catalog-webhook-queue.js";
```

- [ ] **Step 10: Run the new tests + the existing webhook suite**

Run: `env -u GOOGLE_CLOUD_PROJECT pnpm exec vitest run packages/widget-backend/test/catalog-webhook-queue.test.ts packages/widget-backend/test/shopify-webhook-identity.test.ts packages/widget-backend/test/shopify-webhooks-catalog.test.ts`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add packages/widget-backend/src/catalog-webhook-queue.ts packages/widget-backend/src/shopify-webhook-identity.ts packages/widget-backend/src/routes/shopify-webhooks.ts packages/widget-backend/test/catalog-webhook-queue.test.ts packages/widget-backend/test/shopify-webhook-identity.test.ts packages/widget-backend/test/shopify-webhooks-catalog.test.ts
git commit -m "feat(catalog-webhooks): carry changed product id(s)+reason; inventory stays coarse (S3 §C, ships dark)"
```

---

## Task 4: `fetchProductsById` on the Shopify catalog source (Storefront `nodes(ids:)`)

**Files:**
- Modify: `packages/widget-backend/src/shopify-grounding.ts` (add `storefrontFetchByIds`, `StorefrontByIdFetch`, `STOREFRONT_NODES_QUERY`)
- Test: `packages/widget-backend/test/shopify-grounding-by-id.test.ts`

**Interfaces:**
- Produces:
  - `type StorefrontByIdFetch = (creds: ShopifyStoreCreds, ids: string[]) => Promise<StorefrontData>`
  - `storefrontFetchByIds(fetchFn?, opts?): StorefrontByIdFetch` — POSTs `nodes(ids: [ID!]!)`, returns `{ products: { nodes } }` shaped so `mapStorefrontToContext(tenantId, data).products` yields only the resolved Product nodes (nulls / non-Product nodes dropped).

- [ ] **Step 1: Write the failing test** — `packages/widget-backend/test/shopify-grounding-by-id.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { mapStorefrontToContext } from "../src/shopify-grounding.js";
import { storefrontFetchByIds } from "../src/shopify-grounding.js";
import type { ShopifyStoreCreds } from "../src/merchant-store.js";

const CREDS: ShopifyStoreCreds = { shopDomain: "acme.myshopify.com", accessToken: "shpat_test" };

function fetchReturning(nodes: unknown[]): typeof globalThis.fetch {
  return (async () =>
    new Response(JSON.stringify({ data: { nodes } }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof globalThis.fetch;
}

describe("S3 §C — fetchProductsById returns only the asked products (nodes(ids:))", () => {
  it("maps resolved Product nodes and drops null / non-product nodes", async () => {
    const fetchFn = fetchReturning([
      {
        id: "gid://shopify/Product/1",
        title: "Alpha",
        description: "d",
        tags: ["t"],
        availableForSale: true,
        priceRange: { minVariantPrice: { amount: "10.00", currencyCode: "USD" } },
        variants: { nodes: [{ id: "gid://shopify/ProductVariant/11" }] },
      },
      null, // a deleted/delisted id resolves to null
    ]);
    const data = await storefrontFetchByIds(fetchFn)(CREDS, ["gid://shopify/Product/1", "gid://shopify/Product/2"]);
    const products = mapStorefrontToContext("acme", data).products;
    expect(products.map((p) => p.id)).toEqual(["gid://shopify/Product/1"]);
    expect(products[0]!.price).toBe("$10.00");
    expect(products[0]!.variantId).toBe("11");
  });

  it("refuses a non-myshopify host without sending the token (SSRF guard)", async () => {
    const evil: ShopifyStoreCreds = { shopDomain: "evil.example.com", accessToken: "shpat_test" };
    await expect(storefrontFetchByIds(fetchReturning([]))(evil, ["gid://shopify/Product/1"])).rejects.toThrow(/myshopify/);
  });

  it("returns no products for an empty id list without a network call", async () => {
    let called = false;
    const fetchFn = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const data = await storefrontFetchByIds(fetchFn)(CREDS, []);
    expect(mapStorefrontToContext("acme", data).products).toEqual([]);
    expect(called).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `env -u GOOGLE_CLOUD_PROJECT pnpm exec vitest run packages/widget-backend/test/shopify-grounding-by-id.test.ts`
Expected: FAIL — `storefrontFetchByIds` is not exported.

- [ ] **Step 3: Add `storefrontFetchByIds`** — `packages/widget-backend/src/shopify-grounding.ts` (after `storefrontShellFetch`, ~434)

```ts
/** By-id product fetch. `nodes(ids:)` returns the products for the given GIDs; a missing/delisted id (or a
 *  non-Product node) resolves to `null` and is dropped. The inline fragment requests the SAME fields as the
 *  page query so `mapStorefrontToContext` maps the result identically. */
export const STOREFRONT_NODES_QUERY = `query PalUpGroundingByIds($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on Product { id title description tags availableForSale priceRange { minVariantPrice { amount currencyCode } } variants(first: 1) { nodes { id } } }
  }
}`;

export type StorefrontByIdFetch = (creds: ShopifyStoreCreds, ids: string[]) => Promise<StorefrontData>;

/**
 * S3 §C — fetch ONLY the named products by Storefront GID, so a webhook can refresh exactly the SKUs that
 * changed instead of paging the whole catalog. Returns the same `StorefrontData` shape the pagination path
 * does (`{ products: { nodes } }`) so it flows through `mapStorefrontToContext` unchanged. Same host guard +
 * private-token header + per-request timeout as `storefrontFetch`; the token never leaves this path and is
 * never logged.
 */
export function storefrontFetchByIds(
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
  opts: { version?: string; timeoutMs?: number; log?: (info: StorefrontEgressLog) => void } = {},
): StorefrontByIdFetch {
  const version = opts.version ?? STOREFRONT_API_VERSION;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PAGE_TIMEOUT_MS;
  const log = opts.log ?? ((info: StorefrontEgressLog) => console.log("[grounding.shopify] " + JSON.stringify(info)));
  return async (creds, ids) => {
    if (ids.length === 0) return { products: { nodes: [] } };
    if (!SHOP_HOST.test(creds.shopDomain)) {
      throw new Error("refusing Shopify fetch: shopDomain is not a *.myshopify.com host"); // never leak the token
    }
    const url = `https://${creds.shopDomain}/api/${version}/graphql.json`;
    const start = Date.now();
    let status = 0;
    let ok = false;
    let nodeCount: number | undefined;
    try {
      const res = await fetchFn(url, {
        method: "POST",
        headers: { "content-type": "application/json", "Shopify-Storefront-Private-Token": creds.accessToken },
        body: JSON.stringify({ query: STOREFRONT_NODES_QUERY, variables: { ids } }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      status = res.status;
      ok = res.ok;
      if (!res.ok) throw new Error("Shopify Storefront API request failed"); // static; caching wrapper degrades
      const json = (await res.json()) as { data?: { nodes?: (StorefrontProductNode | null)[] }; errors?: Array<{ message?: string }> };
      if (Array.isArray(json.errors) && json.errors.length) throw new Error("Shopify Storefront GraphQL error");
      const nodes = (json.data?.nodes ?? []).filter((n): n is StorefrontProductNode => n != null && typeof n.id === "string");
      nodeCount = nodes.length;
      return { products: { nodes } };
    } finally {
      try {
        log({ host: creds.shopDomain, status, ok, ms: Date.now() - start, page: 0, nodes: nodeCount });
      } catch {
        /* ignore logging errors */
      }
    }
  };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `env -u GOOGLE_CLOUD_PROJECT pnpm exec vitest run packages/widget-backend/test/shopify-grounding-by-id.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/widget-backend/src/shopify-grounding.ts packages/widget-backend/test/shopify-grounding-by-id.test.ts
git commit -m "feat(grounding): storefrontFetchByIds via Storefront nodes(ids:) (S3 §C)"
```

---

## Task 5: Targeted `reconcileProducts` path (fetch+embed+upsert+ledger touching only the changed set)

**Files:**
- Modify: `packages/widget-backend/src/jobs/catalog-index.ts` (add `CatalogByIdSource`, `reconcileProducts`, `shopifyCatalogByIdSource`; add `catalogById?` to `CatalogIndexDeps`)
- Modify: `packages/widget-backend/src/catalog-webhook-queue.ts` (`subscribeCatalogReconcile` passes `{ productIds, reason }`)
- Modify: `packages/widget-backend/src/routes/pubsub-push.ts` (`reconcile` gains an opts arg; decode `message.data` for productIds/reason, fail-safe to full)
- Modify: `packages/widget-backend/src/server.ts` (wire `catalogById`; make the composed `reconcile` targeted; pass through both consume + publish paths — `~1056-1124`)
- Test: `packages/widget-backend/test/catalog-index-targeted.test.ts`

**Interfaces:**
- Consumes: `readCorpusLedger`, `listLedgerChunkKeys` (Task 1); `ReconcileReason` (Task 3); `storefrontFetchByIds` (Task 4); `productFactsFrom`, `productEmbedText`, `catalogRecordId`, `catalogNamespace`, `CATALOG_CORPUS_PURPOSE`, `checkHalts`, `pinMismatch` (module-private, same file).
- Produces:
  - `type CatalogByIdSource = (tenantId: string, ids: string[]) => Promise<Product[] | undefined>`
  - `CatalogIndexDeps.catalogById?: CatalogByIdSource`
  - `reconcileProducts(deps: CatalogIndexDeps, tenantId: string, productIds: string[], opts?: { reason?: ReconcileReason }): Promise<TenantIndexReport>`
  - `shopifyCatalogByIdSource(secrets, fetchImpl?, domains?): CatalogByIdSource`
  - `subscribeCatalogReconcile(queue, reconcile: (tenantId: string, opts?: { productIds?: string[]; reason?: ReconcileReason }) => Promise<void>)`

**Design (spec §C):** `productIds` present → fetch only those; re-embed + upsert; update their ledger entries + ProductFacts; `deleteById` any that came back missing/delisted. **No full-catalog crawl.** A product topic with a delete intent is handled by "id requested but not returned by the fetch" → prune. If there is **no manifest yet** (corpus never built), `reconcileProducts` delegates to a full `runCatalogIndex` — a stray early webhook must never create a 1-product corpus. A pin mismatch returns `pin-mismatch` without writing.

- [ ] **Step 1: Write the failing targeted-reconcile test** — `packages/widget-backend/test/catalog-index-targeted.test.ts`

```ts
import { describe, it, expect, vi } from "vitest";
import {
  InMemoryRuntimeStore,
  createInMemoryVectorStore,
  createInMemoryProductFactsStore,
  requireEmbedInputs,
  type EmbedRequest,
  type EmbedResponse,
  type GroundingContext,
  type ModelPort,
  type Product,
} from "@palup/platform-ports";
import {
  runCatalogIndex,
  reconcileProducts,
  catalogNamespace,
  catalogRecordId,
  type CatalogSource,
  type CatalogByIdSource,
} from "../src/jobs/catalog-index.js";
import { readCorpusLedger } from "../src/jobs/catalog-ledger.js";

function fakeModel(dimension = 4, model = "fake-embed-4d"): ModelPort {
  return {
    async complete() {
      return { text: "ok", model };
    },
    async embed(req: EmbedRequest): Promise<EmbedResponse> {
      requireEmbedInputs(req);
      const vectors = req.texts.map((t) => {
        const v = new Array(dimension).fill(0);
        for (let i = 0; i < t.length; i++) v[i % dimension] += t.charCodeAt(i) % 7;
        return v;
      });
      return { vectors, model, dimension, purpose: req.purpose };
    },
  };
}
const P = (id: string, title: string, price = "$10"): Product => ({ id, title, description: `${title} d`, price, tags: [title], availableForSale: true });
const A = P("gid://shopify/Product/1", "alpha");
const B = P("gid://shopify/Product/2", "beta");
const C = P("gid://shopify/Product/3", "gamma");
const fullCatalog = (ps: Product[]): CatalogSource => async (t): Promise<GroundingContext> => ({ tenantId: t, brandName: "Acme", products: ps, policy: { returns: "", shipping: "" } });

describe("S3 §C — reconcileProducts touches ONLY the changed set", () => {
  it("upserts only the named product and leaves every other row untouched", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const model = fakeModel();
    await runCatalogIndex({ store, vector, model, catalog: fullCatalog([A, B, C]) }, ["acme"]);

    const upsertSpy = vi.spyOn(vector, "upsert");
    const Bx = P("gid://shopify/Product/2", "beta-updated", "$12");
    const catalogById: CatalogByIdSource = async () => [Bx];
    const facts = createInMemoryProductFactsStore();

    const r = await reconcileProducts({ store, vector, model, catalog: fullCatalog([A, Bx, C]), catalogById, productFacts: facts }, "acme", [B.id], {
      reason: "product",
    });

    expect(r.outcome).toBe("indexed");
    expect(r.embedded).toBe(1);
    const upsertedIds = upsertSpy.mock.calls.flatMap(([, recs]) => recs.map((x) => x.id));
    expect(upsertedIds).toEqual([catalogRecordId(B.id)]);
    // Ledger still has all three; B's hash changed.
    expect((await readCorpusLedger(store, "acme")).size).toBe(3);
    // ProductFacts refreshed for B only.
    expect((await facts.getMany("acme", [B.id]))[0]!.price).toBe("$12");
    expect(await facts.getMany("acme", [A.id])).toEqual([]);
  });

  it("a delisted id (not returned by fetch) is deleteById'd and dropped from the ledger, no whole-catalog crawl", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const model = fakeModel();
    await runCatalogIndex({ store, vector, model, catalog: fullCatalog([A, B, C]) }, ["acme"]);

    const deleteSpy = vi.spyOn(vector, "deleteById");
    const catalogById: CatalogByIdSource = async () => []; // C resolved to nothing => delisted
    const catalogSpy = vi.fn(fullCatalog([A, B]));

    const r = await reconcileProducts({ store, vector, model, catalog: catalogSpy, catalogById }, "acme", [C.id], { reason: "product" });

    expect(r.outcome).toBe("indexed");
    expect(r.removed).toBe(1);
    expect(deleteSpy.mock.calls.flatMap((c) => c[1])).toEqual([catalogRecordId(C.id)]);
    expect(catalogSpy).not.toHaveBeenCalled(); // NEVER fell back to a full crawl
    const ledger = await readCorpusLedger(store, "acme");
    expect([...ledger.keys()].sort()).toEqual([catalogRecordId(A.id), catalogRecordId(B.id)]);
  });

  it("with no manifest yet, falls back to a full reconcile (never a 1-product corpus)", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const model = fakeModel();
    const catalogById = vi.fn(async () => [B]);
    const r = await reconcileProducts({ store, vector, model, catalog: fullCatalog([A, B, C]), catalogById }, "acme", [B.id], { reason: "product" });
    expect(r.outcome).toBe("indexed");
    expect(r.products).toBe(3); // the whole catalog, not just B
    expect(catalogById).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `env -u GOOGLE_CLOUD_PROJECT pnpm exec vitest run packages/widget-backend/test/catalog-index-targeted.test.ts`
Expected: FAIL — `reconcileProducts`/`CatalogByIdSource` are not exported.

- [ ] **Step 3: Add `CatalogByIdSource` + the deps field + `reconcileProducts`** — `packages/widget-backend/src/jobs/catalog-index.ts`

Add the import for the by-id fetch + reason type:

```ts
import { createShopifyGroundingAdapter, MAX_CATALOG_PRODUCTS, MAX_INDEX_CATALOG_PAGES, STOREFRONT_PAGE_SIZE, storefrontFetch, storefrontFetchByIds, type StorefrontByIdFetch, type StorefrontFetch } from "../shopify-grounding.js";
import type { ReconcileReason } from "../catalog-webhook-queue.js";
```

Add the type + deps field:

```ts
/** Resolve ONLY the named products (by corpus GID), or `undefined` when the tenant has no store. Missing/
 *  delisted ids simply do not appear in the returned array (the caller treats those as deletions). */
export type CatalogByIdSource = (tenantId: string, ids: string[]) => Promise<Product[] | undefined>;
```

In `CatalogIndexDeps`, add after `catalog: CatalogSource;`:

```ts
  /** S3 §C — by-id source for the TARGETED reconcile path (webhook-driven). Absent ⇒ reconcileProducts can
   *  only fall back to the full `catalog` crawl. */
  catalogById?: CatalogByIdSource;
```

Add the targeted reconcile function (after `runCatalogIndex`, ~820):

```ts
/**
 * S3 §C — refresh ONLY the named SKUs. Fetches them by id, re-embeds + upserts them, refreshes their
 * ProductFacts + ledger entries, and `deleteById`s any that came back missing (delisted). Touches NO other
 * corpus row and NEVER pages the whole catalog. Guards, in order: halt/cap, embed-capability, an existing
 * manifest (no manifest ⇒ the corpus was never built ⇒ delegate to a full `runCatalogIndex`, never leave a
 * one-product corpus), and the {model,dimension,purpose} pin. All writes go through the SAME
 * `writeManifestAndAudit` (ledger+manifest+audit in one tx) the full path uses.
 */
export async function reconcileProducts(
  deps: CatalogIndexDeps,
  tenantId: string,
  productIds: string[],
  opts: { reason?: ReconcileReason } = {},
): Promise<TenantIndexReport> {
  const ns = catalogNamespace(tenantId);
  const ctx = { tenantId };
  const now = deps.now ?? (() => new Date());

  const halted = await checkHalts(deps, tenantId);
  if (halted) return { tenantId, outcome: halted };
  if (!canEmbed(deps.model)) return { tenantId, outcome: "no-embed-capability" };

  const manifest = await deps.store.get<CatalogManifest>(ctx, MANIFEST_COLLECTION, MANIFEST_KEY);
  // No manifest / no purpose / no by-id source / uninformative id list ⇒ do the safe whole-catalog reconcile.
  if (!manifest || !manifest.purpose || !deps.catalogById || productIds.length === 0) {
    const [report] = await runCatalogIndex(deps, [tenantId], {});
    return report!;
  }

  const recordIds = productIds.map(catalogRecordId);
  const requested = new Set(recordIds);

  const fetched = await deps.catalogById(tenantId, productIds);
  if (fetched === undefined) return { tenantId, outcome: "not-configured" };
  const plan = planProducts(fetched); // reuses the empty-text/duplicate refusals

  // A requested id that did NOT come back is delisted → prune it.
  const returnedRecordIds = new Set(plan.map((p) => p.recordId));
  const stale = [...requested].filter((id) => !returnedRecordIds.has(id));

  const priorChunkKeys = await listLedgerChunkKeys(deps.store, tenantId);
  const ledger = await readCorpusLedger(deps.store, tenantId);

  // Only re-embed the ones whose content actually changed (content-hash optimization, same as the full path).
  const toEmbed = plan.filter((p) => ledger.get(p.recordId) !== p.hash);

  // ── embed only the changed set ──
  const vectors = new Map<string, number[]>();
  let pin: CorpusPin | undefined;
  for (let i = 0; i < toEmbed.length; i += Math.max(1, Math.floor(DEFAULT_EMBED_BATCH))) {
    const stop = await checkHalts(deps, tenantId);
    if (stop) return { tenantId, outcome: stop };
    const batch = toEmbed.slice(i, i + DEFAULT_EMBED_BATCH);
    const req = { texts: batch.map((p) => p.text), purpose: CATALOG_CORPUS_PURPOSE, tenantId };
    const res = await deps.model.embed(req);
    requireEmbedAlignment(req, res);
    if (!pin) {
      const mismatch = pinMismatch(manifest, res);
      if (mismatch) {
        return { tenantId, outcome: "pin-mismatch", products: plan.length, embedded: req.texts.length, model: res.model, dimension: res.dimension, reason: mismatch };
      }
      pin = { model: res.model, dimension: res.dimension, purpose: res.purpose };
    } else if (res.model !== pin.model || res.dimension !== pin.dimension || res.purpose !== pin.purpose) {
      throw new CatalogRefusal("failed", `the embedder changed from ${describePin(pin)} to ${describePin(res)} mid-run — refusing to write a corpus of two vector spaces`);
    }
    batch.forEach((p, j) => vectors.set(p.recordId, res.vectors[j]!));
  }

  // ── write only the changed set ──
  const byId = new Map(fetched.map((p) => [p.id, p]));
  const records: VectorRecord[] = toEmbed.map((p) => {
    const src = byId.get(p.productId);
    return {
      id: p.recordId,
      vector: vectors.get(p.recordId)!,
      metadata: { kind: "product", productId: p.productId, contentHash: p.hash, title: src?.title ?? "", ...(src?.variantId ? { variantId: src.variantId } : {}) },
    };
  });
  if (records.length > 0) await deps.vector.upsert(ns, records);
  if (stale.length > 0) await deps.vector.deleteById(ns, stale);

  // Tier-2 money-facts for the refreshed subset (D2 poll-side, same as the full path). Fail-safe: the
  // vector write is primary, a facts failure is alerted + swallowed.
  if (deps.productFacts && fetched.length > 0) {
    try {
      await deps.productFacts.upsertMany(tenantId, productFactsFrom({ tenantId, brandName: "", products: fetched, policy: { returns: "", shipping: "" } }, now()));
    } catch (e) {
      console.error(`[catalog] ALERT product_facts_upsert_failed tenant=${tenantId} error=${e instanceof Error ? e.constructor.name : typeof e} msg=${(e as Error).message}`);
    }
  }

  // New ledger = old ledger, plus the refreshed hashes, minus the pruned ids.
  const newLedger = new Map(ledger);
  for (const p of plan) newLedger.set(p.recordId, p.hash);
  for (const id of stale) newLedger.delete(id);

  const effectivePin: CorpusPin = pin ?? { model: manifest.model, dimension: manifest.dimension, purpose: manifest.purpose };
  const written: CatalogManifest = {
    model: effectivePin.model,
    dimension: effectivePin.dimension,
    purpose: effectivePin.purpose,
    products: newLedger.size,
    at: now().toISOString(),
    ceiling: manifest.ceiling,
  };
  await writeManifestAndAudit(
    deps,
    tenantId,
    written,
    { products: plan.length, embedded: toEmbed.length, written: records.length, removed: stale.length, reindex: false, repaired: false },
    { entries: newLedger, priorChunkKeys },
  );

  return { tenantId, outcome: "indexed", products: plan.length, embedded: toEmbed.length, written: records.length, removed: stale.length, model: written.model, dimension: written.dimension };
}

/** Shopify wiring for the by-id source (composition root). Mirrors `shopifyCatalogSource`. */
export function shopifyCatalogByIdSource(
  secrets: SecretsPort,
  fetchImpl: StorefrontByIdFetch = storefrontFetchByIds(globalThis.fetch),
  domains: Record<string, string> = parseStoreDomains(),
): CatalogByIdSource {
  return async (tenantId, ids) => {
    const creds = await resolveShopifyStore(tenantId, secrets, domains);
    if (!creds) return undefined;
    const data = await fetchImpl(creds, ids);
    return mapStorefrontToContext(tenantId, data).products;
  };
}
```

Add `mapStorefrontToContext` to the shopify-grounding import if not already imported (it is used only by the new function). Verify `describePin`, `pinMismatch`, `CorpusPin`, `planProducts`, `productFactsFrom`, `requireEmbedAlignment`, `VectorRecord` are all in scope (they are — same file / existing imports).

- [ ] **Step 4: Run the targeted test to verify it passes**

Run: `env -u GOOGLE_CLOUD_PROJECT pnpm exec vitest run packages/widget-backend/test/catalog-index-targeted.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Extend the queue consumer signature** — `packages/widget-backend/src/catalog-webhook-queue.ts`

```ts
export function subscribeCatalogReconcile(
  queue: QueuePort,
  reconcile: (tenantId: string, opts?: { productIds?: string[]; reason?: ReconcileReason }) => Promise<void>,
): QueueSubscription {
  return queue.subscribe(CATALOG_RECONCILE_TOPIC, CATALOG_RECONCILE_GROUP, async (msg) => {
    const payload = msg.payload as { tenantId?: unknown; productIds?: unknown; reason?: unknown } | undefined;
    const tenantId = payload?.tenantId;
    if (typeof tenantId !== "string" || !tenantId.trim()) return;
    const productIds = Array.isArray(payload?.productIds) ? payload!.productIds.filter((x): x is string => typeof x === "string") : undefined;
    const reason = payload?.reason === "product" || payload?.reason === "inventory" || payload?.reason === "full" ? payload.reason : undefined;
    await reconcile(tenantId, { ...(productIds && productIds.length > 0 ? { productIds } : {}), ...(reason ? { reason } : {}) });
  });
}
```

- [ ] **Step 6: Make the Pub/Sub push route targeted (fail-safe to full)** — `packages/widget-backend/src/routes/pubsub-push.ts`

Change the `reconcile` dep type and decode `message.data`:

```ts
  reconcile: (tenantId: string, opts?: { productIds?: string[]; reason?: "product" | "inventory" | "full" }) => Promise<void>;
```

Extend `PushEnvelope` to include `data?: string` and, after resolving `tenantId`, decode the base64 JSON payload (fail-safe — a malformed body just means a full reconcile):

```ts
interface PushEnvelope {
  message?: { attributes?: Record<string, unknown>; data?: string };
}
```

```ts
    // Decode the (server-authored) payload for targeting. NEVER trusted for product CONTENT — only which
    // ids to re-FETCH; the worker re-derives current state. A malformed/absent body ⇒ a full reconcile.
    let opts: { productIds?: string[]; reason?: "product" | "inventory" | "full" } | undefined;
    try {
      const raw = body?.message?.data;
      if (typeof raw === "string" && raw.length > 0) {
        const p = JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as { productIds?: unknown; reason?: unknown };
        const productIds = Array.isArray(p.productIds) ? p.productIds.filter((x): x is string => typeof x === "string") : undefined;
        const reason = p.reason === "product" || p.reason === "inventory" || p.reason === "full" ? p.reason : undefined;
        opts = { ...(productIds && productIds.length > 0 ? { productIds } : {}), ...(reason ? { reason } : {}) };
      }
    } catch {
      opts = undefined; // fall back to a full reconcile
    }

    try {
      await deps.reconcile(tenantId, opts);
```

- [ ] **Step 7: Wire the composition root** — `packages/widget-backend/src/server.ts` (`~1062-1071`)

Add `catalogById` to `reconcileDeps` and make the composed `reconcile` targeted:

```ts
    const reconcileDeps = {
      store,
      vector: vectorPort,
      model: createMeteringModelPort(activeModelPort, telemetry, { agentType: "catalog-index" }),
      catalog: shopifyCatalogSource(secrets),
      catalogById: shopifyCatalogByIdSource(secrets),
      productFacts: factsStore,
    };
    // S3 §C — targeted when the message named product ids; a full reconcile otherwise (the backstop path).
    const reconcile = async (tenantId: string, o?: { productIds?: string[]; reason?: ReconcileReason }) => {
      if (o?.productIds && o.productIds.length > 0 && o.reason !== "full") {
        await reconcileProducts(reconcileDeps, tenantId, o.productIds, { ...(o.reason ? { reason: o.reason } : {}) });
      } else {
        await runCatalogIndex(reconcileDeps, [tenantId], {});
      }
    };
```

Add `reconcileProducts`, `shopifyCatalogByIdSource` to the `catalog-index.js` import and `ReconcileReason` to the `catalog-webhook-queue.js` import in server.ts.

- [ ] **Step 8: Run the affected suites + typecheck**

Run: `env -u GOOGLE_CLOUD_PROJECT pnpm exec vitest run packages/widget-backend/test/catalog-index-targeted.test.ts packages/widget-backend/test/catalog-webhook-queue.test.ts packages/widget-backend/test/pubsub-push.test.ts && env -u GOOGLE_CLOUD_PROJECT pnpm -w exec tsc -b`
Expected: PASS + clean typecheck. If `pubsub-push.test.ts` asserted the old `reconcile(tenantId)` arity, update it to the new `(tenantId, opts?)` signature.

- [ ] **Step 9: Commit**

```bash
git add packages/widget-backend/src/jobs/catalog-index.ts packages/widget-backend/src/catalog-webhook-queue.ts packages/widget-backend/src/routes/pubsub-push.ts packages/widget-backend/src/server.ts packages/widget-backend/test/catalog-index-targeted.test.ts
git commit -m "feat(catalog-index): targeted by-id reconcile from webhooks; no full crawl per change (S3 §C, ships dark)"
```

---

## Task 6: Per-tenant coalesce/debounce

**Files:**
- Create: `packages/widget-backend/src/catalog-reconcile-coalescer.ts`
- Modify: `packages/widget-backend/src/catalog-webhook-queue.ts` (route the in-memory subscribe through the coalescer)
- Modify: `packages/widget-backend/src/server.ts` (construct the coalescer for the in-memory queue path; read `CATALOG_RECONCILE_COALESCE_MS`)
- Test: `packages/widget-backend/test/catalog-reconcile-coalescer.test.ts`

**Interfaces:**
- Produces:
  - `CATALOG_RECONCILE_COALESCE_MS_DEFAULT = 5_000`, `CATALOG_RECONCILE_MAX_IDS = 500`
  - `interface ReconcileCoalescer { enqueue(tenantId: string, req: { productIds?: string[]; reason: ReconcileReason }): void; flush(tenantId?: string): Promise<void> }`
  - `createReconcileCoalescer(reconcile, opts?): ReconcileCoalescer` — batches per tenant over `windowMs`; caps ids at `maxIds` (over cap ⇒ spill to a full reconcile); `inventory`-only batches trigger NO reconcile (covered by §D ceiling + §E backstop); a `full`/over-cap batch runs one full reconcile.

**Scope note:** the coalescer wraps the reconcile used by the **in-memory queue** consumer (dev/staging synchronous path) — the one that most needs debouncing because a burst of publishes would otherwise fan out to N synchronous reconciles. The durable Pub/Sub path reconciles per delivery (already targeted, Task 5); cross-delivery coalescing there is an operational/S4 concern (Pub/Sub has its own batching + ack deadline). State this in the coalescer's doc comment.

- [ ] **Step 1: Write the failing test** — `packages/widget-backend/test/catalog-reconcile-coalescer.test.ts`

```ts
import { describe, it, expect, vi } from "vitest";
import { createReconcileCoalescer, CATALOG_RECONCILE_MAX_IDS } from "../src/catalog-reconcile-coalescer.js";

describe("S3 §C — per-tenant coalesce/debounce", () => {
  it("collapses a burst of product ids into ONE batched reconcile with a deduped id set", async () => {
    const reconcile = vi.fn(async () => {});
    const c = createReconcileCoalescer(reconcile, { windowMs: 50 });
    for (let i = 0; i < 50; i++) c.enqueue("acme", { productIds: [`gid://shopify/Product/${i % 10}`], reason: "product" });
    await c.flush("acme");
    expect(reconcile).toHaveBeenCalledTimes(1);
    const [tenant, opts] = reconcile.mock.calls[0]!;
    expect(tenant).toBe("acme");
    expect(new Set(opts.productIds).size).toBe(10); // deduped
    expect(opts.reason).toBe("product");
  });

  it("spills to a FULL reconcile above the id cap", async () => {
    const reconcile = vi.fn(async () => {});
    const c = createReconcileCoalescer(reconcile, { windowMs: 50 });
    for (let i = 0; i <= CATALOG_RECONCILE_MAX_IDS; i++) c.enqueue("acme", { productIds: [`gid://shopify/Product/${i}`], reason: "product" });
    await c.flush("acme");
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(reconcile.mock.calls[0]![1]).toMatchObject({ reason: "full" });
    expect(reconcile.mock.calls[0]![1].productIds).toBeUndefined();
  });

  it("an inventory-only batch triggers NO reconcile (covered by the serve-time ceiling + hourly backstop)", async () => {
    const reconcile = vi.fn(async () => {});
    const c = createReconcileCoalescer(reconcile, { windowMs: 50 });
    c.enqueue("acme", { reason: "inventory" });
    c.enqueue("acme", { reason: "inventory" });
    await c.flush("acme");
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("keeps tenants isolated (separate batches)", async () => {
    const reconcile = vi.fn(async () => {});
    const c = createReconcileCoalescer(reconcile, { windowMs: 50 });
    c.enqueue("a", { productIds: ["gid://shopify/Product/1"], reason: "product" });
    c.enqueue("b", { productIds: ["gid://shopify/Product/2"], reason: "product" });
    await c.flush();
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(new Set(reconcile.mock.calls.map((c2) => c2[0]))).toEqual(new Set(["a", "b"]));
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `env -u GOOGLE_CLOUD_PROJECT pnpm exec vitest run packages/widget-backend/test/catalog-reconcile-coalescer.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the coalescer** — `packages/widget-backend/src/catalog-reconcile-coalescer.ts`

```ts
import type { ReconcileReason } from "./catalog-webhook-queue.js";

// S3 §C — per-tenant coalesce/debounce. A bulk edit fires many webhooks; without this, each becomes its own
// reconcile. This accumulates changed ids per tenant over a short window and processes them as ONE batch,
// deduped by id and capped (over the cap ⇒ spill to a full reconcile — cheaper than a giant nodes(ids:)).
//
// SCOPE: wraps the reconcile used by the IN-MEMORY queue consumer (dev/staging synchronous delivery), the
// path that most needs debouncing. The durable Pub/Sub path reconciles per delivery (already targeted);
// cross-delivery coalescing there is an operational/S4 concern (Pub/Sub batches + has an ack deadline).

export const CATALOG_RECONCILE_COALESCE_MS_DEFAULT = 5_000;
/** Above this many distinct ids in one window, a targeted fetch is no cheaper than a full reconcile. */
export const CATALOG_RECONCILE_MAX_IDS = 500;

export interface ReconcileCoalescer {
  enqueue(tenantId: string, req: { productIds?: string[]; reason: ReconcileReason }): void;
  /** Flush now (a specific tenant, or all) — for shutdown and deterministic tests. */
  flush(tenantId?: string): Promise<void>;
}

interface Pending {
  ids: Set<string>;
  forceFull: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export function createReconcileCoalescer(
  reconcile: (tenantId: string, opts: { productIds?: string[]; reason: ReconcileReason }) => Promise<void>,
  opts: { windowMs?: number; maxIds?: number } = {},
): ReconcileCoalescer {
  const windowMs = Math.max(0, Math.floor(opts.windowMs ?? CATALOG_RECONCILE_COALESCE_MS_DEFAULT));
  const maxIds = Math.max(1, Math.floor(opts.maxIds ?? CATALOG_RECONCILE_MAX_IDS));
  const pending = new Map<string, Pending>();

  const runFlush = async (tenantId: string): Promise<void> => {
    const p = pending.get(tenantId);
    if (!p) return;
    if (p.timer) clearTimeout(p.timer);
    pending.delete(tenantId);
    if (p.forceFull) {
      await reconcile(tenantId, { reason: "full" });
      return;
    }
    if (p.ids.size === 0) return; // inventory-only (or empty) batch: no crawl — §D ceiling + §E backstop cover it
    await reconcile(tenantId, { productIds: [...p.ids], reason: "product" });
  };

  return {
    enqueue(tenantId, req) {
      let p = pending.get(tenantId);
      if (!p) {
        p = { ids: new Set(), forceFull: false, timer: undefined };
        pending.set(tenantId, p);
      }
      if (req.reason === "full") p.forceFull = true;
      if (req.reason === "product") for (const id of req.productIds ?? []) p.ids.add(id);
      // reason === "inventory" contributes nothing to the fetch set and does not force a full reconcile.
      if (p.ids.size > maxIds) p.forceFull = true;
      if (!p.timer) p.timer = setTimeout(() => void runFlush(tenantId), windowMs);
    },
    async flush(tenantId) {
      if (tenantId) return runFlush(tenantId);
      await Promise.all([...pending.keys()].map((t) => runFlush(t)));
    },
  };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `env -u GOOGLE_CLOUD_PROJECT pnpm exec vitest run packages/widget-backend/test/catalog-reconcile-coalescer.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Route the in-memory subscribe path through the coalescer** — `packages/widget-backend/src/server.ts`

In the `else` branch that builds the in-memory queue (`~1115-1123`), wrap the reconcile in a coalescer:

```ts
      } else {
        const COALESCE_MS = posInt("CATALOG_RECONCILE_COALESCE_MS", CATALOG_RECONCILE_COALESCE_MS_DEFAULT);
        const coalescer = createReconcileCoalescer((tenantId, o) => reconcile(tenantId, o), { windowMs: COALESCE_MS });
        catalogQueue = createInMemoryQueue({});
        subscribeCatalogReconcile(catalogQueue, async (tenantId, o) => {
          coalescer.enqueue(tenantId, { ...(o?.productIds ? { productIds: o.productIds } : {}), reason: o?.reason ?? "full" });
        });
        console.warn(
          "[config] CATALOG_WEBHOOKS is ON with the IN-MEMORY queue (dev/staging only): deliveries COALESCE per " +
            `tenant over ${COALESCE_MS}ms then reconcile once. Set PUBSUB_CATALOG_TOPIC + PUBSUB_PUSH_SERVICE_ACCOUNT + ` +
            "PUBSUB_PUSH_AUDIENCE for the durable async path before any real deployment.",
        );
      }
```

Add the import: `import { createReconcileCoalescer, CATALOG_RECONCILE_COALESCE_MS_DEFAULT } from "./catalog-reconcile-coalescer.js";`

- [ ] **Step 6: Typecheck + run the queue/coalescer suites**

Run: `env -u GOOGLE_CLOUD_PROJECT pnpm exec vitest run packages/widget-backend/test/catalog-reconcile-coalescer.test.ts packages/widget-backend/test/catalog-webhook-queue.test.ts && env -u GOOGLE_CLOUD_PROJECT pnpm -w exec tsc -b`
Expected: PASS + clean typecheck.

- [ ] **Step 7: Commit**

```bash
git add packages/widget-backend/src/catalog-reconcile-coalescer.ts packages/widget-backend/src/catalog-webhook-queue.ts packages/widget-backend/src/server.ts packages/widget-backend/test/catalog-reconcile-coalescer.test.ts
git commit -m "feat(catalog-webhooks): per-tenant coalesce/debounce; cap spills to full (S3 §C, ships dark)"
```

---

## Task 7: Serve-time staleness ceiling ≤15 min (fail-honest) + clear the D2 blocker

**Files:**
- Modify: `packages/widget-backend/src/server.ts` (`PRODUCT_FACTS_MAX_AGE_MS` default `3_600_000` → `900_000`, `~600`)
- Modify: `packages/widget-brain/src/hydrate-facts.ts` (clear the D2 promotion-blocker note, `~22-30`)
- Test: `packages/widget-brain/test/hydrate-facts.test.ts` (extend — 14 min quotes, 16 min sentinel)

**Interfaces:**
- Consumes: `hydrateProductFacts(products, facts, staleness?)` with `HydrationStaleness = { now: Date; maxAgeMs: number }` (unchanged). The brain already passes `{ now, maxAgeMs }` whenever hydration is on and `productFactsMaxAgeMs !== undefined`; `PRODUCT_FACTS_MAX_AGE_MS = posInt(...)` is always a number, so the window is always applied on the serve path. **Do NOT flip `PRODUCT_FACTS_HYDRATION`.**

- [ ] **Step 1: Write the failing test** — extend `packages/widget-brain/test/hydrate-facts.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { hydrateProductFacts } from "../src/hydrate-facts.js";
import type { Product } from "@palup/platform-ports";

describe("S3 §D — 15-minute serve-time staleness ceiling (fail-honest)", () => {
  const now = new Date("2026-08-16T12:00:00.000Z");
  const CEILING_15_MIN = 900_000;
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
  const prod = (over: Partial<Product> = {}): Product => ({ id: "serum-vc", title: "Vitamin C", description: "d", price: "$34", tags: [], availableForSale: true, ...over });

  it("a fact 14 minutes old is still quoted", () => {
    const out = hydrateProductFacts([prod()], [{ productId: "serum-vc", price: "$29", availableForSale: true, updatedAt: ago(14 * 60_000) }], { now, maxAgeMs: CEILING_15_MIN });
    expect(out[0]!.price).toBe("$29");
    expect(out[0]!.priceConfirmed).not.toBe(false);
  });

  it("a fact 16 minutes old is NOT quoted — priceConfirmed:false and availability dropped", () => {
    const out = hydrateProductFacts([prod()], [{ productId: "serum-vc", price: "$29", availableForSale: true, updatedAt: ago(16 * 60_000) }], { now, maxAgeMs: CEILING_15_MIN });
    expect(out[0]!.priceConfirmed).toBe(false);
    expect(out[0]!.availableForSale).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to verify it passes (already-built ceiling) OR fails**

Run: `env -u GOOGLE_CLOUD_PROJECT pnpm exec vitest run packages/widget-brain/test/hydrate-facts.test.ts -t "15-minute serve-time"`
Expected: PASS — the D2 ceiling logic already exists in `hydrateProductFacts`; these tests lock the 15-min semantics as an acceptance criterion. (If the second case shows `availableForSale: true`, the ceiling regressed — fix `hydrate-facts.ts` so a stale fact drops availability, per its own doc.)

- [ ] **Step 3: Change the server default to 15 minutes** — `packages/widget-backend/src/server.ts:600`

```ts
  // A1b/D2 — hard staleness ceiling (ms) for hydrated Tier-2 facts. Default 15 MIN (S3 §D): a fact older than
  // this (or with no updatedAt) is NOT quoted — the agent offers to confirm rather than quote a stale number
  // (money/NN#1 fail-honest). This is the money safety net, independent of webhook/scheduler reliability.
  const PRODUCT_FACTS_MAX_AGE_MS = posInt("PRODUCT_FACTS_MAX_AGE_MS", 900_000);
```

- [ ] **Step 4: Clear the D2 promotion-blocker note** — `packages/widget-brain/src/hydrate-facts.ts:22-30`

Replace the `PROMOTION BLOCKER — READ BEFORE ENABLING` paragraph with a resolved note (record the precondition, do not flip the flag):

```ts
// D2 STALENESS CEILING — LANDED (S3 §D). The overlay honours a hard staleness ceiling: when `staleness`
// is supplied, a fact older than `maxAgeMs` (or with no/invalid `updatedAt`) is NOT quoted — it renders
// `priceConfirmed:false` and drops availability, so serving says "let me confirm current price" rather than
// quote a stale number (money/NN#1 fail-honest). The serve path always supplies the ceiling when hydration
// is on: `PRODUCT_FACTS_MAX_AGE_MS` (server.ts) defaults to 15 min and is always a number, so
// `productFactsMaxAgeMs` is never undefined on the hydration path. The A1b security-review blocker
// ("a stale fact would be quoted verbatim with no upper bound on age") is therefore CLOSED.
//
// STILL A §5 PROMOTION, NOT A FLIP. Enabling PRODUCT_FACTS_HYDRATION in any live stage remains a money/NN#1
// human promotion (eval gate → shadow → canary → named-human approval, HITL §5) with the ≤15-min ceiling in
// force as a recorded pre-shadow acceptance criterion. This code does NOT enable it (flag OFF; and even
// flag-on the store is empty until the A3/S3 producers run). No S3 code flips the flag.
```

- [ ] **Step 5: Confirm no test hardcodes the old server default**

Run: `grep -rn "3_600_000\|3600000" packages/widget-backend/test`
Expected: no server-default assertion (the brain tests that pass `3_600_000` do so as an explicit param and are unaffected). If a widget-backend boot/config test asserts the old 1h default, update it to `900_000`.

- [ ] **Step 6: Run the brain hydrate suites**

Run: `env -u GOOGLE_CLOUD_PROJECT pnpm exec vitest run packages/widget-brain/test/hydrate-facts.test.ts packages/widget-brain/test/hydrate-serving.test.ts`
Expected: PASS (the S2 flag-off goldens stay byte-identical — hydration is still gated).

- [ ] **Step 7: Commit**

```bash
git add packages/widget-backend/src/server.ts packages/widget-brain/src/hydrate-facts.ts packages/widget-brain/test/hydrate-facts.test.ts
git commit -m "feat(serving): tighten serve-time staleness ceiling to 15 min; clear the D2 blocker (S3 §D, flag stays OFF)"
```

---

## Task 8: Scheduled backstop — Cloud Run Job + Cloud Scheduler runbook + deploy-config test

**Files:**
- Modify: `docs/DEPLOY.md` (add the `palup-catalog-index` job runbook, mirroring the retention-sweep section `~810-874`)
- Test: `packages/widget-backend/test/deploy-catalog-index-job.test.ts` (text-assertion, mirroring `deploy-staging-env.test.ts`)

**Interfaces:** none (docs + a config-guard test). The job runs the existing CLI `pnpm catalog:index` (now ANN-safe via Task 2). Do NOT run any `gcloud` command — the applies are jason's.

- [ ] **Step 1: Write the failing deploy-config test** — `packages/widget-backend/test/deploy-catalog-index-job.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// S3 §E — the scheduled backstop's runbook, guarded. Mirrors deploy-staging-env.test.ts: a TEXT assertion
// that the DEPLOY.md runbook still names the job, its command, its cloudsql attachment, its DB secret, the
// least-privilege invoker SA, and the hourly scheduler — and that it adds NO serving flag. It does NOT
// prove a deploy works (only a real `gcloud` apply does); it proves the runbook has not silently lost a
// load-bearing line, the same failure class the sweep runbook has already hit.

const DEPLOY = fileURLToPath(new URL("../../../docs/DEPLOY.md", import.meta.url));
const md = readFileSync(DEPLOY, "utf8");

const REQUIRED_LINES: Array<[fragment: string, why: string]> = [
  ["gcloud run jobs deploy palup-catalog-index", "the Cloud Run Job that runs the backstop reconcile"],
  ["--command pnpm --args index", "overrides the image CMD to run the catalog index CLI"],
  ["--set-cloudsql-instances palup-jason:us-central1:palup-staging", "the same Cloud SQL the backend uses (else a per-process store that dies)"],
  ["DATABASE_URL=palup-staging-database-url:latest", "the durable store secret"],
  ["gcloud iam service-accounts create palup-catalog-index-invoker", "the least-privilege invoker SA"],
  ["--role=\"roles/run.invoker\"", "the ONLY role the invoker gets"],
  ["gcloud scheduler jobs create http palup-catalog-index-hourly", "the hourly Cloud Scheduler trigger"],
  ["palup-catalog-index:run", "the run URI the scheduler POSTs to"],
];

describe("S3 §E — DEPLOY.md carries the catalog-index backstop job runbook", () => {
  it.each(REQUIRED_LINES)("names %s (%s)", (fragment) => {
    expect(md).toContain(fragment);
  });

  it("the catalog-index job section adds NO serving flag", () => {
    const start = md.indexOf("gcloud run jobs deploy palup-catalog-index");
    expect(start).toBeGreaterThan(-1);
    const section = md.slice(start, start + 1600);
    for (const flag of ["CATALOG_RETRIEVAL", "VECTOR_ANN", "PRODUCT_FACTS_HYDRATION", "MEMORY_ADR_ACCEPTED"]) {
      expect(section).not.toContain(flag);
    }
  });

  it("runs hourly (a 5-field cron whose minute is fixed and hour is a wildcard)", () => {
    expect(md).toMatch(/--schedule="\d{1,2} \* \* \* \*"/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `env -u GOOGLE_CLOUD_PROJECT pnpm exec vitest run packages/widget-backend/test/deploy-catalog-index-job.test.ts`
Expected: FAIL — DEPLOY.md has no `palup-catalog-index` section yet.

- [ ] **Step 3: Add the runbook to `docs/DEPLOY.md`** (a new subsection after the retention-sweep one, ~874). Paste this exactly:

````markdown
### Scheduled catalog-index backstop (`palup-catalog-index`) — S3 §E

The ADR-0020 missed-event backstop. Webhooks are the fast path; the 15-min serve-time ceiling is the money
safety net; this hourly full reconcile (now ANN-safe via the S3 ledger) is the missed-event catch-all. It
MAINTAINS THE DARK CORPUS — it spends real Vertex embedding on changed hashes — so **enabling it is a human
cost decision (jason's), not a build agent's**. Nothing here flips a serving flag; serving stays HITL §5.

> Same `/cloudsql/` unix-socket `DATABASE_URL` requirement, and same "REPLACE-set on every deploy" trap, as
> the retention sweep above. A job without the Cloud SQL attachment cannot connect at all.

```bash
# 1. Create the job. `--command pnpm --args index` overrides the image CMD ["pnpm","backend"] to run the
#    catalog index CLI (packages/widget-backend/src/jobs/catalog-index.ts) for every SHOPIFY_STORES tenant.
gcloud run jobs deploy palup-catalog-index \
  --source . --region us-central1 --project palup-jason \
  --command pnpm --args index \
  --set-cloudsql-instances palup-jason:us-central1:palup-staging \
  --set-secrets "DATABASE_URL=palup-staging-database-url:latest,PALUP_SECRETS=palup-secrets:latest" \
  --set-env-vars "^@^SHOPIFY_STORES=demo=palup-skincare-jason.myshopify.com@PALUP_REQUIRE_DATABASE_URL=true@GOOGLE_CLOUD_PROJECT=palup-jason@GOOGLE_CLOUD_LOCATION=us-central1@PALUP_MODEL=<pinned-model-id>"
# NOTE: NO CATALOG_RETRIEVAL / VECTOR_ANN / PRODUCT_FACTS_HYDRATION here — the job WRITES the corpus, it does
# not serve it. Add PRODUCT_FACTS_POLL=true only when the Tier-2 poll producer is intended (money/NN#1 §5).

# 2. Run it once by hand and READ THE OUTPUT before scheduling anything.
gcloud run jobs execute palup-catalog-index --region us-central1 --project palup-jason --wait

# 3. Enable Cloud Scheduler (idempotent; give the API a few minutes to settle — see the sweep's note).
gcloud services enable cloudscheduler.googleapis.com --project palup-jason

# 4. A DEDICATED invoker identity whose ONLY power is starting this one job (mirrors palup-sweep-invoker).
gcloud iam service-accounts create palup-catalog-index-invoker \
  --display-name="Cloud Scheduler invoker for the catalog index backstop" --project palup-jason
gcloud run jobs add-iam-policy-binding palup-catalog-index \
  --region us-central1 --project palup-jason \
  --member="serviceAccount:palup-catalog-index-invoker@palup-jason.iam.gserviceaccount.com" \
  --role="roles/run.invoker"

# 5. Schedule HOURLY, at an odd minute to dodge the top-of-hour herd. --time-zone=UTC so DST never shifts it.
gcloud scheduler jobs create http palup-catalog-index-hourly \
  --location=us-central1 --project palup-jason \
  --schedule="23 * * * *" --time-zone=UTC \
  --uri="https://us-central1-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/palup-jason/jobs/palup-catalog-index:run" \
  --http-method=POST \
  --oauth-service-account-email="palup-catalog-index-invoker@palup-jason.iam.gserviceaccount.com" \
  --max-retry-attempts=3 --min-backoff=60s --max-backoff=600s

# 6. Prove it fires.
gcloud scheduler jobs run palup-catalog-index-hourly --location us-central1 --project palup-jason
gcloud run jobs executions list --job palup-catalog-index --region us-central1 --project palup-jason
```

**Spend note (for the apply):** enabling the hourly job starts real Vertex embedding spend on the dark
corpus — bounded, because only changed content hashes embed after the first run (content-hash + ledger diff).
The apply is the owner's cost decision.

**Known blind-spot (documented, not fixed here — S4 follow-up):** both this job and the sweep enumerate
`SHOPIFY_STORES` for their tenant list (`catalog-index.ts` `tenantsToIndex`). A self-installed merchant absent
from that env is NOT reconciled. The tenant list should come from the install registry — deferred to S4
(spec §H(2)). Until then, a newly-installed merchant relies on webhooks + the 15-min serve ceiling until its
domain is added to `SHOPIFY_STORES`.
````

- [ ] **Step 4: Run the deploy-config test to verify it passes**

Run: `env -u GOOGLE_CLOUD_PROJECT pnpm exec vitest run packages/widget-backend/test/deploy-catalog-index-job.test.ts`
Expected: PASS (all `REQUIRED_LINES`, the no-serving-flag check, the hourly cron check).

- [ ] **Step 5: Commit**

```bash
git add docs/DEPLOY.md packages/widget-backend/test/deploy-catalog-index-job.test.ts
git commit -m "docs(deploy): catalog-index backstop runbook (Cloud Run Job + hourly Scheduler + invoker SA); guarded (S3 §E — apply is the owner's)"
```

---

## Final verification (before handing to jason for the human merge)

- [ ] **Run the full local merge gate** (the seven steps, unchanged): `.claude/scripts/merge-gate.sh <pr>` — never set `GOOGLE_CLOUD_PROJECT`. This runs Typecheck, Unit+port-contract, eval gate, App E2E, Control-plane E2E, Embed round-trip E2E, and the pgvector step (which now also covers the ANN-safe reconcile HEADLINE test). Docker must be up for the pgvector step.
- [ ] **Confirm no flag was flipped:** `grep -rn "CATALOG_RETRIEVAL\|VECTOR_ANN\|PRODUCT_FACTS_HYDRATION\|MEMORY_ADR_ACCEPTED" packages/widget-backend/src` shows only reads/defaults, never a `= true` write introduced by S3.
- [ ] **Governance:** this branch is **human-merged by jason** (deploy infra + embedding spend + freshness/money surface); the `gcloud` applies in DEPLOY.md are his; **#295 stays blocked**.

---

## Self-review (run after writing; fixes applied inline)

**1. Spec coverage — every §B–§H requirement maps to a task:**

- §B ledger storage in `catalog_index`, chunked, same-tx-as-manifest, foreign-guard intrinsic → **Task 1** (+ atomic write in **Task 2**).
- §B reconcile diff new/changed/stale, no enumerate, migration build-from-plan-no-blind-delete, `--reindex` reset → **Task 2**.
- §B HEADLINE >5000 pgvector reconcile, zero enumerate, no throw; grep-guard → **Task 2**.
- §C payload `productIds[]`+`reason`; per-topic id extraction (products/* precise, inventory coarse, delete=prune-no-fetch) → **Task 3**.
- §C `fetchProductsById` via Storefront `nodes(ids:)` → **Task 4**.
- §C targeted `reconcile(tenantId,{productIds})` touching only the changed set; delete prune; no-manifest→full → **Task 5**.
- §C coalesce/debounce (`CATALOG_RECONCILE_COALESCE_MS` default 5s; cap 500 → spill to full; inventory no-crawl) → **Task 6**.
- §D default 3_600_000 → 900_000; always pass `{now,maxAgeMs}`; clear the D2 blocker; do NOT flip the flag → **Task 7**.
- §E Cloud Run Job + hourly Scheduler + invoker SA runbook (owner applies) + deploy-config test + `SHOPIFY_STORES` blind-spot note → **Task 8**.
- §F erasure drops the ledger; no flag flipped; human-merged; #295 blocked → **Task 1** (erasure) + Global Constraints + Final verification.
- §G ATDD, `env -u GOOGLE_CLOUD_PROJECT`, mock + pgvector, no real Vertex, seven gate steps unchanged (pgvector step extended) → Global Constraints + every task's run commands + **Task 2 Step 8**.
- §H promotion preconditions (build a fresh corpus first; `SHOPIFY_STORES` blind-spot) → documented in **Task 8**'s runbook (spend note + blind-spot) — carried forward for the §5 owner, no build action required.

No unmapped requirement found.

**2. Placeholder scan:** no `TBD`/`TODO`/`similar to Task N`/"add error handling" — every code and test step contains real code. Fixed none (none present).

**3. Type/signature consistency across tasks:**
- `writeManifestAndAudit` gains a 5th param `{ entries: Map<string,string>; priorChunkKeys: string[] }` in Task 2 and is called with it by both `indexOneTenant` (Task 2) and `reconcileProducts` (Task 5) — consistent.
- `CatalogByIdSource = (tenantId, ids) => Promise<Product[] | undefined>` defined in Task 5, produced by `shopifyCatalogByIdSource` (Task 5), consumed as `CatalogIndexDeps.catalogById` (Task 5) — consistent.
- `ReconcileReason = "product"|"inventory"|"full"` defined in Task 3 (catalog-webhook-queue.ts), imported by Tasks 5 (catalog-index.ts, server.ts) and 6 (coalescer) — consistent; no cycle (queue imports only platform-ports).
- `catalogReconcileMessage(...)` 5th arg `{ productIds?, reason? }` (Task 3) matches what `handleCatalogChange` passes (Task 3) and what `subscribeCatalogReconcile` reads back (Task 5) — consistent.
- `subscribeCatalogReconcile`'s reconcile callback becomes `(tenantId, opts?) => Promise<void>` (Task 5); the coalescer's `enqueue` and `createReconcileCoalescer`'s reconcile arg use `{ productIds?, reason }` (Task 6) — consistent; server adapts between them in Task 6 Step 5.
- `PgVectorStore(sql, { dimension, efSearch })` + `.migrate()` and `startPgvectorContainer()` match the real state-postgres signatures verified at HEAD — consistent.
- `hydrateProductFacts(products, facts, {now, maxAgeMs})` unchanged; Task 7 only changes the server default and the doc note — consistent.

No inconsistencies found.
