import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { InMemoryRuntimeStore, createInMemoryVectorStore, type ModelPort, type EmbedRequest, type EmbedResponse } from "@palup/platform-ports";
import { buildIndexedRetriever, gradeRetrieval, generateScaleCorpusAndCases, type RetrievalCase, type RetrievalProduct } from "../src/retrieval-eval.js";

// CATALOG_RETRIEVAL eval — plumbing + grader, gate-tested WITHOUT creds. A deterministic bag-of-words embed
// stands in for Vertex so we prove the harness plumbs the REAL index + retrieve paths (runCatalogIndex →
// manifest/purpose round-trip → createCatalogRetriever → top-k) and that the grader scores it. The
// real-embedding quality run is `pnpm eval:retrieval` (needs Vertex creds).

const DIM = 64;
/** Deterministic bag-of-words embedding: shared tokens ⇒ higher cosine. L2-normalized (non-negative, so the
 *  retriever's score>0 filter keeps only products that share a token with the query). */
function bow(text: string): number[] {
  const v = new Array<number>(DIM).fill(0);
  for (const tok of text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
    let h = 0;
    for (let i = 0; i < tok.length; i++) h = (h * 31 + tok.charCodeAt(i)) >>> 0;
    v[h % DIM] += 1;
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}
class FakeEmbedModel implements ModelPort {
  async complete(): Promise<never> {
    throw new Error("retrieval eval fake: complete() is not used by the retrieval path");
  }
  async embed(req: EmbedRequest): Promise<EmbedResponse> {
    return { vectors: req.texts.map(bow), model: "fake-embed-bow", dimension: DIM, purpose: req.purpose };
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(readFileSync(join(here, "..", "cases", "retrieval.json"), "utf8")) as {
  products: RetrievalProduct[];
  cases: RetrievalCase[];
  _meta?: { k?: number };
};

describe("CATALOG_RETRIEVAL eval — plumbing (real index + retrieve paths, fake embed)", () => {
  const synthetic: RetrievalProduct[] = [
    { id: "p-apple", title: "Crisp Apple", price: "$1", description: "a crunchy sweet apple orchard fruit", tags: ["apple", "orchard"] },
    { id: "p-banana", title: "Ripe Banana", price: "$2", description: "a soft yellow banana tropical fruit", tags: ["banana", "tropical"] },
    { id: "p-cherry", title: "Dark Cherry", price: "$3", description: "a tart red cherry stone fruit", tags: ["cherry", "tart"] },
  ];

  it("indexes then retrieves the token-matching product on top (index→manifest→retrieve→grade round-trip)", async () => {
    const { retriever, tenantId } = await buildIndexedRetriever(synthetic, new FakeEmbedModel(), "t-synth");
    for (const [query, want] of [["a sweet crunchy apple", "p-apple"], ["soft tropical banana", "p-banana"], ["tart red cherry", "p-cherry"]] as const) {
      const { hits } = await retriever.retrieve({ tenantId, query, k: 3 });
      expect(hits[0]?.productId, `query="${query}" hits=${JSON.stringify(hits)}`).toBe(want);
      expect(gradeRetrieval({ id: query, query, expectTop: want }, hits).pass).toBe(true);
    }
  });

  it("returns only products sharing a token (score>0 filter) — an unrelated query yields no false hit", async () => {
    const { retriever, tenantId } = await buildIndexedRetriever(synthetic, new FakeEmbedModel(), "t-synth2");
    const { hits } = await retriever.retrieve({ tenantId, query: "quantum spreadsheet compiler", k: 3 });
    expect(hits).toEqual([]);
  });
});

describe("CATALOG_RETRIEVAL eval — silent-clobber guard (never prune a real serving corpus)", () => {
  // Regression guard for the shadow:retrieval incident: buildIndexedRetriever indexes WITHOUT --reindex, so
  // pointed at a durable store already holding a REAL populated corpus it would treat that corpus's ids as
  // "stale" and DELETE them, rewriting the manifest to the tiny eval fixture (the real 2,150-product "demo"
  // corpus overwritten by the 13-product fixture). The guard must refuse BEFORE any write, and must NOT fire
  // on the benign cases (fresh store, idempotent re-index, growing the corpus).

  const serving: RetrievalProduct[] = [
    { id: "prod-1", title: "Serving Product One", price: "$10", description: "the real merchant corpus one", tags: ["real"] },
    { id: "prod-2", title: "Serving Product Two", price: "$11", description: "the real merchant corpus two", tags: ["real"] },
    { id: "prod-3", title: "Serving Product Three", price: "$12", description: "the real merchant corpus three", tags: ["real"] },
    { id: "prod-4", title: "Serving Product Four", price: "$13", description: "the real merchant corpus four", tags: ["real"] },
    { id: "prod-5", title: "Serving Product Five", price: "$14", description: "the real merchant corpus five", tags: ["real"] },
  ];
  const evalFixture: RetrievalProduct[] = [
    { id: "fix-a", title: "Eval Fixture A", price: "$1", description: "the small eval fixture a", tags: ["fixture"] },
    { id: "fix-b", title: "Eval Fixture B", price: "$2", description: "the small eval fixture b", tags: ["fixture"] },
  ];

  it("refuses to index over a pre-existing populated corpus that this eval corpus would prune, and leaves it intact", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    // Stand in for the real serving corpus already present under this (mis-set) serving tenant.
    const { retriever } = await buildIndexedRetriever(serving, new FakeEmbedModel(), "demo", store, vector);

    await expect(
      buildIndexedRetriever(evalFixture, new FakeEmbedModel(), "demo", store, vector),
    ).rejects.toThrow(/silent-clobber guard|ISOLATED eval-only tenant|shadow-eval/i);

    // The throw happens BEFORE any write, so the real corpus is untouched: its products still retrieve.
    const { hits } = await retriever.retrieve({ tenantId: "demo", query: "the real merchant corpus one", k: 5 });
    expect(hits.map((h) => h.productId)).toContain("prod-1");
    expect(hits.map((h) => h.productId)).not.toContain("fix-a");
  });

  it("allows an idempotent re-index of the SAME corpus on a shared durable store (prunes nothing)", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    await buildIndexedRetriever(serving, new FakeEmbedModel(), "eval-only", store, vector);
    const { retriever } = await buildIndexedRetriever(serving, new FakeEmbedModel(), "eval-only", store, vector);
    const { hits } = await retriever.retrieve({ tenantId: "eval-only", query: "the real merchant corpus two", k: 5 });
    expect(hits.map((h) => h.productId)).toContain("prod-2");
  });

  it("allows GROWING an existing corpus (superset ids) — nothing is pruned", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    await buildIndexedRetriever(serving.slice(0, 3), new FakeEmbedModel(), "eval-only", store, vector);
    const grown = [...serving, { id: "prod-6", title: "Serving Product Six", price: "$15", description: "the real merchant corpus six", tags: ["real"] }];
    const { retriever } = await buildIndexedRetriever(grown, new FakeEmbedModel(), "eval-only", store, vector);
    const { hits } = await retriever.retrieve({ tenantId: "eval-only", query: "the real merchant corpus six", k: 5 });
    expect(hits.map((h) => h.productId)).toContain("prod-6");
  });

  it("the default fresh in-memory store has no manifest, so a first index is never blocked", async () => {
    const { retriever, tenantId } = await buildIndexedRetriever(serving, new FakeEmbedModel(), "t-fresh");
    const { hits } = await retriever.retrieve({ tenantId, query: "the real merchant corpus three", k: 5 });
    expect(hits.map((h) => h.productId)).toContain("prod-3");
  });
});

