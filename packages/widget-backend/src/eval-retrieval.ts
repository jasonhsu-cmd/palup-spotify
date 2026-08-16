// CATALOG_RETRIEVAL (E1) — the retrieval-QUALITY eval runner. Indexes the corpus and runs each query
// through the REAL retriever on REAL Vertex embeddings, grading recall@k / no-wrong-product deterministically.
// This is the eval gate CATALOG_RETRIEVAL must pass before any live stage (eval → shadow → canary → human,
// HITL §5) — the promotion prerequisite for the whole hydration chain (docs/ADR-0020-PROMOTION-PLAN.md).
// Requires Vertex creds + an embed-capable adapter.
//   pnpm eval:retrieval
//
// S4 §5 fix-round (the headline final-review fix) — this CLI now actually produces the §5 evidence
// procedure the runbook (docs/DEPLOY.md) and HITL-POLICY §5 describe, instead of always running the fixed
// 13-product fixture against an in-memory store and writing nothing:
//   • VECTOR_ANN=true (+ DATABASE_URL) routes through the SAME store-selection composition root
//     (`createRuntimeStore`/`createVectorStore`, @palup/state-postgres) the serving path uses, so the run
//     indexes/retrieves against real pgvector, not the in-memory demo store. VECTOR_ANN unset keeps the
//     prior in-memory behavior (back-compat).
//   • RETRIEVAL_CORPUS_SIZE=<n> swaps the fixed 13-product fixture for `generateScaleCorpusAndCases(n)`
//     (retrieval-eval.ts) — a scale-representative synthetic corpus with graded cases. RETRIEVAL_CORPUS_FILE
//     points at a JSON file of the same `{products, cases, _meta}` shape for a real tenant's catalog.
//   • On completion, `writeRetrievalEvidence` emits `reports/retrieval-promotion-evidence-<tenant>-<stamp>.json`
//     with this run's real recall@k / no-wrong-product / model / dimension / corpus size. Shadow counts are
//     `null` here — they come from the companion `pnpm shadow:retrieval` artifact (see its own header).
// `runRetrievalEval` below is exported specifically so a test can exercise this exact path (store
// selection + corpus + grading + evidence write) against a pgvector TESTCONTAINER with a fake embed model,
// without needing real Vertex creds — `main()` below is the only place that requires Vertex, unchanged.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createVertexAdapter, isVertexConfigured } from "@palup/model-vertex";
import { canEmbed, InMemoryRuntimeStore, createInMemoryVectorStore } from "@palup/platform-ports";
import type { ModelPort, RuntimeStatePort, VectorPort } from "@palup/platform-ports";
import { createRuntimeStore, createVectorStore } from "@palup/state-postgres";
import {
  buildIndexedRetriever,
  gradeRetrieval,
  generateScaleCorpusAndCases,
  type RetrievalCase,
  type RetrievalProduct,
} from "./retrieval-eval.js";
import { writeRetrievalEvidence } from "./retrieval-promotion-evidence.js";

const here = dirname(fileURLToPath(import.meta.url));

export interface RetrievalEvalCorpus {
  products: RetrievalProduct[];
  cases: RetrievalCase[];
  _meta?: { k?: number };
}

export interface RunRetrievalEvalOptions {
  /** Defaults to `process.env`; controls THIS module's own env reads (tenant, corpus knobs, VECTOR_ANN
   *  routing). NOTE: `createRuntimeStore`/`createVectorStore` read `process.env` directly, so a pgvector
   *  (`VECTOR_ANN=true`) run still requires the real `process.env` to be set — this option does not fully
   *  isolate a run from the process environment. */
  env?: NodeJS.ProcessEnv;
  /** Defaults to `env.RETRIEVAL_TENANT ?? "eval-retrieval"`. */
  tenantId?: string;
  /** Overrides the corpus the run indexes/grades — tests use this to inject a scale corpus deterministically
   *  rather than depend on env parsing. Operators use `RETRIEVAL_CORPUS_SIZE` / `RETRIEVAL_CORPUS_FILE`. */
  corpus?: RetrievalEvalCorpus;
  /** Evidence output directory; defaults to `reports` (writeRetrievalEvidence's own default). Tests use a tmpdir. */
  evidenceDir?: string;
  /** Set false to skip writing the evidence artifact (unused by the CLI; available for narrower tests). */
  writeEvidence?: boolean;
}

