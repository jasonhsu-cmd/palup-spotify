import { readFileSync } from "node:fs";
import { describe, it, expect, vi } from "vitest";
import {
  InMemoryRuntimeStore,
  createInMemoryVectorStore,
  createInMemoryProductFactsStore,
  createEnvSecrets,
  requireEmbedAlignment,
  requireEmbedInputs,
  type EmbedPurpose,
  type EmbedRequest,
  type EmbedResponse,
  type GroundingContext,
  type ModelPort,
  type Product,
  type ProductFact,
  type ProductFactsPort,
  type VectorPort,
} from "@palup/platform-ports";
import { armKill, setCostCap } from "@palup/state-postgres";
import { validateAnonId } from "@palup/widget-memory";
import { storefrontFetch, MAX_CATALOG_PRODUCTS, STOREFRONT_PAGE_SIZE } from "../src/shopify-grounding.js";
import {
  CATALOG_INDEX_ACTOR,
  MANIFEST_COLLECTION,
  MANIFEST_KEY,
  MAX_INDEXED_PRODUCTS,
  VECTOR_SCAN_ROWS_MIRRORED,
  CatalogArgsError,
  catalogNamespace,
  catalogRecordId,
  parseCatalogArgv,
  productEmbedText,
  productFactsFrom,
  resolveIndexStores,
  runCatalogClear,
  runCatalogIndex,
  shopifyCatalogSource,
  tenantsToIndex,
  type CatalogManifest,
  type CatalogSource,
} from "../src/jobs/catalog-index.js";

// C3 — the scheduled/operator-run catalog INDEX job.
//
// WHAT IS UNDER TEST. Not "does an embedding work" (no credentials here, and the fake below says nothing
// about semantic quality) but the SAFETY WRAPPER around a metered, bulk, cross-boundary write:
//   • does an operator halt / a cost cap stop it, per tenant AND mid-catalog;
//   • is a re-run idempotent (no duplicates, and no repeat SPEND on an unchanged catalog);
//   • is {model, dimension} pinned per corpus so two vector shapes can never mix;
//   • is a partial corpus impossible — a mid-catalog failure leaves the corpus fully OLD;
//   • does it HARD-FAIL at its ceiling instead of silently truncating (the #180 argument, applied to
//     the write side where the vector adapter's own 5000-row scan cap truncates by id order);
//   • is the write audited with a reversal path an operator can ACTUALLY RUN (the #179 defect).
//
// NOTHING READS THIS CORPUS. Retrieval is a later, separately-gated work item, so these tests assert the
// corpus's SHAPE and the job's refusals — never that retrieval works.

// ── fakes: no credentials, no network ──────────────────────────────────────────────────────────────

/**
 * Deterministic offline embedder. Mirrors platform-ports' own test fake (char-code buckets) and calls
 * the SAME exported validators every real adapter must call, so the job is exercised against the port's
 * real contract. It says NOTHING about semantic quality.
 */
function fakeEmbedder(
  opts: { dimension?: number; model?: string; failOnCall?: number; purposeOverride?: EmbedPurpose } = {},
) {
  const calls: Array<{ texts: string[]; tenantId?: string; purpose: EmbedPurpose }> = [];
  const dimension = opts.dimension ?? 4;
  const model = opts.model ?? "fake-embed-4d";
  const port: ModelPort = {
    async complete() {
      return { text: "ok", model };
    },
    async embed(req: EmbedRequest): Promise<EmbedResponse> {
      calls.push({ texts: [...req.texts], tenantId: req.tenantId, purpose: req.purpose });
      if (opts.failOnCall === calls.length) throw new Error("provider 503");
      requireEmbedInputs(req);
      const vectors = req.texts.map((t) => {
        const v = new Array<number>(dimension).fill(0);
        for (let i = 0; i < t.length; i++) v[i % dimension] = (v[i % dimension] ?? 0) + t.charCodeAt(i);
        return v;
      });
      // `purposeOverride` stands in for an adapter/deployment configured for the WRONG side of retrieval
      // — the B3 failure mode. It bypasses requireEmbedAlignment's echo check on purpose, because the
      // point is to hand the JOB a response the port would have rejected and prove the job refuses too.
      const res: EmbedResponse = {
        vectors,
        dimension,
        model,
        purpose: opts.purposeOverride ?? req.purpose,
        usage: { inputTokens: req.texts.join(" ").length },
      };
      if (!opts.purposeOverride) requireEmbedAlignment(req, res);
      return res;
    },
  };
  return { port, calls };
}

/** A complete-only adapter: the capability is ABSENT, never a stub that throws (#188's rule). */
const completeOnly: ModelPort = {
  async complete() {
    return { text: "ok", model: "complete-only" };
  },
};

const product = (i: number, over: Partial<Product> = {}): Product => ({
  id: `gid://shopify/Product/${i}`,
  title: `Product ${i}`,
  description: "a description",
  price: "$10",
  tags: ["tag"],
  ...over,
});

const context = (tenantId: string, products: Product[]): GroundingContext => ({
  tenantId,
  brandName: "Acme",
  products,
  policy: { returns: "30 days", shipping: "free" },
});

/** A catalog source over a fixed map, plus a call counter (to prove when a fetch was NOT attempted). */
function fakeCatalog(map: Record<string, GroundingContext | undefined>) {
  const calls: string[] = [];
  const source: CatalogSource = async (tenantId) => {
    calls.push(tenantId);
    return map[tenantId];
  };
  return { source, calls };
}

const idsIn = async (vector: VectorPort, tenantId: string): Promise<string[]> =>
  (await vector.query(catalogNamespace(tenantId), { text: "", k: 5000 })).map((m) => m.id).sort();

const recordsIn = async (vector: VectorPort, tenantId: string) =>
  vector.query(catalogNamespace(tenantId), { text: "", k: 5000 });

const manifestOf = (store: InMemoryRuntimeStore, tenantId: string) =>
  store.get<CatalogManifest>({ tenantId }, MANIFEST_COLLECTION, MANIFEST_KEY);

function harness(products: Product[], embedOpts: Parameters<typeof fakeEmbedder>[0] = {}, tenantId = "acme-co") {
  const store = new InMemoryRuntimeStore();
  const vector = createInMemoryVectorStore();
  const { port, calls } = fakeEmbedder(embedOpts);
  const { source, calls: fetches } = fakeCatalog({ [tenantId]: context(tenantId, products) });
  return { store, vector, model: port, embedCalls: calls, catalog: source, fetches, tenantId };
}

// ── the ceiling: hard-fail, never truncate ─────────────────────────────────────────────────────────

