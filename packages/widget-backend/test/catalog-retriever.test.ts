import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_CATALOG_RETRIEVAL_K } from "@palup/widget-brain";
import {
  InMemoryRuntimeStore,
  createInMemoryVectorStore,
  requireEmbedAlignment,
  requireEmbedInputs,
  type EmbedRequest,
  type EmbedResponse,
  type ModelPort,
  type VectorPort,
} from "@palup/platform-ports";
import {
  CATALOG_RETRIEVAL_AGENT_TYPE,
  createCatalogRetriever,
} from "../src/catalog-retriever.js";
import {
  MANIFEST_COLLECTION,
  MANIFEST_KEY,
  MAX_INDEXED_PRODUCTS,
  VECTOR_SCAN_ROWS_MIRRORED,
  catalogNamespace,
  catalogRecordId,
  type CatalogManifest,
} from "../src/jobs/catalog-index.js";

// E1 — the QUERY side of the catalog corpus C3 (#190) writes. This adapter is the only thing in the repo
// that turns a shopper's turn into an embedding and a vector query; the brain depends on the narrow
// `CatalogRetrieverPort` interface and knows none of this.
//
// WHAT THESE TESTS DO NOT CLAIM. The embedder below is the same char-code fake the rest of the repo uses.
// It proves the adapter's REFUSALS and its plumbing; it says nothing at all about whether real embeddings
// retrieve the right products. That is the eval gate's question, on real embeddings, before promotion.

const TENANT = "acme";

/** Deterministic offline embedder that calls the same shared validators every real adapter must. */
function fakeEmbedder(opts: { dimension?: number; model?: string; throws?: Error; lyingPurpose?: boolean } = {}) {
  const calls: EmbedRequest[] = [];
  const dimension = opts.dimension ?? 4;
  const model = opts.model ?? "fake-embed-4d";
  const port: ModelPort = {
    async complete() {
      return { text: "ok", model };
    },
    async embed(req: EmbedRequest): Promise<EmbedResponse> {
      calls.push({ ...req, texts: [...req.texts] });
      if (opts.throws) throw opts.throws;
      requireEmbedInputs(req);
      const vectors = req.texts.map((t) => {
        const v = new Array<number>(dimension).fill(0);
        for (let i = 0; i < t.length; i++) v[i % dimension] = (v[i % dimension] ?? 0) + t.charCodeAt(i);
        return v;
      });
      const res: EmbedResponse = {
        vectors,
        dimension,
        model,
        purpose: opts.lyingPurpose ? "document" : req.purpose,
      };
      if (!opts.lyingPurpose) requireEmbedAlignment(req, res);
      return res;
    },
  };
  return { port, calls };
}

/** A complete-only adapter: the capability is ABSENT, never a throwing stub (#188's rule). */
const completeOnly: ModelPort = {
  async complete() {
    return { text: "ok", model: "complete-only" };
  },
};

interface Fixture {
  store: InMemoryRuntimeStore;
  vector: VectorPort;
}

async function seedCorpus(
  productIds: string[],
  manifest: Partial<CatalogManifest> = {},
  vectorFor: (id: string, i: number) => number[] = (_id, i) => [i + 1, 0, 0, 0],
): Promise<Fixture> {
  const store = new InMemoryRuntimeStore();
  const vector = createInMemoryVectorStore();
  await vector.upsert(
    catalogNamespace(TENANT),
    productIds.map((id, i) => ({
      id: catalogRecordId(id),
      vector: vectorFor(id, i),
      metadata: { kind: "product", productId: id, contentHash: `h${i}` },
    })),
  );
  await store.put({ tenantId: TENANT }, MANIFEST_COLLECTION, MANIFEST_KEY, {
    model: "fake-embed-4d",
    dimension: 4,
    purpose: "document",
    products: productIds.length,
    at: "2026-08-06T00:00:00.000Z",
    ceiling: 1000,
    ...manifest,
  } satisfies CatalogManifest);
  return { store, vector };
}

