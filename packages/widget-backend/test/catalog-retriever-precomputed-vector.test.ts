import { describe, it, expect } from "vitest";
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
import { createCatalogRetriever } from "../src/catalog-retriever.js";
import {
  MANIFEST_COLLECTION,
  MANIFEST_KEY,
  catalogNamespace,
  catalogRecordId,
  type CatalogManifest,
} from "../src/jobs/catalog-index.js";

// semantic-memory-v1, PR3, T8 — `CatalogRetrieverPort.retrieve` (widget-brain/src/types.ts) now accepts an
// optional PRE-COMPUTED `queryVector`/`pin` (the brain's shared turn-embedder). This file pins the ADAPTER
// half of that contract on the REAL `createCatalogRetriever` (widget-backend/src/catalog-retriever.ts):
// when a precomputed vector is supplied AND its `pin` matches this corpus's own manifest, `retrieve()`
// MUST skip its own internal `model.embed` call entirely and rank directly against the given vector.
// Falling back to its own embed (today's only behavior) remains correct whenever the vector is absent, or
// the pin does not match this corpus's pin — mirrored below as goldens.
//
// RED TODAY, FOR AN UNAMBIGUOUS REASON: `createCatalogRetriever`'s `retrieve` (catalog-retriever.ts:100)
// destructures only `{tenantId, query, k}` and unconditionally calls `deps.model.embed(...)` — it does not
// read `queryVector`/`pin` from its argument at all yet, so every test below that supplies a matching
// precomputed vector and expects the embedder to be SKIPPED fails on the "embed call count" assertion.

const TENANT = "acme-precomputed";

/** Deterministic offline embedder — same shared-validator discipline as every other fake in this package. */
function fakeEmbedder(opts: { dimension?: number; model?: string } = {}) {
  const calls: EmbedRequest[] = [];
  const dimension = opts.dimension ?? 4;
  const model = opts.model ?? "fake-embed-4d";
  const port: ModelPort = {
    async complete() {
      return { text: "ok", model };
    },
    async embed(req: EmbedRequest): Promise<EmbedResponse> {
      calls.push({ ...req, texts: [...req.texts] });
      requireEmbedInputs(req);
      const vectors = req.texts.map((t) => {
        const v = new Array<number>(dimension).fill(0);
        for (let i = 0; i < t.length; i++) v[i % dimension] = (v[i % dimension] ?? 0) + t.charCodeAt(i);
        return v;
      });
      const res: EmbedResponse = { vectors, dimension, model, purpose: req.purpose };
      requireEmbedAlignment(req, res);
      return res;
    },
  };
  return { port, calls };
}

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
    at: "2026-08-17T00:00:00.000Z",
    ceiling: 1000,
    ...manifest,
  } satisfies CatalogManifest);
  return { store, vector };
}

describe("T8 — createCatalogRetriever accepts a precomputed queryVector/pin (turn-embed reuse)", () => {
  it("a MATCHING precomputed vector skips the retriever's own embed call entirely, and ranks directly against it", async () => {
    // Vectors chosen so a query aligned with p3 ranks p3 first, exactly like this package's existing
    // "returns product IDS ... nearest first" test — but here the vector is handed in, never embedded.
    const { store, vector } = await seedCorpus(["p1", "p2", "p3"], {}, (id) =>
      id === "p3" ? [1, 0, 0, 0] : id === "p2" ? [1, 1, 0, 0] : [0, 1, 0, 0],
    );
    const { port, calls } = fakeEmbedder();
    const { hits } = await createCatalogRetriever({ store, vector, model: port }).retrieve({
      tenantId: TENANT,
      query: "something for redness",
      k: 2,
      queryVector: [1, 0, 0, 0],
      pin: { model: "fake-embed-4d", dimension: 4 }, // matches the seeded manifest exactly
    });
    expect(calls).toHaveLength(0); // TODAY: 1 — the adapter always embeds regardless of queryVector
    expect(hits.map((h) => h.productId)).toEqual(["p3", "p2"]);
  });

  it("a MODEL-mismatched pin falls back to the retriever's own embed (today's behavior) rather than trusting a cross-space vector", async () => {
    const { store, vector } = await seedCorpus(["p1"]);
    const { port, calls } = fakeEmbedder();
    await createCatalogRetriever({ store, vector, model: port }).retrieve({
      tenantId: TENANT,
      query: "q",
      k: 5,
      queryVector: [9, 9, 9, 9],
      pin: { model: "some-other-model", dimension: 4 }, // does NOT match the seeded manifest's model
    });
    expect(calls).toHaveLength(1); // fell back — embedded the query itself
  });

  it("a DIMENSION-mismatched pin falls back to the retriever's own embed", async () => {
    const { store, vector } = await seedCorpus(["p1"]);
    const { port, calls } = fakeEmbedder();
    await createCatalogRetriever({ store, vector, model: port }).retrieve({
      tenantId: TENANT,
      query: "q",
      k: 5,
      queryVector: [9, 9, 9, 9, 9, 9, 9, 9],
      pin: { model: "fake-embed-4d", dimension: 8 }, // does NOT match the seeded manifest's dimension (4)
    });
    expect(calls).toHaveLength(1);
  });

  it("queryVector present but NO pin supplied at all falls back to the retriever's own embed (a vector is never trusted without a pin to check it against)", async () => {
    const { store, vector } = await seedCorpus(["p1"]);
    const { port, calls } = fakeEmbedder();
    await createCatalogRetriever({ store, vector, model: port }).retrieve({
      tenantId: TENANT,
      query: "q",
      k: 5,
      queryVector: [1, 0, 0, 0],
      // no `pin`
    });
    expect(calls).toHaveLength(1);
  });

  it("GOLDEN — no queryVector at all is byte-identical to today: always embeds", async () => {
    const { store, vector } = await seedCorpus(["p1"]);
    const { port, calls } = fakeEmbedder();
    await createCatalogRetriever({ store, vector, model: port }).retrieve({ tenantId: TENANT, query: "q", k: 5 });
    expect(calls).toHaveLength(1);
  });
});