describe("C3 ceiling — the job REFUSES an oversized catalog rather than indexing part of it", () => {
  it("stays strictly below the vector adapter's own row-scan cap, which truncates by ID ORDER", () => {
    // postgres-vector-store.ts caps every query() at MAX_SCAN_ROWS with `ORDER BY id LIMIT` — id order,
    // NOT relevance — so beyond that cap records silently vanish from a query. Read the real constant out
    // of the real file so this can never drift into an unsafe corpus size.
    const src = readFileSync(new URL("../../state-postgres/src/postgres-vector-store.ts", import.meta.url), "utf8");
    const scanCap = Number(/MAX_SCAN_ROWS = (\d+)/.exec(src)?.[1]);
    expect(scanCap).toBeGreaterThan(0);
    expect(VECTOR_SCAN_ROWS_MIRRORED).toBe(scanCap);
    // +1 row of headroom is needed for the completeness probe, so the ceiling must be STRICTLY below.
    expect(MAX_INDEXED_PRODUCTS).toBeLessThan(scanCap);
  });

  it("is coherent with #180's fetch ceiling — never larger by accident", () => {
    expect(MAX_INDEXED_PRODUCTS).toBe(MAX_CATALOG_PRODUCTS);
  });

  it("a catalog OVER the ceiling writes NOTHING — no partial corpus, and the refusal is reported", async () => {
    const h = harness(Array.from({ length: 6 }, (_, i) => product(i)));
    const reports = await runCatalogIndex(h, [h.tenantId], { maxProducts: 5 });
    expect(reports[0]!.outcome).toBe("ceiling-exceeded");
    expect(reports[0]!.products).toBe(6);
    expect(await idsIn(h.vector, h.tenantId)).toEqual([]);
    expect(h.embedCalls).toHaveLength(0); // refused BEFORE any metered spend
    expect(await manifestOf(h.store, h.tenantId)).toBeNull();
  });

  it("an oversized catalog does not damage a corpus that is already indexed (stays fully OLD)", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const { port } = fakeEmbedder();
    const small = context("acme-co", [product(1), product(2)]);
    const big = context("acme-co", Array.from({ length: 9 }, (_, i) => product(i)));
    let current = small;
    const deps = { store, vector, model: port, catalog: async () => current };

    await runCatalogIndex(deps, ["acme-co"], { maxProducts: 5 });
    const before = await idsIn(vector, "acme-co");
    expect(before).toHaveLength(2);

    current = big;
    const reports = await runCatalogIndex(deps, ["acme-co"], { maxProducts: 5 });
    expect(reports[0]!.outcome).toBe("ceiling-exceeded");
    expect(await idsIn(vector, "acme-co")).toEqual(before); // untouched
  });

  it("refuses to reconcile a namespace holding records it did not write (never deletes foreign data)", async () => {
    const h = harness([product(1)]);
    await runCatalogIndex(h, [h.tenantId]);
    await h.vector.upsert(catalogNamespace(h.tenantId), [{ id: "someone-elses-record", vector: [1, 0, 0, 0] }]);

    const reports = await runCatalogIndex(h, [h.tenantId]);

    expect(reports[0]!.outcome).toBe("failed");
    expect(reports[0]!.reason).toMatch(/not written by this job/i);
    expect(await idsIn(h.vector, h.tenantId)).toContain("someone-elses-record"); // untouched
  });

  it("refuses when the existing corpus cannot be ENUMERATED completely (no blind reconcile)", async () => {
    const h = harness([product(1)]);
    // Pre-seed more records than the ceiling allows: one query can no longer prove what is in there, so
    // stale-record reconciliation would be guesswork.
    await h.vector.upsert(
      catalogNamespace(h.tenantId),
      Array.from({ length: 6 }, (_, i) => ({ id: catalogRecordId(`x${i}`), vector: [1, 0, 0, 0], metadata: {} })),
    );
    const reports = await runCatalogIndex(h, [h.tenantId], { maxProducts: 5 });
    expect(reports[0]!.outcome).toBe("failed");
    expect(reports[0]!.reason).toMatch(/enumerat/i);
    expect(h.embedCalls).toHaveLength(0);
  });
});

// ── idempotency ────────────────────────────────────────────────────────────────────────────────────

describe("C3 idempotency — a re-run neither duplicates the corpus nor re-spends on it", () => {
  it("indexes one record per product, in the tenant's OWN catalog namespace", async () => {
    const h = harness([product(1), product(2)]);
    const reports = await runCatalogIndex(h, [h.tenantId]);
    expect(reports[0]!.outcome).toBe("indexed");
    expect(reports[0]!.written).toBe(2);
    expect(await idsIn(h.vector, h.tenantId)).toEqual(
      [catalogRecordId("gid://shopify/Product/1"), catalogRecordId("gid://shopify/Product/2")].sort(),
    );
    expect(catalogNamespace(h.tenantId)).toBe(`${h.tenantId}::catalog`);
  });

  it("a SECOND run over an unchanged catalog adds nothing and spends NOTHING", async () => {
    const h = harness([product(1), product(2), product(3)]);
    await runCatalogIndex(h, [h.tenantId]);
    const after1 = await recordsIn(h.vector, h.tenantId);
    const spend1 = h.embedCalls.length;

    const reports = await runCatalogIndex(h, [h.tenantId]);

    expect(reports[0]!.outcome).toBe("unchanged");
    expect(reports[0]!.embedded).toBe(0);
    expect(h.embedCalls).toHaveLength(spend1); // NOT ONE extra metered call
    const after2 = await recordsIn(h.vector, h.tenantId);
    expect(after2.map((r) => r.id).sort()).toEqual(after1.map((r) => r.id).sort());
    expect(after2).toHaveLength(3);
  });

  it("re-embeds ONLY a product whose indexed text changed", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const { port, calls } = fakeEmbedder();
    let products = [product(1), product(2)];
    const deps = { store, vector, model: port, catalog: async () => context("acme-co", products) };

    await runCatalogIndex(deps, ["acme-co"]);
    calls.length = 0;
    products = [product(1, { title: "Renamed" }), product(2)];

    const reports = await runCatalogIndex(deps, ["acme-co"]);

    expect(reports[0]!.outcome).toBe("indexed");
    expect(reports[0]!.embedded).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.texts).toHaveLength(1);
    expect(calls[0]!.texts[0]).toContain("Renamed");
    expect(await idsIn(vector, "acme-co")).toHaveLength(2); // still one record per product
  });

  it("a DELISTED product leaves the corpus — a stale record would outlive the catalog", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const { port } = fakeEmbedder();
    let products = [product(1), product(2)];
    const deps = { store, vector, model: port, catalog: async () => context("acme-co", products) };

    await runCatalogIndex(deps, ["acme-co"]);
    products = [product(1)];
    const reports = await runCatalogIndex(deps, ["acme-co"]);

    expect(reports[0]!.removed).toBe(1);
    expect(await idsIn(vector, "acme-co")).toEqual([catalogRecordId("gid://shopify/Product/1")]);
  });

  it("passes tenantId to the embedder so metered spend is attributed to the right merchant", async () => {
    const h = harness([product(1)]);
    await runCatalogIndex(h, [h.tenantId]);
    expect(h.embedCalls[0]!.tenantId).toBe(h.tenantId);
  });

  it("refuses a catalog with duplicate product ids rather than silently collapsing them", async () => {
    const h = harness([product(1), product(1, { title: "Same id, other title" })]);
    const reports = await runCatalogIndex(h, [h.tenantId]);
    expect(reports[0]!.outcome).toBe("failed");
    expect(reports[0]!.reason).toMatch(/duplicate/i);
    expect(await idsIn(h.vector, h.tenantId)).toEqual([]);
  });

  it("refuses a product with no indexable text, naming it, instead of storing a meaningless vector", async () => {
    const h = harness([product(1), product(2, { title: "  ", description: "", tags: [] })]);
    const reports = await runCatalogIndex(h, [h.tenantId]);
    expect(reports[0]!.outcome).toBe("failed");
    expect(reports[0]!.reason).toContain("gid://shopify/Product/2");
    expect(await idsIn(h.vector, h.tenantId)).toEqual([]); // never a partial corpus
    expect(h.embedCalls).toHaveLength(0);
  });
});