describe("E1 — createCatalogRetriever: the query side of the catalog corpus", () => {
  it("embeds the shopper's turn with purpose QUERY (never the corpus's document purpose)", async () => {
    const { store, vector } = await seedCorpus(["p1", "p2"]);
    const { port, calls } = fakeEmbedder();
    const retriever = createCatalogRetriever({ store, vector, model: port });
    await retriever.retrieve({ tenantId: TENANT, query: "something for redness", k: 5 });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ texts: ["something for redness"], purpose: "query", tenantId: TENANT });
  });

  it("returns product IDS resolved from record metadata, nearest first, capped at k", async () => {
    // Vectors chosen so the query [1,0,0,0] ranks p3 (identical) above p2 above p1.
    const { store, vector } = await seedCorpus(["p1", "p2", "p3"], {}, (id) =>
      id === "p3" ? [1, 0, 0, 0] : id === "p2" ? [1, 1, 0, 0] : [0, 1, 0, 0],
    );
    const model: ModelPort = {
      async complete() {
        return { text: "ok", model: "fake-embed-4d" };
      },
      async embed() {
        return { vectors: [[1, 0, 0, 0]], dimension: 4, model: "fake-embed-4d", purpose: "query" };
      },
    };
    const { hits } = await createCatalogRetriever({ store, vector, model }).retrieve({
      tenantId: TENANT,
      query: "q",
      k: 2,
    });
    expect(hits.map((h) => h.productId)).toEqual(["p3", "p2"]);
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
  });

  it("never returns a record it cannot resolve to a product id (a corpus it does not understand)", async () => {
    const { store, vector } = await seedCorpus(["p1"]);
    await vector.upsert(catalogNamespace(TENANT), [
      { id: "product:mystery", vector: [9, 9, 9, 9], metadata: { kind: "something-else" } },
    ]);
    const { port } = fakeEmbedder();
    const { hits } = await createCatalogRetriever({ store, vector, model: port }).retrieve({
      tenantId: TENANT,
      query: "q",
      k: 10,
    });
    expect(hits.every((h) => typeof h.productId === "string" && h.productId.length > 0)).toBe(true);
    expect(hits.map((h) => h.productId)).not.toContain("mystery");
  });

  it("is scoped to the tenant's own corpus namespace and can never read another tenant's", async () => {
    const { store, vector } = await seedCorpus(["p1"]);
    await vector.upsert(catalogNamespace("other-tenant"), [
      { id: catalogRecordId("secret"), vector: [1, 0, 0, 0], metadata: { kind: "product", productId: "secret" } },
    ]);
    const { port } = fakeEmbedder();
    const { hits } = await createCatalogRetriever({ store, vector, model: port }).retrieve({
      tenantId: TENANT,
      query: "q",
      k: 10,
    });
    expect(hits.map((h) => h.productId)).not.toContain("secret");
  });

  it("names the agent type the composition root must meter this spend under", () => {
    expect(CATALOG_RETRIEVAL_AGENT_TYPE).toBe("catalog-retrieval");
  });

  it("k and the corpus both stay clear of the vector adapter's id-ORDER row-scan truncation", () => {
    // postgres-vector-store.ts caps every query() at MAX_SCAN_ROWS with `ORDER BY id LIMIT` — ID ORDER,
    // NOT RELEVANCE — so a corpus larger than that cap would silently lose whichever records sort late by
    // id BEFORE anything is scored. Retrieval is the first code that actually RANKS this corpus, so the
    // headroom matters here in a way it did not on the write side: read the real constant out of the real
    // file, and pin that a full-size corpus is scanned WHOLE.
    const src = readFileSync(new URL("../../state-postgres/src/postgres-vector-store.ts", import.meta.url), "utf8");
    const scanCap = Number(/MAX_SCAN_ROWS = (\d+)/.exec(src)?.[1]);
    expect(scanCap).toBe(VECTOR_SCAN_ROWS_MIRRORED);
    // The largest corpus the index job will ever write is well under the scan cap (5x headroom at the
    // values in force), so every record is scored on every query and the truncation never engages…
    expect(MAX_INDEXED_PRODUCTS).toBeLessThan(scanCap);
    // …and k is the slice taken AFTER ranking, orders of magnitude below either bound.
    expect(DEFAULT_CATALOG_RETRIEVAL_K).toBeLessThan(MAX_INDEXED_PRODUCTS);
  });
});

