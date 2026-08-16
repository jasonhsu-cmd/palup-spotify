import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelPort, EmbedRequest, EmbedResponse } from "@palup/platform-ports";
import { buildIndexedRetriever, gradeRetrieval, type RetrievalCase, type RetrievalProduct } from "../src/retrieval-eval.js";

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