// ── dimension / model pinning ──────────────────────────────────────────────────────────────────────

describe("C3 pinning — one corpus, one {model, dimension}, enforced by refusal", () => {
  it("records the pin in the manifest at first index", async () => {
    const h = harness([product(1)], { dimension: 4, model: "fake-embed-4d" });
    await runCatalogIndex(h, [h.tenantId]);
    const m = await manifestOf(h.store, h.tenantId);
    expect(m).toMatchObject({ model: "fake-embed-4d", dimension: 4, products: 1 });
  });

  it("REFUSES to extend a corpus once the DIMENSION changes — and writes nothing", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    let products = [product(1)];
    const catalog = async () => context("acme-co", products);
    await runCatalogIndex({ store, vector, model: fakeEmbedder({ dimension: 4 }).port, catalog }, ["acme-co"]);
    const before = await recordsIn(vector, "acme-co");

    products = [product(1), product(2)];
    const bigger = fakeEmbedder({ dimension: 8, model: "fake-embed-8d" });
    const reports = await runCatalogIndex({ store, vector, model: bigger.port, catalog }, ["acme-co"]);

    expect(reports[0]!.outcome).toBe("pin-mismatch");
    expect(await recordsIn(vector, "acme-co")).toEqual(before); // old vectors intact, no 8-dim record
    expect((await manifestOf(store, "acme-co"))!.dimension).toBe(4);
  });

  it("REFUSES a MODEL change even at the same dimension (same shape ≠ same vector space)", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    let products = [product(1)];
    const catalog = async () => context("acme-co", products);
    await runCatalogIndex({ store, vector, model: fakeEmbedder({ model: "model-a" }).port, catalog }, ["acme-co"]);

    products = [product(1), product(2)];
    const reports = await runCatalogIndex(
      { store, vector, model: fakeEmbedder({ model: "model-b" }).port, catalog },
      ["acme-co"],
    );

    expect(reports[0]!.outcome).toBe("pin-mismatch");
    expect(await idsIn(vector, "acme-co")).toHaveLength(1);
  });

  it("detects the mismatch within ONE batch — it never pays to embed the whole catalog first", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    let products = [product(0)];
    const catalog = async () => context("acme-co", products);
    await runCatalogIndex({ store, vector, model: fakeEmbedder({ dimension: 4 }).port, catalog }, ["acme-co"], {
      batchSize: 2,
    });

    products = Array.from({ length: 9 }, (_, i) => product(i));
    const changed = fakeEmbedder({ dimension: 8 });
    const reports = await runCatalogIndex({ store, vector, model: changed.port, catalog }, ["acme-co"], { batchSize: 2 });

    expect(reports[0]!.outcome).toBe("pin-mismatch");
    expect(changed.calls).toHaveLength(1); // one batch of spend, not five
  });

  it("an explicit --reindex REPLACES the corpus wholesale at the new pin (no mixed shapes)", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const products = [product(1), product(2)];
    const catalog = async () => context("acme-co", products);
    await runCatalogIndex({ store, vector, model: fakeEmbedder({ dimension: 4 }).port, catalog }, ["acme-co"]);

    const reports = await runCatalogIndex(
      { store, vector, model: fakeEmbedder({ dimension: 8, model: "fake-embed-8d" }).port, catalog },
      ["acme-co"],
      { reindex: true },
    );

    expect(reports[0]!.outcome).toBe("indexed");
    const records = await recordsIn(vector, "acme-co");
    expect(records).toHaveLength(2);
    const raw = await vector.query(catalogNamespace("acme-co"), { vector: new Array(8).fill(1), k: 10 });
    expect(raw).toHaveLength(2);
    expect((await manifestOf(store, "acme-co"))).toMatchObject({ dimension: 8, model: "fake-embed-8d" });
  });

  it("an EMPTY corpus adopts the current pin — a stale manifest is not a dead end", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const products = [product(1)];
    const catalog = async () => context("acme-co", products);
    await runCatalogIndex({ store, vector, model: fakeEmbedder({ dimension: 4 }).port, catalog }, ["acme-co"]);
    await runCatalogClear({ store, vector }, "acme-co");

    const reports = await runCatalogIndex(
      { store, vector, model: fakeEmbedder({ dimension: 8, model: "fake-embed-8d" }).port, catalog },
      ["acme-co"],
    );
    expect(reports[0]!.outcome).toBe("indexed");
    expect((await manifestOf(store, "acme-co"))!.dimension).toBe(8);
  });

  it("refuses an ORPHANED corpus (records with no manifest) instead of trusting its provenance", async () => {
    const h = harness([product(1)]);
    await runCatalogIndex(h, [h.tenantId]);
    await h.store.delete({ tenantId: h.tenantId }, MANIFEST_COLLECTION, MANIFEST_KEY); // simulate a run that died mid-way

    const reports = await runCatalogIndex(h, [h.tenantId]);
    expect(reports[0]!.outcome).toBe("failed");
    expect(reports[0]!.reason).toMatch(/manifest/i);
    expect(reports[0]!.reason).toMatch(/reindex/);
  });
});

// ── E1 prerequisite: the pin gains PURPOSE ──────────────────────────────────────────────────────────
//
// B3 (#192) reported the gap and E1 closes it: a corpus embedded with QUERY treatment reports the SAME
// model and the SAME dimension as a correct one, so `{model, dimension}` cannot see the difference. The
// manifest now records the purpose the embedder ACTUALLY applied, and the same refusal that guards a
// dimension change guards this.