describe("E1 — the retriever REFUSES rather than ranking against a corpus it cannot trust", () => {
  it("refuses when the tenant has no corpus manifest at all", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const { port, calls } = fakeEmbedder();
    await expect(
      createCatalogRetriever({ store, vector, model: port }).retrieve({ tenantId: TENANT, query: "q", k: 5 }),
    ).rejects.toThrow(/no catalog corpus/i);
    expect(calls).toHaveLength(0); // and it refuses BEFORE spending an embedding call
  });

  it("refuses when this deployment's adapter cannot embed at all (a capability ABSENCE, not a failure)", async () => {
    const { store, vector } = await seedCorpus(["p1"]);
    await expect(
      createCatalogRetriever({ store, vector, model: completeOnly }).retrieve({ tenantId: TENANT, query: "q", k: 5 }),
    ).rejects.toThrow(/cannot embed/i);
  });

  it("refuses when the query's embedding MODEL differs from the corpus's pin", async () => {
    const { store, vector } = await seedCorpus(["p1"]);
    const { port } = fakeEmbedder({ model: "some-other-model" });
    await expect(
      createCatalogRetriever({ store, vector, model: port }).retrieve({ tenantId: TENANT, query: "q", k: 5 }),
    ).rejects.toThrow(/pinned/i);
  });

  it("refuses when the query's DIMENSION differs from the corpus's pin", async () => {
    const { store, vector } = await seedCorpus(["p1"]);
    const { port } = fakeEmbedder({ dimension: 8 });
    await expect(
      createCatalogRetriever({ store, vector, model: port }).retrieve({ tenantId: TENANT, query: "q", k: 5 }),
    ).rejects.toThrow(/pinned/i);
  });

  it("THE B3 GAP: refuses a corpus that was itself embedded with QUERY purpose", async () => {
    // A corpus built by an adapter whose task type defaulted to RETRIEVAL_QUERY reports the SAME model and
    // the SAME dimension as a correct one — {model, dimension} alone cannot see it. The manifest's
    // `purpose` is what makes it visible, and this refusal is what makes it actionable.
    const { store, vector } = await seedCorpus(["p1"], { purpose: "query" });
    const { port, calls } = fakeEmbedder();
    await expect(
      createCatalogRetriever({ store, vector, model: port }).retrieve({ tenantId: TENANT, query: "q", k: 5 }),
    ).rejects.toThrow(/purpose/i);
    expect(calls).toHaveLength(0); // detected from the manifest, before any spend
  });

  it("refuses a legacy manifest that predates the purpose pin rather than assuming it was a document corpus", async () => {
    const { store, vector } = await seedCorpus(["p1"]);
    const legacy = (await store.get<CatalogManifest>({ tenantId: TENANT }, MANIFEST_COLLECTION, MANIFEST_KEY))!;
    delete (legacy as Partial<CatalogManifest>).purpose;
    await store.put({ tenantId: TENANT }, MANIFEST_COLLECTION, MANIFEST_KEY, legacy);
    const { port } = fakeEmbedder();
    await expect(
      createCatalogRetriever({ store, vector, model: port }).retrieve({ tenantId: TENANT, query: "q", k: 5 }),
    ).rejects.toThrow(/purpose/i);
  });

  it("refuses when the embedder ignored the requested purpose and answered with a document embedding", async () => {
    const { store, vector } = await seedCorpus(["p1"]);
    const { port } = fakeEmbedder({ lyingPurpose: true });
    await expect(
      createCatalogRetriever({ store, vector, model: port }).retrieve({ tenantId: TENANT, query: "q", k: 5 }),
    ).rejects.toThrow(/purpose/i);
  });

  it("lets a provider failure surface as a failure (the brain falls back to the full catalog)", async () => {
    const { store, vector } = await seedCorpus(["p1"]);
    const { port } = fakeEmbedder({ throws: new Error("provider 503") });
    await expect(
      createCatalogRetriever({ store, vector, model: port }).retrieve({ tenantId: TENANT, query: "q", k: 5 }),
    ).rejects.toThrow(/503/);
  });

  it("refuses a blank query rather than embedding whitespace", async () => {
    const { store, vector } = await seedCorpus(["p1"]);
    const { port, calls } = fakeEmbedder();
    await expect(
      createCatalogRetriever({ store, vector, model: port }).retrieve({ tenantId: TENANT, query: "   ", k: 5 }),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});
