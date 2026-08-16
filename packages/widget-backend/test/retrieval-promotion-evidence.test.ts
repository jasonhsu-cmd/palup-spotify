import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InMemoryRuntimeStore,
  requireEmbedInputs,
  type EmbedRequest,
  type EmbedResponse,
  type ModelPort,
} from "@palup/platform-ports";
import { PgVectorStore, type Sql } from "@palup/state-postgres";
import { startPgvectorContainer, PGVECTOR_AVAILABLE } from "@palup/state-postgres/test/helpers/pgvector-container";
import { buildIndexedRetriever, gradeRetrieval, generateScaleCorpus } from "../src/retrieval-eval.js";
import { writeRetrievalEvidence, type RetrievalPromotionEvidence } from "../src/retrieval-promotion-evidence.js";

const DIMENSION = 32;
/** Deterministic bag-of-words embed so a token match ranks first (no Vertex). */
function fakeModel(): ModelPort {
  return {
    async complete() { throw new Error("unused"); },
    async embed(req: EmbedRequest): Promise<EmbedResponse> {
      requireEmbedInputs(req);
      const vectors = req.texts.map((t) => {
        const v = new Array<number>(DIMENSION).fill(0);
        for (const tok of t.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
          let h = 0;
          for (let i = 0; i < tok.length; i++) h = (h * 31 + tok.charCodeAt(i)) >>> 0;
          v[h % DIMENSION] += 1;
        }
        const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
        return v.map((x) => x / norm);
      });
      return { vectors, model: "fake-embed-bow-32", dimension: DIMENSION, purpose: req.purpose };
    },
  };
}

describe("retrieval-promotion — evidence writer + scale corpus", () => {
  it("generateScaleCorpus produces N unique-id products", () => {
    const corpus = generateScaleCorpus(5000);
    expect(corpus.length).toBe(5000);
    expect(new Set(corpus.map((p) => p.id)).size).toBe(5000);
  });

  it("writeRetrievalEvidence emits the §D schema to reports/…json and returns the path", () => {
    const dir = mkdtempSync(join(tmpdir(), "s4-evidence-"));
    try {
      const ev: RetrievalPromotionEvidence = {
        tenantId: "acme", model: "fake-embed-bow-32", dimension: 32, corpusSize: 5000,
        recallAtK: 1, noWrongProduct: 1, shadow: { fabricated: 0, stale: 0, missingProduct: 0 },
        vectorAnn: true, at: new Date().toISOString(),
      };
      const path = writeRetrievalEvidence(ev, dir);
      expect(path).toMatch(/retrieval-promotion-evidence-acme-.*\.json$/);
      const written = JSON.parse(readFileSync(path, "utf8"));
      expect(written).toEqual(ev);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!PGVECTOR_AVAILABLE)("retrieval-promotion — harness wires to real pgvector (fake embed)", () => {
  let sql: Sql;
  let stop: () => Promise<void>;
  beforeAll(async () => {
    ({ sql, stop } = await startPgvectorContainer());
    await new PgVectorStore(sql, { dimension: DIMENSION, efSearch: 40 }).migrate();
  }, 120_000);
  afterAll(async () => { await stop?.(); }, 120_000);

  it("indexes a scale corpus into pgvector, retrieves the token-matching product, grades, writes evidence", async () => {
    await sql.query("TRUNCATE vp_ann");
    const vector = new PgVectorStore(sql, { dimension: DIMENSION, efSearch: 40 });
    const store = new InMemoryRuntimeStore();
    // Seed 3 discriminable products among the synthetic bulk, so the fake bow-embed has a clear top-1.
    const corpus = [
      { id: "p-apple", title: "Crisp Apple", price: "$1", description: "crunchy sweet apple orchard fruit", tags: ["apple"] },
      { id: "p-banana", title: "Ripe Banana", price: "$2", description: "soft yellow banana tropical fruit", tags: ["banana"] },
      ...generateScaleCorpus(200),
    ];
    const { retriever, tenantId } = await buildIndexedRetriever(corpus, fakeModel(), "acme", store, vector);
    const { hits } = await retriever.retrieve({ tenantId, query: "crunchy sweet apple", k: 5 });
    expect(hits[0]?.productId).toBe("p-apple");
    const g = gradeRetrieval({ id: "apple", query: "crunchy sweet apple", expectTop: "p-apple" }, hits);
    expect(g.pass).toBe(true);
  });
});