describe("E1 pinning — the corpus pin includes the embedding PURPOSE", () => {
  it("always embeds the corpus with purpose DOCUMENT and records it in the manifest", async () => {
    const h = harness([product(1)]);
    await runCatalogIndex(h, [h.tenantId]);
    expect(h.embedCalls[0]!.purpose).toBe("document");
    expect(await manifestOf(h.store, h.tenantId)).toMatchObject({ purpose: "document" });
  });

  it("REFUSES to extend a corpus whose recorded purpose differs from the one being applied now", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    let products = [product(1)];
    const catalog = async () => context("acme-co", products);
    await runCatalogIndex({ store, vector, model: fakeEmbedder().port, catalog }, ["acme-co"]);

    // Rewrite ONLY the recorded purpose — same model, same dimension. This is exactly the case the old
    // {model, dimension} pin was blind to: identical shape, different vector space.
    const m = (await manifestOf(store, "acme-co"))!;
    await store.put({ tenantId: "acme-co" }, MANIFEST_COLLECTION, MANIFEST_KEY, { ...m, purpose: "query" });

    products = [product(1), product(2)];
    const reports = await runCatalogIndex({ store, vector, model: fakeEmbedder().port, catalog }, ["acme-co"]);

    expect(reports[0]!.outcome).toBe("pin-mismatch");
    expect(reports[0]!.reason).toMatch(/query/);
    expect(reports[0]!.reason).toMatch(/reindex/);
    expect(await idsIn(vector, "acme-co")).toHaveLength(1); // nothing written
  });

  it("REFUSES outright when the embedder ignored the requested purpose (a broken adapter, not a drift)", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const catalog = async () => context("acme-co", [product(1)]);
    // Asked for `document`, answers `query`: well-formed vectors in the wrong space, with no downstream
    // symptom at all. The port's shared validator catches the broken echo before anything is stored.
    const liar = fakeEmbedder({ purposeOverride: "query" });
    const reports = await runCatalogIndex({ store, vector, model: liar.port, catalog }, ["acme-co"]);
    expect(reports[0]!.outcome).toBe("failed");
    expect(await idsIn(vector, "acme-co")).toHaveLength(0);
    expect(await manifestOf(store, "acme-co")).toBeNull();
  });

  it("REFUSES to extend a corpus whose manifest predates the purpose pin (provenance unknowable)", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    let products = [product(1)];
    const catalog = async () => context("acme-co", products);
    await runCatalogIndex({ store, vector, model: fakeEmbedder().port, catalog }, ["acme-co"]);

    const legacy = (await manifestOf(store, "acme-co"))!;
    delete (legacy as Partial<CatalogManifest>).purpose;
    await store.put({ tenantId: "acme-co" }, MANIFEST_COLLECTION, MANIFEST_KEY, legacy);

    products = [product(1), product(2)];
    const reports = await runCatalogIndex({ store, vector, model: fakeEmbedder().port, catalog }, ["acme-co"]);
    expect(reports[0]!.outcome).toBe("pin-mismatch");
    expect(reports[0]!.reason).toMatch(/purpose/i);
    expect(reports[0]!.reason).toMatch(/reindex/);
  });

  it("an explicit --reindex is the way out of a wrong-purpose corpus", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const products = [product(1)];
    const catalog = async () => context("acme-co", products);
    await runCatalogIndex({ store, vector, model: fakeEmbedder().port, catalog }, ["acme-co"]);
    const m = (await manifestOf(store, "acme-co"))!;
    await store.put({ tenantId: "acme-co" }, MANIFEST_COLLECTION, MANIFEST_KEY, { ...m, purpose: "query" });

    const reports = await runCatalogIndex({ store, vector, model: fakeEmbedder().port, catalog }, ["acme-co"], {
      reindex: true,
    });
    expect(reports[0]!.outcome).toBe("indexed");
    expect((await manifestOf(store, "acme-co"))!.purpose).toBe("document");
  });

  it("a manifest REPAIR carries the recorded purpose forward and never invents one", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const products = [product(1)];
    const catalog = async () => context("acme-co", products);
    await runCatalogIndex({ store, vector, model: fakeEmbedder().port, catalog }, ["acme-co"]);

    // Simulate the "died after the vector write, before the manifest" case the repair path exists for.
    const m = (await manifestOf(store, "acme-co"))!;
    await store.put({ tenantId: "acme-co" }, MANIFEST_COLLECTION, MANIFEST_KEY, { ...m, products: 99 });

    const reports = await runCatalogIndex({ store, vector, model: fakeEmbedder().port, catalog }, ["acme-co"]);
    expect(reports[0]!.outcome).toBe("manifest-repaired");
    expect((await manifestOf(store, "acme-co"))!.purpose).toBe("document");
  });
});

// ── atomicity: never a silent partial corpus ────────────────────────────────────────────────────────

describe("C3 atomicity — a mid-catalog failure leaves the corpus fully OLD, never half-new", () => {
  it("a failing SECOND embed batch writes nothing at all", async () => {
    const h = harness(Array.from({ length: 5 }, (_, i) => product(i)), { failOnCall: 2 });
    const reports = await runCatalogIndex(h, [h.tenantId], { batchSize: 2 });
    expect(reports[0]!.outcome).toBe("failed");
    expect(reports[0]!.errorClass).toBe("Error");
    expect(await idsIn(h.vector, h.tenantId)).toEqual([]); // batch 1's vectors were never written
    expect(await manifestOf(h.store, h.tenantId)).toBeNull();
  });

  it("a failing batch on a RE-index leaves the previously indexed corpus exactly as it was", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    let products = [product(1), product(2)];
    const catalog = async () => context("acme-co", products);
    await runCatalogIndex({ store, vector, model: fakeEmbedder().port, catalog }, ["acme-co"]);
    const before = await recordsIn(vector, "acme-co");

    products = [product(1), product(2), product(3), product(4), product(5)];
    const flaky = fakeEmbedder({ failOnCall: 2 });
    const reports = await runCatalogIndex({ store, vector, model: flaky.port, catalog }, ["acme-co"], { batchSize: 2 });

    expect(reports[0]!.outcome).toBe("failed");
    expect(await recordsIn(vector, "acme-co")).toEqual(before);
    expect((await manifestOf(store, "acme-co"))!.products).toBe(2);
  });

  it("writes the whole batch in ONE upsert call, so the durable adapter's transaction covers it", async () => {
    const h = harness(Array.from({ length: 7 }, (_, i) => product(i)));
    const upserts: number[] = [];
    const wrapped: VectorPort = {
      ...h.vector,
      upsert: async (ns, records) => {
        upserts.push(records.length);
        return h.vector.upsert(ns, records);
      },
    };
    await runCatalogIndex({ ...h, vector: wrapped }, [h.tenantId], { batchSize: 2 });
    // Four embed batches, ONE write: PostgresVectorStore.upsert is transactional PER CALL, so a single
    // call is the largest all-or-nothing unit the port offers.
    expect(upserts).toEqual([7]);
  });

  it("reports an unverified write instead of claiming success (read-back discipline)", async () => {
    const h = harness([product(1)]);
    const lying: VectorPort = { ...h.vector, upsert: async () => {} }; // accepts, stores nothing
    const reports = await runCatalogIndex({ ...h, vector: lying }, [h.tenantId]);
    expect(reports[0]!.outcome).toBe("failed");
    expect(reports[0]!.reason).toMatch(/read back|unverified/i);
    expect(await manifestOf(h.store, h.tenantId)).toBeNull(); // no manifest for a corpus we cannot see
  });
});

// ── kill switch (NN#4) ─────────────────────────────────────────────────────────────────────────────

