import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readdirSync, readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireEmbedInputs, type EmbedRequest, type EmbedResponse, type ModelPort } from "@palup/platform-ports";
import { startPgvectorContainer, PGVECTOR_AVAILABLE } from "@palup/state-postgres/test/helpers/pgvector-container";
import { runRetrievalEval } from "../src/eval-retrieval.js";
import { generateScaleCorpusAndCases } from "../src/retrieval-eval.js";
import type { RetrievalPromotionEvidence } from "../src/retrieval-promotion-evidence.js";

// S4 §5 fix-round (FIX 1 — the headline final-review fix). Before this test, `pnpm eval:retrieval` and
// `pnpm shadow:retrieval` always ran against a fixed 13-product fixture over an IN-MEMORY store and wrote
// NO artifact — the exact commands the §5 evidence procedure (docs/DEPLOY.md, docs/HITL-POLICY.md §5) tells
// an operator to run produced nothing durable. This test proves the CLI's actual runner (`runRetrievalEval`,
// extracted from `eval-retrieval.ts`'s `main()`) now:
//   1. routes through the SAME `createRuntimeStore`/`createVectorStore` composition root serving uses when
//      VECTOR_ANN=true + DATABASE_URL is set (here: pointed at a pgvector TESTCONTAINER, not a real
//      Vertex-backed deployment — that stays the operator's real-Vertex-at-scale step, per FIX 1's scope);
//   2. actually builds a pgvector-backed retriever that retrieves correctly over a scale-representative
//      corpus (`generateScaleCorpusAndCases`, the S4 §D corpus-override mechanism); and
//   3. writes a schema-correct `RetrievalPromotionEvidence` artifact to disk.
// A FAKE embed model stands in for Vertex (deterministic bag-of-words — no real creds needed), same pattern
// `retrieval-promotion-evidence.test.ts` already established for the harness level; this test is at the
// CLI-entry level (`runRetrievalEval`, what `main()` actually calls) rather than the harness.

const DIMENSION = 32;
function fakeModel(): ModelPort {
  return {
    async complete() {
      throw new Error("unused");
    },
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
      return { vectors, model: "fake-embed-cli-bow-32", dimension: DIMENSION, purpose: req.purpose };
    },
  };
}

describe.skipIf(!PGVECTOR_AVAILABLE)("eval-retrieval CLI — VECTOR_ANN routing + evidence artifact (fake embed, real pgvector)", () => {
  let url: string;
  let stop: () => Promise<void>;
  beforeAll(async () => {
    ({ url, stop } = await startPgvectorContainer());
  }, 120_000);
  afterAll(async () => {
    await stop?.();
  }, 120_000);

  it(
    "with VECTOR_ANN=true + DATABASE_URL, builds a real pgvector-backed retriever and writes a schema-correct evidence artifact",
    async () => {
      const evidenceDir = mkdtempSync(join(tmpdir(), "s4-eval-cli-"));
      // A synthetic env passed to `runRetrievalEval` (NOT process.env) proves the wiring reads its own
      // `env` option rather than a global — but `createRuntimeStore`/`createVectorStore` (state-postgres)
      // read `process.env` directly (the SAME single-source-of-truth the S4 doc comments describe), so
      // DATABASE_URL/VECTOR_ANN must be set there for this run's store selection to actually reach pgvector.
      const prevDbUrl = process.env.DATABASE_URL;
      const prevAnn = process.env.VECTOR_ANN;
      const prevDim = process.env.PALUP_EMBED_DIMENSION;
      process.env.DATABASE_URL = url;
      process.env.VECTOR_ANN = "true";
      // `createVectorStore` sizes the pgvector column from PALUP_EMBED_DIMENSION (default 1536, the real
      // Vertex embedding size) — must match the fake model's DIMENSION here or PgVectorStore fail-closed
      // rejects every upsert as wrong-dimension.
      process.env.PALUP_EMBED_DIMENSION = String(DIMENSION);
      try {
        const corpus = generateScaleCorpusAndCases(200);
        const result = await runRetrievalEval(fakeModel(), {
          env: process.env,
          tenantId: "acme-cli",
          corpus,
          evidenceDir,
        });

        // 1. Real pgvector was actually selected (not a silent in-memory fallback).
        expect(result.vectorAnn).toBe(true);
        expect(result.storeKind).toBe("postgres/ann");

        // 2. The retriever built over pgvector actually retrieves correctly at scale.
        expect(result.corpusSize).toBe(202); // 2 signal products + 200 generated filler
        expect(result.defaultK).toBe(5); // generateScaleCorpusAndCases's own `_meta.k`, not the CLI's own default of 3
        for (const r of result.rows) expect(r.pass, `case ${r.id} failed: ${r.fails.join("; ")}`).toBe(true);

        // 3. A schema-correct evidence artifact was written to disk.
        expect(result.evidencePath).toBeDefined();
        const written = JSON.parse(readFileSync(result.evidencePath!, "utf8")) as RetrievalPromotionEvidence;
        expect(written.tenantId).toBe("acme-cli");
        expect(written.model).toBe("fake-embed-cli-bow-32");
        expect(written.dimension).toBe(DIMENSION);
        expect(written.corpusSize).toBe(202);
        expect(written.recallAtK).toBe(1);
        expect(written.noWrongProduct).toBe(1);
        expect(written.vectorAnn).toBe(true);
        expect(written.shadow).toBeNull(); // eval-retrieval does not run the shadow harness
        expect(new Date(written.at).toString()).not.toBe("Invalid Date");
        expect(readdirSync(evidenceDir).some((f) => f.includes("acme-cli"))).toBe(true);

        // End this run's pool BEFORE `afterAll` stops the container — otherwise the container's shutdown
        // kills the still-open connection and that surfaces as an unhandled rejection (the same hazard
        // pgvector-container.ts's own `stop()` closes the pool first to avoid).
        await result.close();
      } finally {
        if (prevDbUrl === undefined) delete process.env.DATABASE_URL;
        else process.env.DATABASE_URL = prevDbUrl;
        if (prevAnn === undefined) delete process.env.VECTOR_ANN;
        else process.env.VECTOR_ANN = prevAnn;
        if (prevDim === undefined) delete process.env.PALUP_EMBED_DIMENSION;
        else process.env.PALUP_EMBED_DIMENSION = prevDim;
        rmSync(evidenceDir, { recursive: true, force: true });
      }
    },
    120_000,
  );

  it(
    "VECTOR_ANN unset ⇒ in-memory (unchanged back-compat default), still writes evidence",
    async () => {
      const evidenceDir = mkdtempSync(join(tmpdir(), "s4-eval-cli-mem-"));
      try {
        const corpus = generateScaleCorpusAndCases(10);
        const result = await runRetrievalEval(fakeModel(), {
          env: {},
          tenantId: "acme-mem",
          corpus,
          evidenceDir,
        });
        expect(result.vectorAnn).toBe(false);
        expect(result.storeKind).toBe("memory");
        expect(result.evidencePath).toBeDefined();
      } finally {
        rmSync(evidenceDir, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