describe("CATALOG_RETRIEVAL eval — grader", () => {
  const hits = [
    { productId: "serum", score: 0.9 },
    { productId: "cream", score: 0.7 },
    { productId: "toner", score: 0.5 },
  ];
  it("expectTop passes only for the rank-1 id", () => {
    expect(gradeRetrieval({ id: "x", query: "q", expectTop: "serum" }, hits).pass).toBe(true);
    expect(gradeRetrieval({ id: "x", query: "q", expectTop: "cream" }, hits).pass).toBe(false);
  });
  it("relevantInTopK passes when any relevant id is present; notInTopK fails when an irrelevant id appears", () => {
    expect(gradeRetrieval({ id: "x", query: "q", relevantInTopK: ["toner", "mask"] }, hits).pass).toBe(true);
    expect(gradeRetrieval({ id: "x", query: "q", relevantInTopK: ["mask", "oil"] }, hits).pass).toBe(false);
    expect(gradeRetrieval({ id: "x", query: "q", notInTopK: ["cream"] }, hits).pass).toBe(false);
    expect(gradeRetrieval({ id: "x", query: "q", notInTopK: ["lipbalm"] }, hits).pass).toBe(true);
  });
});

describe("CATALOG_RETRIEVAL eval — scale corpus/cases have a REALISTIC hard negative", () => {
  // Regression guard for the S4 §5 harness-validity fix. The prior cases used the SIBLING FRUIT
  // (`notInTopK: [other fruit]`), which only ever excludes under the fake orthogonal embed: on real
  // semantic embeddings "banana fruit" is genuinely closer to "apple fruit" than to gibberish filler,
  // so the sibling ranks #2 and that assertion can NEVER pass — the gate was structurally broken.
  // The corrected hard negative is a totally-unrelated hardware item (`sig-bolt`), which a good
  // retriever excludes from top-k on BOTH real and fake embeddings. Here we prove, end-to-end through
  // the real index+retrieve path with the fake embed, that: (a) the target fruit is top-1, and
  // (b) `sig-bolt` never surfaces in top-k — i.e. every graded case passes.

  it("each case's notInTopK is the unrelated hardware item, never the sibling fruit", () => {
    const { cases } = generateScaleCorpusAndCases(10);
    for (const c of cases) {
      expect(c.notInTopK, `${c.id}`).toEqual(["sig-bolt"]);
      expect(c.notInTopK).not.toContain("sig-apple");
      expect(c.notInTopK).not.toContain("sig-banana");
    }
  });

  it("target fruit ranks top-1 and the unrelated hardware item stays out of top-k (all cases grade pass)", async () => {
    const { products, cases, _meta } = generateScaleCorpusAndCases(50);
    const { retriever, tenantId } = await buildIndexedRetriever(products, new FakeEmbedModel(), "t-scale");
    for (const c of cases) {
      const { hits } = await retriever.retrieve({ tenantId, query: c.query, k: _meta.k });
      const ids = hits.map((h) => h.productId);
      expect(hits[0]?.productId, `case=${c.id} hits=${JSON.stringify(ids)}`).toBe(c.expectTop);
      expect(ids, `case=${c.id} leaked hardware item`).not.toContain("sig-bolt");
      expect(gradeRetrieval(c, hits).pass, `case=${c.id} fails=${gradeRetrieval(c, hits).fails.join("; ")}`).toBe(true);
    }
  });
});

describe("CATALOG_RETRIEVAL eval — corpus is well-formed", () => {
  it("products have unique ids; every case pins something and references only real product ids", () => {
    const ids = new Set(corpus.products.map((p) => p.id));
    expect(ids.size).toBe(corpus.products.length);
    for (const c of corpus.cases) {
      const pinned = [c.expectTop, ...(c.relevantInTopK ?? []), ...(c.notInTopK ?? [])].filter(Boolean) as string[];
      expect(pinned.length, `${c.id} pins nothing`).toBeGreaterThan(0);
      for (const id of pinned) expect(ids.has(id), `${c.id} references unknown product ${id}`).toBe(true);
    }
  });
});