describe("C3 kill switch — an operator halt stops the job at every scope", () => {
  it("a GLOBAL kill halts every tenant before any fetch or spend", async () => {
    const h = harness([product(1)]);
    await armKill(h.store, "global", "operator-halt");
    const reports = await runCatalogIndex(h, [h.tenantId]);
    expect(reports).toEqual([{ tenantId: h.tenantId, outcome: "halted" }]);
    expect(h.fetches).toEqual([]);
    expect(h.embedCalls).toHaveLength(0);
  });

  it("a TENANT kill halts only that tenant", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const { port } = fakeEmbedder();
    const catalog: CatalogSource = async (t) => context(t, [product(1)]);
    await armKill(store, "tenant:halted-co", "operator-halt");

    const reports = await runCatalogIndex({ store, vector, model: port, catalog }, ["halted-co", "healthy-co"]);

    expect(reports.find((r) => r.tenantId === "halted-co")!.outcome).toBe("halted");
    expect(reports.find((r) => r.tenantId === "healthy-co")!.outcome).toBe("indexed");
    expect(await idsIn(vector, "halted-co")).toEqual([]);
    expect(await idsIn(vector, "healthy-co")).toHaveLength(1);
  });

  it("an AGENT-TYPE kill halts it — the corpus exists to serve that agent", async () => {
    const h = harness([product(1)]);
    await armKill(h.store, "agent:shopper", "operator-halt");
    expect((await runCatalogIndex(h, [h.tenantId]))[0]!.outcome).toBe("halted");
  });

  it("a kill armed MID-CATALOG stops the remaining batches and writes NOTHING", async () => {
    const h = harness(Array.from({ length: 6 }, (_, i) => product(i)));
    const armAfterFirstBatch: ModelPort = {
      complete: h.model.complete.bind(h.model),
      embed: async (req) => {
        const res = await h.model.embed!(req);
        await armKill(h.store, "global", "operator-halt mid-run");
        return res;
      },
    };
    const reports = await runCatalogIndex({ ...h, model: armAfterFirstBatch }, [h.tenantId], { batchSize: 2 });
    expect(reports[0]!.outcome).toBe("halted");
    expect(h.embedCalls).toHaveLength(1); // stopped before batch 2's spend
    expect(await idsIn(h.vector, h.tenantId)).toEqual([]); // and before any write
  });
});

// ── cost cap ───────────────────────────────────────────────────────────────────────────────────────

describe("C3 cost cap — a merchant at cap does not get paid embedding work", () => {
  it("a TENANT cap skips that tenant's index, with no fetch and no spend", async () => {
    const h = harness([product(1)]);
    await setCostCap(h.store, `tenant:${h.tenantId}`, "cap reached");
    const reports = await runCatalogIndex(h, [h.tenantId]);
    expect(reports[0]!.outcome).toBe("capped");
    expect(h.fetches).toEqual([]);
    expect(h.embedCalls).toHaveLength(0);
    expect(await idsIn(h.vector, h.tenantId)).toEqual([]);
  });

  it("a GLOBAL cap skips every tenant (platform COGS cap binds all merchants)", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const { port } = fakeEmbedder();
    const catalog: CatalogSource = async (t) => context(t, [product(1)]);
    await setCostCap(store, "global", "platform cap");
    const reports = await runCatalogIndex({ store, vector, model: port, catalog }, ["a-co", "b-co"]);
    expect(reports.map((r) => r.outcome)).toEqual(["capped", "capped"]);
  });

  it("a cap armed MID-CATALOG stops further spend and writes nothing", async () => {
    const h = harness(Array.from({ length: 6 }, (_, i) => product(i)));
    const capAfterFirstBatch: ModelPort = {
      complete: h.model.complete.bind(h.model),
      embed: async (req) => {
        const res = await h.model.embed!(req);
        await setCostCap(h.store, "global", "cap reached mid-run");
        return res;
      },
    };
    const reports = await runCatalogIndex({ ...h, model: capAfterFirstBatch }, [h.tenantId], { batchSize: 2 });
    expect(reports[0]!.outcome).toBe("capped");
    expect(h.embedCalls).toHaveLength(1);
    expect(await idsIn(h.vector, h.tenantId)).toEqual([]);
  });

  it("an UNCHANGED catalog is still skipped at cap — the cap is checked before the corpus is read", async () => {
    const h = harness([product(1)]);
    await runCatalogIndex(h, [h.tenantId]);
    await setCostCap(h.store, "global", "cap reached");
    expect((await runCatalogIndex(h, [h.tenantId]))[0]!.outcome).toBe("capped");
  });
});

// ── capability absence vs failure (#188) ───────────────────────────────────────────────────────────

describe("C3 embed capability — 'cannot embed' is not 'embedding failed'", () => {
  it("a complete-only adapter yields no-embed-capability, with no fetch and no store write", async () => {
    const h = harness([product(1)]);
    const reports = await runCatalogIndex({ ...h, model: completeOnly }, [h.tenantId]);
    expect(reports[0]!.outcome).toBe("no-embed-capability");
    expect(h.fetches).toEqual([]); // a static, free check — never a wasted Shopify round-trip
    expect(await idsIn(h.vector, h.tenantId)).toEqual([]);
    expect(await manifestOf(h.store, h.tenantId)).toBeNull();
  });

  it("an adapter whose embed REJECTS is a failure, reported differently", async () => {
    const h = harness([product(1)], { failOnCall: 1 });
    const reports = await runCatalogIndex(h, [h.tenantId]);
    expect(reports[0]!.outcome).toBe("failed");
    expect(reports[0]!.errorClass).toBe("Error");
  });

  it("reports no-embed-capability for EVERY tenant asked for, not just the first", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const catalog: CatalogSource = async (t) => context(t, [product(1)]);
    const reports = await runCatalogIndex({ store, vector, model: completeOnly, catalog }, ["a-co", "b-co"]);
    expect(reports.map((r) => r.outcome)).toEqual(["no-embed-capability", "no-embed-capability"]);
  });
});

// ── audit + a reversal path that actually runs (NN#5, the #179 lesson) ─────────────────────────────