export interface RunRetrievalEvalResult {
  rows: { id: string; pass: boolean; fails: string[] }[];
  defaultK: number;
  corpusSize: number;
  /** "memory" (no VECTOR_ANN/DATABASE_URL) or "<runtime kind>/<vector kind>" (e.g. "postgres/ann"). */
  storeKind: string;
  vectorAnn: boolean;
  evidencePath?: string;
  /** Ends the pool this run opened (VECTOR_ANN path); a no-op on the in-memory path. The CLI itself does
   *  not call this (it relies on the pool's own idle timeout, like jobs/catalog-index.ts's main()) — it
   *  exists for a caller (a test tearing down a pgvector testcontainer) that needs deterministic cleanup. */
  close: () => Promise<void>;
}

function loadDefaultCorpus(): RetrievalEvalCorpus {
  return JSON.parse(readFileSync(join(here, "..", "cases", "retrieval.json"), "utf8")) as RetrievalEvalCorpus;
}

/** Resolve the corpus per FIX 1's override precedence: explicit option > RETRIEVAL_CORPUS_FILE >
 *  RETRIEVAL_CORPUS_SIZE > the fixed 13-product fixture (unchanged default). */
function resolveCorpus(env: NodeJS.ProcessEnv, override?: RetrievalEvalCorpus): RetrievalEvalCorpus {
  if (override) return override;
  if (env.RETRIEVAL_CORPUS_FILE) return JSON.parse(readFileSync(env.RETRIEVAL_CORPUS_FILE, "utf8")) as RetrievalEvalCorpus;
  if (env.RETRIEVAL_CORPUS_SIZE) {
    const n = Number(env.RETRIEVAL_CORPUS_SIZE);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`RETRIEVAL_CORPUS_SIZE must be a positive number, got "${env.RETRIEVAL_CORPUS_SIZE}"`);
    return generateScaleCorpusAndCases(n);
  }
  return loadDefaultCorpus();
}

/** Resolve the store + vector port per FIX 1's VECTOR_ANN routing: `VECTOR_ANN=true` + `DATABASE_URL` set
 *  builds the SAME real Cloud SQL / pgvector adapters `createVectorStore` selects for serving (the S1
 *  pgvector-HNSW store when VECTOR_ANN=true); otherwise (unset, or VECTOR_ANN=true with no DATABASE_URL —
 *  logged, not silently ignored) falls back to the pre-existing in-memory demo behavior. */
async function resolveEvalStores(
  env: NodeJS.ProcessEnv,
): Promise<{ store: RuntimeStatePort; vector: VectorPort; storeKind: string; vectorAnn: boolean; close: () => Promise<void> }> {
  const wantsAnn = env.VECTOR_ANN === "true";
  if (wantsAnn && env.DATABASE_URL) {
    const runtime = await createRuntimeStore();
    const vec = await createVectorStore(runtime.sql);
    // `runtime.sql` is the ONE pool both stores share (mirrors server.ts). Exposed here as `close` — the
    // real operator CLI relies on the pool's own idle timeout to let the process exit (same as
    // jobs/catalog-index.ts's main()), but a test tearing down a pgvector TESTCONTAINER must end this pool
    // BEFORE the container stops, or the container's shutdown kills its still-open connections and that
    // surfaces as an unhandled rejection (pgvector-container.ts's own doc explains the same hazard).
    const close = async () => {
      await (runtime.sql as unknown as { pool?: { end(): Promise<void> } }).pool?.end().catch(() => {});
    };
    return { store: runtime.store, vector: vec.store, storeKind: `${runtime.kind}/${vec.kind}`, vectorAnn: vec.kind === "ann", close };
  }
  if (wantsAnn) {
    console.error(
      "[eval-retrieval] VECTOR_ANN=true but DATABASE_URL is unset — falling back to an in-memory store for " +
        "this run. Set DATABASE_URL to the real §5-run Cloud SQL instance to actually exercise pgvector.",
    );
  }
  return {
    store: new InMemoryRuntimeStore(),
    vector: createInMemoryVectorStore(),
    storeKind: "memory",
    vectorAnn: false,
    close: async () => {},
  };
}

/**
 * The CLI's actual work, extracted so it can be exercised against a pgvector testcontainer with a fake
 * embed model (proving the VECTOR_ANN wiring + evidence emission) without requiring real Vertex creds —
 * `main()` below is the only place `isVertexConfigured()` gates on.
 */