describe("C3 audit — the write is audited with a reversal an operator can actually run", () => {
  it("audits the index with actor, input, decision and a reversalPath", async () => {
    const h = harness([product(1), product(2)]);
    await runCatalogIndex(h, [h.tenantId]);
    const audit = await h.store.readAudit({ tenantId: h.tenantId });
    const entry = audit.find((a) => a.action === "catalog.index");
    expect(entry).toBeDefined();
    expect(entry!.actor).toBe(CATALOG_INDEX_ACTOR);
    expect(entry!.decision).toBeDefined();
    expect(entry!.input).toMatchObject({ tenantId: h.tenantId, products: 2, written: 2, dimension: 4 });
    expect(entry!.reversalPath).toContain("pnpm catalog:clear");
  });

  it("the audited reversalPath parses as a REAL command of this CLI (not a route nobody can reach)", async () => {
    const h = harness([product(1)]);
    await runCatalogIndex(h, [h.tenantId]);
    const entry = (await h.store.readAudit({ tenantId: h.tenantId })).find((a) => a.action === "catalog.index")!;
    // "pnpm catalog:clear --tenant acme-co" → the script's own argv, fed through the real parser.
    const [, script, ...rest] = entry.reversalPath!.split(/\s+/);
    const scripts = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")).scripts;
    expect(Object.keys(scripts)).toContain(script);
    const action = scripts[script].split(/\s+/).pop();
    expect(parseCatalogArgv([action, ...rest])).toEqual({ action: "clear", tenantId: h.tenantId });
  });

  it("the manifest and its audit record commit TOGETHER — an audit failure leaves no manifest", async () => {
    const h = harness([product(1)]);
    const store = h.store;
    const realTx = store.tx.bind(store);
    let broken = true;
    const failingAudit = {
      ...store,
      get: store.get.bind(store),
      put: store.put.bind(store),
      delete: store.delete.bind(store),
      list: store.list.bind(store),
      readAudit: store.readAudit.bind(store),
      tx: (async (ctx: { tenantId: string }, fn: (t: unknown) => Promise<unknown>) =>
        realTx(ctx, async (t) => {
          const out = await fn({
            ...t,
            get: t.get.bind(t),
            put: t.put.bind(t),
            delete: t.delete.bind(t),
            append: t.append.bind(t),
            audit: async () => {
              if (broken) throw new Error("audit log unavailable");
              return t.audit({ actor: "x", action: "y" });
            },
          });
          return out;
        })) as typeof store.tx,
    } as unknown as InMemoryRuntimeStore;

    const reports = await runCatalogIndex({ ...h, store: failingAudit }, [h.tenantId]);
    expect(reports[0]!.outcome).toBe("failed");
    expect(await manifestOf(store, h.tenantId)).toBeNull(); // rolled back with the audit
    broken = false;
  });

  it("clear removes the corpus, confirms it is gone, and audits the reversal", async () => {
    const h = harness([product(1), product(2)]);
    await runCatalogIndex(h, [h.tenantId]);

    const report = await runCatalogClear(h, h.tenantId);

    expect(report).toMatchObject({ tenantId: h.tenantId, removed: 2, confirmed: true });
    expect(await idsIn(h.vector, h.tenantId)).toEqual([]);
    expect(await manifestOf(h.store, h.tenantId)).toBeNull();
    const entry = (await h.store.readAudit({ tenantId: h.tenantId })).find((a) => a.action === "catalog.clear");
    expect(entry!.reversalPath).toContain("pnpm catalog:index");
  });

  it("clear never touches another tenant's corpus, or this tenant's shopper memory", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const { port } = fakeEmbedder();
    const catalog: CatalogSource = async (t) => context(t, [product(1)]);
    await runCatalogIndex({ store, vector, model: port, catalog }, ["a-co", "b-co"]);
    await vector.upsert("a-co::SHOPPERAAAAAA", [{ id: "fact-1", text: "likes wool", metadata: {} }]);

    await runCatalogClear({ store, vector }, "a-co");

    expect(await idsIn(vector, "a-co")).toEqual([]);
    expect(await idsIn(vector, "b-co")).toHaveLength(1);
    expect(await vector.query("a-co::SHOPPERAAAAAA", { text: "", k: 10 })).toHaveLength(1);
  });

  it("repairs a manifest that disagrees with the corpus rather than reporting 'unchanged'", async () => {
    // The one window the ports leave open: the vector write committed, the manifest+audit tx did not.
    const h = harness([product(1), product(2)]);
    await runCatalogIndex(h, [h.tenantId]);
    await h.store.put({ tenantId: h.tenantId }, MANIFEST_COLLECTION, MANIFEST_KEY, {
      ...(await manifestOf(h.store, h.tenantId))!,
      products: 1, // a count that does not match the 2 records actually in the corpus
    });

    const reports = await runCatalogIndex(h, [h.tenantId]);

    expect(reports[0]!.outcome).toBe("manifest-repaired");
    expect(reports[0]!.embedded).toBe(0); // repaired without re-spending
    expect((await manifestOf(h.store, h.tenantId))!.products).toBe(2);
  });
});

// ── corpus shape: no stale merchant facts, nothing for retrieval to trip over ──────────────────────

describe("C3 corpus shape — a relevance index over ids, not a copy of the catalog", () => {
  it("stores the vector + the product id + a content hash, and NO price/title/availability", async () => {
    const h = harness([product(1, { price: "$99", availableForSale: true })]);
    await runCatalogIndex(h, [h.tenantId]);
    const [rec] = await recordsIn(h.vector, h.tenantId);
    expect(rec!.metadata).toMatchObject({ kind: "product", productId: "gid://shopify/Product/1" });
    expect(typeof (rec!.metadata as { contentHash?: unknown }).contentHash).toBe("string");
    const serialized = JSON.stringify(rec!.metadata);
    expect(serialized).not.toContain("$99"); // a stale price must never be quotable from the corpus
    expect(serialized).not.toContain("availableForSale");
    expect(serialized).not.toContain("Product 1");
  });

  it("keeps the manifest OUT of the vector namespace, so retrieval can never rank it", async () => {
    const h = harness([product(1)]);
    await runCatalogIndex(h, [h.tenantId]);
    const ids = await idsIn(h.vector, h.tenantId);
    expect(ids).toHaveLength(1);
    expect(ids.every((id) => id.startsWith("product:"))).toBe(true);
  });

  it("every record carries a vector — a text-modality query cannot match a stale copy", async () => {
    const h = harness([product(1), product(2)]);
    await runCatalogIndex(h, [h.tenantId]);
    for (const m of await recordsIn(h.vector, h.tenantId)) expect(m.score).toBe(0); // no text to match on
    const byVector = await h.vector.query(catalogNamespace(h.tenantId), { vector: [1, 1, 1, 1], k: 10 });
    expect(byVector.every((m) => m.score !== 0)).toBe(true);
  });

  it("the catalog namespace can never collide with a shopper subject namespace", () => {
    expect(validateAnonId("catalog")).toBeUndefined(); // lowercase is outside the base32 anon-id charset
    expect(catalogNamespace("acme-co")).toBe("acme-co::catalog");
    expect(() => catalogNamespace("evil::acme-co")).toThrow(/::/);
    expect(() => catalogNamespace(" ")).toThrow();
  });

  it("productEmbedText is deterministic and carries the semantic fields only", () => {
    const p = product(1, { title: "Ceramide Cream", description: "for redness", tags: ["gentle"], price: "$28" });
    const text = productEmbedText(p);
    expect(text).toBe(productEmbedText({ ...p }));
    expect(text).toContain("Ceramide Cream");
    expect(text).toContain("gentle");
    expect(text).toContain("for redness");
    expect(text).not.toContain("$28"); // price changes must not force a re-embed, and never rank
  });
});

// ── containment + the run's own reporting ──────────────────────────────────────────────────────────

describe("C3 run reporting — one tenant's outcome never decides another's", () => {
  it("one tenant throwing does not abort the run", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const { port } = fakeEmbedder();
    const catalog: CatalogSource = async (t) => {
      if (t === "broken-co") throw new Error("storefront down");
      return context(t, [product(1)]);
    };
    const reports = await runCatalogIndex({ store, vector, model: port, catalog }, ["broken-co", "healthy-co"]);
    expect(reports.find((r) => r.tenantId === "broken-co")!.outcome).toBe("failed");
    expect(reports.find((r) => r.tenantId === "broken-co")!.errorClass).toBe("Error");
    expect(reports.find((r) => r.tenantId === "healthy-co")!.outcome).toBe("indexed");
  });

  it("a tenant with no configured store is reported as not-configured, not as a failure", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const { port } = fakeEmbedder();
    const reports = await runCatalogIndex({ store, vector, model: port, catalog: async () => undefined }, ["nope-co"]);
    expect(reports[0]!.outcome).toBe("not-configured");
  });

  it("an EMPTY catalog writes no records and no manifest — nothing to index is not an index", async () => {
    const h = harness([]);
    const reports = await runCatalogIndex(h, [h.tenantId]);
    expect(reports[0]!.outcome).toBe("not-configured");
    expect(h.embedCalls).toHaveLength(0);
  });

  it("a report never carries an error MESSAGE — only its class (operator output stays PII-free)", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const { port } = fakeEmbedder();
    const catalog: CatalogSource = async () => {
      throw new Error("token shptok_secret rejected by acme.myshopify.com");
    };
    const reports = await runCatalogIndex({ store, vector, model: port, catalog }, ["acme-co"]);
    expect(JSON.stringify(reports)).not.toContain("shptok_secret");
    expect(JSON.stringify(reports)).not.toContain("myshopify.com");
  });
});

// ── the operator CLI ───────────────────────────────────────────────────────────────────────────────

describe("C3 CLI — argv parsing, tenant selection, and the store it is allowed to write", () => {
  it("parses index/clear with an optional --tenant and an explicit --reindex", () => {
    expect(parseCatalogArgv(["index"])).toEqual({ action: "index" });
    expect(parseCatalogArgv(["index", "--tenant", "acme-co"])).toEqual({ action: "index", tenantId: "acme-co" });
    expect(parseCatalogArgv(["index", "--tenant=acme-co", "--reindex"])).toEqual({
      action: "index",
      tenantId: "acme-co",
      reindex: true,
    });
    expect(parseCatalogArgv(["clear", "--tenant", "acme-co"])).toEqual({ action: "clear", tenantId: "acme-co" });
  });

  it("refuses an unknown subcommand, an unknown flag, and a flag with no value", () => {
    expect(() => parseCatalogArgv([])).toThrow(CatalogArgsError);
    expect(() => parseCatalogArgv(["nuke"])).toThrow(CatalogArgsError);
    expect(() => parseCatalogArgv(["index", "--tenat", "acme-co"])).toThrow(/--tenat/);
    expect(() => parseCatalogArgv(["index", "--tenant"])).toThrow(/value/);
    expect(() => parseCatalogArgv(["index", "--tenant", "--reindex"])).toThrow(/value/);
  });

  it("CLEAR requires an explicit --tenant — a forgotten flag must never erase every corpus", () => {
    expect(() => parseCatalogArgv(["clear"])).toThrow(/--tenant/);
    expect(() => parseCatalogArgv(["clear", "--tenant", "all"])).toThrow(/all/i);
    expect(() => parseCatalogArgv(["clear", "--reindex"])).toThrow();
  });

  it("takes tenants from SHOPIFY_STORES only — SWEEP_TENANTS lists deletion targets, not catalogs", () => {
    const env = {
      SHOPIFY_STORES: JSON.stringify({ "alpha-co": "alpha.myshopify.com", "beta-co": "beta.myshopify.com" }),
      SWEEP_TENANTS: "gamma-co",
    } as NodeJS.ProcessEnv;
    expect(tenantsToIndex(env).sort()).toEqual(["alpha-co", "beta-co"]);
    expect(tenantsToIndex({} as NodeJS.ProcessEnv)).toEqual([]);
    expect(tenantsToIndex({ SHOPIFY_STORES: "not json" } as NodeJS.ProcessEnv)).toEqual([]);
  });

  it("refuses to run without DATABASE_URL — a corpus in a per-process store is not a corpus", async () => {
    await expect(resolveIndexStores({} as NodeJS.ProcessEnv)).rejects.toThrow(/DATABASE_URL/);
    await expect(resolveIndexStores({ DATABASE_URL: "" } as NodeJS.ProcessEnv)).rejects.toThrow(/DATABASE_URL/);
  });

  it("the root package.json exposes both halves of the operation", () => {
    const scripts = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")).scripts;
    expect(scripts["catalog:index"]).toContain("jobs/catalog-index.ts");
    expect(scripts["catalog:clear"]).toContain("jobs/catalog-index.ts");
  });
});

// ── the ingest half: the real paginated Storefront fetch, through an injected fetchFn ──────────────

describe("C3 ingest — the job indexes a MULTI-PAGE catalog via the real #180 fetch path", () => {
  const SHOP = { name: "Acme", refundPolicy: { body: "30 days" }, shippingPolicy: { body: "free" } };
  const node = (i: number) => ({
    id: `gid://shopify/Product/${i}`,
    title: `Product ${i}`,
    description: "d",
    priceRange: { minVariantPrice: { amount: "10.00", currencyCode: "USD" } },
  });

  /** A scripted Storefront endpoint (mirrors shopify-grounding-pagination.test.ts's fake). */
  function fakeStorefront(pages: Array<{ nodes: number[]; hasNextPage?: boolean; endCursor?: string | null }>) {
    let n = 0;
    const fn = (async (_url: string, init: { body: string }) => {
      const spec = pages[Math.min(n++, pages.length - 1)]!;
      if (n > 20) throw new Error("runaway pagination");
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            shop: SHOP,
            products: {
              nodes: spec.nodes.map(node),
              pageInfo: { hasNextPage: spec.hasNextPage ?? false, endCursor: spec.endCursor ?? null },
            },
          },
        }),
      } as Response;
    }) as unknown as typeof globalThis.fetch;
    return { fn, pageCount: () => n };
  }

  const secrets = createEnvSecrets(JSON.stringify({ "acme-co": { shopify_storefront_token: "shptok_secret" } }));
  const domains = { "acme-co": "acme.myshopify.com" };

  it("indexes products from EVERY page, not just the first", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const { port } = fakeEmbedder();
    const { fn } = fakeStorefront([
      { nodes: [1, 2], hasNextPage: true, endCursor: "c1" },
      { nodes: [3], hasNextPage: false },
    ]);
    const catalog = shopifyCatalogSource(secrets, storefrontFetch(fn, { log: () => {} }), domains);

    const reports = await runCatalogIndex({ store, vector, model: port, catalog }, ["acme-co"]);

    expect(reports[0]!.outcome).toBe("indexed");
    expect(reports[0]!.products).toBe(3);
    expect(await idsIn(vector, "acme-co")).toHaveLength(3);
  });

  it("a catalog past #180's PAGE ceiling fails the tenant and writes nothing (no truncated corpus)", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const { port, calls } = fakeEmbedder();
    let cursor = 0;
    const endless = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          shop: SHOP,
          products: { nodes: [node(cursor)], pageInfo: { hasNextPage: true, endCursor: `c${++cursor}` } },
        },
      }),
    })) as unknown as typeof globalThis.fetch;
    const catalog = shopifyCatalogSource(secrets, storefrontFetch(endless, { maxPages: 2, log: () => {} }), domains);

    const reports = await runCatalogIndex({ store, vector, model: port, catalog }, ["acme-co"]);

    expect(reports[0]!.outcome).toBe("failed");
    expect(await idsIn(vector, "acme-co")).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("a tenant with no domain / no token is not-configured — never a partial or fixture-backed index", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const { port } = fakeEmbedder();
    const { fn } = fakeStorefront([{ nodes: [1] }]);
    const catalog = shopifyCatalogSource(createEnvSecrets("{}"), storefrontFetch(fn, { log: () => {} }), domains);
    const reports = await runCatalogIndex({ store, vector, model: port, catalog }, ["acme-co", "unknown-co"]);
    expect(reports.map((r) => r.outcome)).toEqual(["not-configured", "not-configured"]);
  });

  it("the embed batch size is bounded by one Storefront page, so a full catalog is a bounded run", () => {
    expect(MAX_INDEXED_PRODUCTS % STOREFRONT_PAGE_SIZE).toBe(0);
  });
});