export async function runRetrievalEval(model: ModelPort, opts: RunRetrievalEvalOptions = {}): Promise<RunRetrievalEvalResult> {
  // `main()` already gates on `canEmbed` before calling this, but that narrowing does not survive across
  // the function boundary — re-check here (canEmbed is static/free, #188) so a direct caller of this
  // exported function gets the same fail-closed guard, matching indexOneTenant's own `canEmbed` check.
  if (!canEmbed(model)) throw new Error("runRetrievalEval: this model does not implement embed() — retrieval cannot be evaluated");

  const env = opts.env ?? process.env;
  const tenantId = opts.tenantId ?? env.RETRIEVAL_TENANT ?? "eval-retrieval";
  const { products, cases, _meta } = resolveCorpus(env, opts.corpus);
  const defaultK = _meta?.k ?? 3;

  const { store, vector, storeKind, vectorAnn, close } = await resolveEvalStores(env);

  // One extra embed call to capture the model id + dimension this run actually used for the evidence
  // artifact — the index/retrieve calls below don't surface that metadata to this caller.
  const probe = await model.embed({ texts: ["retrieval-promotion evidence probe"], purpose: "document" });

  const { retriever, tenantId: t } = await buildIndexedRetriever(products, model, tenantId, store, vector);
  const rows: { id: string; pass: boolean; fails: string[] }[] = [];
  for (const c of cases) {
    try {
      const { hits } = await retriever.retrieve({ tenantId: t, query: c.query, k: c.k ?? defaultK });
      rows.push({ id: c.id, ...gradeRetrieval(c, hits) });
    } catch (e) {
      rows.push({ id: c.id, pass: false, fails: [`error: ${(e as Error).message}`] });
    }
  }

  const recallAtK = cases.length ? rows.filter((r) => r.pass).length / cases.length : 1;
  // no-wrong-product is narrower than "pass": only count a case against it when a clearly-irrelevant
  // product actually appeared in its top-k (gradeRetrieval's own wording for that failure mode).
  const noWrongProduct = cases.length
    ? rows.filter((r) => !r.fails.some((f) => f.includes("clearly-irrelevant"))).length / cases.length
    : 1;

  let evidencePath: string | undefined;
  if (opts.writeEvidence !== false) {
    evidencePath = writeRetrievalEvidence(
      {
        tenantId: t,
        model: probe.model,
        dimension: probe.dimension,
        corpusSize: products.length,
        recallAtK,
        noWrongProduct,
        // This CLI does not run the shadow harness — see shadow-retrieval.ts's own evidence write for this
        // tenant's shadow counts.
        shadow: null,
        vectorAnn,
        at: new Date().toISOString(),
      },
      opts.evidenceDir,
    );
  }

  return { rows, defaultK, corpusSize: products.length, storeKind, vectorAnn, evidencePath, close };
}

async function main() {
  if (!isVertexConfigured()) {
    console.error("Set GOOGLE_CLOUD_PROJECT + ADC — retrieval runs the real embedder + retriever.");
    process.exit(2);
  }
  const model = createVertexAdapter();
  if (!canEmbed(model)) {
    console.error("This deployment's Vertex adapter cannot embed — retrieval cannot be evaluated.");
    process.exit(2);
  }
  const result = await runRetrievalEval(model);
  for (const r of result.rows) process.stdout.write(`${r.pass ? "✅" : "❌"} ${r.id} `);
  const fails = result.rows.filter((r) => !r.pass);
  console.log(
    `\n\nRETRIEVAL: ${result.rows.length - fails.length}/${result.rows.length} passed ` +
      `(k=${result.defaultK} over ${result.corpusSize} products, store=${result.storeKind})`,
  );
  for (const r of fails) console.log(`  ❌ ${r.id}: ${r.fails.join("; ")}`);
  if (result.evidencePath) console.log(`[eval-retrieval] evidence written: ${result.evidencePath}`);
  if (fails.length > 0) {
    console.error(`\nRETRIEVAL GATE FAIL — ${fails.length} case(s). A wrong/absent top-k degrades what the agent is grounded on.`);
    process.exit(1);
  }
  console.log("RETRIEVAL GATE OK.");
}

// Run only as a script (`pnpm eval:retrieval` / `tsx .../eval-retrieval.ts`), never on import — a test
// imports `runRetrievalEval` directly to exercise the VECTOR_ANN + evidence wiring without real Vertex
// creds, and must not also trigger this file's own `isVertexConfigured()` gate as a side effect of the
// import. Same guard as jobs/catalog-enable.ts, jobs/kill-switch.ts, jobs/catalog-index.ts, etc.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