// ── A3 (ADR-0020) — the POLL-path Tier-2 product-facts producer ─────────────────────────────────────
// runCatalogIndex, given a ProductFactsPort, refreshes fresh price/availability from the SAME catalog it
// re-fetches for the vector corpus (D2, poll-first). Absent the dep it is byte-identical to before.

describe("A3 — productFactsFrom maps a catalog to Tier-2 money-facts (the volatile fields only)", () => {
  const at = new Date("2026-08-08T00:00:00.000Z");
  it("projects id + price + three-state availability, stamps source + updatedAt, and carries NO semantic fields", () => {
    const ctx = context("acme-co", [
      { id: "a", title: "A", description: "desc", price: "$10", availableForSale: true, tags: ["t"] },
      { id: "b", title: "B", description: "d", price: "$20", availableForSale: false },
      { id: "c", title: "C", description: "d", price: "$30" }, // availableForSale absent → must stay absent
    ]);
    const facts = productFactsFrom(ctx, at);
    expect(facts).toEqual([
      { productId: "a", price: "$10", availableForSale: true, source: "poll:catalog-index", updatedAt: at.toISOString() },
      { productId: "b", price: "$20", availableForSale: false, source: "poll:catalog-index", updatedAt: at.toISOString() },
      { productId: "c", price: "$30", source: "poll:catalog-index", updatedAt: at.toISOString() },
    ]);
    // no title/description/tags leak into the money-facts (mirror image of productEmbedText)
    expect(JSON.stringify(facts)).not.toContain("desc");
    expect(JSON.stringify(facts)).not.toContain("title");
  });
});

/** A ProductFactsPort that records every upsert, over a real in-memory store; can be made to throw. */
function spyFacts(opts: { throwOnUpsert?: boolean } = {}): ProductFactsPort & { upserts: { tenantId: string; facts: ProductFact[] }[] } {
  const inner = createInMemoryProductFactsStore();
  const upserts: { tenantId: string; facts: ProductFact[] }[] = [];
  return {
    upserts,
    async getMany(tenantId, ids) { return inner.getMany(tenantId, ids); },
    async upsertMany(tenantId, facts) {
      upserts.push({ tenantId, facts });
      if (opts.throwOnUpsert) throw new Error("facts store down");
      return inner.upsertMany(tenantId, facts);
    },
    async deleteTenant(tenantId) { return inner.deleteTenant(tenantId); },
  };
}

describe("A3 — runCatalogIndex populates the product-facts store when the dep is present", () => {
  it("upserts fresh facts for the re-fetched catalog, hydrate-able by id afterwards", async () => {
    const pid = "gid://shopify/Product/serum";
    const h = harness([product("serum", { price: "$34", availableForSale: true })]);
    const facts = spyFacts();
    const [report] = await runCatalogIndex({ store: h.store, vector: h.vector, model: h.model, catalog: h.catalog, productFacts: facts }, [h.tenantId], { maxProducts: 5 });
    expect(report!.outcome).toBe("indexed");
    expect(facts.upserts).toHaveLength(1);
    const got = await facts.getMany(h.tenantId, [pid]);
    expect(got).toEqual([expect.objectContaining({ productId: pid, price: "$34", availableForSale: true, source: "poll:catalog-index" })]);
  });

  it("is INERT with no dep — the run is unaffected and nothing is written (byte-identical to before)", async () => {
    const h = harness([product("serum", { price: "$34" })]);
    const [report] = await runCatalogIndex({ store: h.store, vector: h.vector, model: h.model, catalog: h.catalog }, [h.tenantId], { maxProducts: 5 });
    expect(report!.outcome).toBe("indexed"); // unchanged behaviour; no facts store touched (none provided)
  });

  it("refreshes facts even when the catalog is UNCHANGED (no vector re-embed) — price/availability move constantly", async () => {
    const h = harness([product("serum", { price: "$34" })]);
    const facts = spyFacts();
    const deps = { store: h.store, vector: h.vector, model: h.model, catalog: h.catalog, productFacts: facts };
    await runCatalogIndex(deps, [h.tenantId], { maxProducts: 5 });
    const [second] = await runCatalogIndex(deps, [h.tenantId], { maxProducts: 5 });
    expect(second!.outcome).toBe("unchanged"); // vector corpus not re-embedded…
    expect(facts.upserts).toHaveLength(2); // …but facts refreshed on BOTH runs
  });

  it("FAILS SAFE — a facts-store error is swallowed and the vector index still completes", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const h = harness([product("serum", { price: "$34" })]);
      const facts = spyFacts({ throwOnUpsert: true });
      const [report] = await runCatalogIndex({ store: h.store, vector: h.vector, model: h.model, catalog: h.catalog, productFacts: facts }, [h.tenantId], { maxProducts: 5 });
      expect(report!.outcome).toBe("indexed"); // primary job unaffected by the facts failure
      expect(await idsIn(h.vector, h.tenantId)).not.toHaveLength(0); // corpus was written
    } finally {
      err.mockRestore();
    }
  });

  it("P2 (§5) — a successful facts write is logged to the immutable audit log", async () => {
    const h = harness([product("serum", { price: "$34" }), product("cream", { price: "$20" })]);
    await runCatalogIndex({ store: h.store, vector: h.vector, model: h.model, catalog: h.catalog, productFacts: spyFacts() }, [h.tenantId], { maxProducts: 5 });
    const rec = (await h.store.readAudit({ tenantId: h.tenantId })).find((a) => a.action === "catalog.product_facts");
    expect(rec).toBeDefined();
    expect(rec!.actor).toBe(CATALOG_INDEX_ACTOR);
    expect(rec!.input).toMatchObject({ tenantId: h.tenantId, count: 2, source: "poll:catalog-index" });
    expect(rec!.reversalPath).toMatch(/deleteTenant/);
  });

  it("P3 — a facts-write failure raises the stably-keyed alert marker (for a log-based metric/alert)", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const h = harness([product("serum", { price: "$34" })]);
      await runCatalogIndex({ store: h.store, vector: h.vector, model: h.model, catalog: h.catalog, productFacts: spyFacts({ throwOnUpsert: true }) }, [h.tenantId], { maxProducts: 5 });
      const said = err.mock.calls.flat().join(" ");
      expect(said).toContain("product_facts_upsert_failed");
      expect(said).toContain(`tenant=${h.tenantId}`);
      expect(said).not.toContain("product_facts_audit_failed"); // the upsert failed, so this is the upsert marker
    } finally {
      err.mockRestore();
    }
  });
});
