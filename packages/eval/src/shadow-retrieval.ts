// SHADOW-REPLAY runner for CATALOG_RETRIEVAL (E1) — ADR-0020 promotion plan, Track B, stage 2.
// Champion = flag OFF (the full catalog is rendered into every prompt). Candidate = flag ON: the demo
// catalog is indexed through the REAL path and the brain narrows each turn's CATALOG block to the
// retriever's top-k. The shadow question here is NOT retrieval quality (the eval gate — pnpm eval:retrieval,
// recall@k — answers that); it is "does narrowing the prompt ever make a turn LESS safe / add an offer?"
// safetyRegression enforces that zero-tolerance bar. Reply CHANGES are expected (a smaller catalog is a
// different prompt) and reported, not failed.
//   pnpm shadow:retrieval
//
// S4 §5 fix-round — VECTOR_ANN=true (+ DATABASE_URL) now routes the retriever this shadow run indexes
// through the SAME real pgvector composition root (`createVectorStore`, @palup/state-postgres) the serving
// path and eval-retrieval.ts's CLI use, instead of always indexing into an in-memory store. On a clean
// (zero-violation) pass this also writes `reports/retrieval-promotion-evidence-<tenant>-<stamp>.json`
// (`writeRetrievalEvidence`) recording the shadow violation counts — companion to eval-retrieval.ts's own
// artifact, which carries this tenant's recall@k / no-wrong-product instead (see that file's header for
// why the two are separate artifacts, not one merged write).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createBrain, DEFAULT_POLICY, StaticGroundingAdapter, MockCommerceAdapter } from "@palup/widget-brain";
import { createVertexAdapter, isVertexConfigured } from "@palup/model-vertex";
import { canEmbed, InMemoryRuntimeStore, createInMemoryVectorStore } from "@palup/platform-ports";
import type { RuntimeStatePort, VectorPort } from "@palup/platform-ports";
import { createRuntimeStore, createVectorStore } from "@palup/state-postgres";
import { buildIndexedRetriever } from "@palup/widget-backend/src/retrieval-eval.js";
import { writeRetrievalEvidence } from "@palup/widget-backend/src/retrieval-promotion-evidence.js";
import { runShadow, type BrainFactory, type ShadowCase } from "./shadow-harness.js";

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_LAYERS = new Set(["grounding", "pitch", "pairwise", "golden"]);
const RETRIEVAL_K = 5; // narrow the 13-product demo catalog to 5 so the flag's effect is real, not a no-op.

async function main() {
  if (!isVertexConfigured()) {
    console.error("Set GOOGLE_CLOUD_PROJECT + ADC — shadow replay runs the agent + the embedder on the real model.");
    process.exit(2);
  }
  let cases = JSON.parse(readFileSync(join(here, "..", "cases", "full-corpus.json"), "utf8")) as ShadowCase[];
  const layerFilter = process.env.SHADOW_LAYER?.split(",").map((s) => s.trim());
  cases = cases.filter((c) => (layerFilter ? layerFilter.includes(c.layer ?? "") : DEFAULT_LAYERS.has(c.layer ?? "")));
  if (process.env.SHADOW_LIMIT) cases = cases.slice(0, Number(process.env.SHADOW_LIMIT));

  const grounding = new StaticGroundingAdapter();
  const commerce = new MockCommerceAdapter();
  const model = createVertexAdapter();
  if (!canEmbed(model)) {
    console.error("This deployment's Vertex adapter cannot embed — CATALOG_RETRIEVAL cannot be shadowed.");
    process.exit(2);
  }

  // VECTOR_ANN=true (+ DATABASE_URL) routes through the same real pgvector composition root the serving
  // path uses; unset (or VECTOR_ANN=true with no DATABASE_URL — logged, not silently ignored) keeps the
  // prior in-memory demo behavior.
  const wantsAnn = process.env.VECTOR_ANN === "true";
  let store: RuntimeStatePort = new InMemoryRuntimeStore();
  let vector: VectorPort = createInMemoryVectorStore();
  let vectorAnn = false;
  if (wantsAnn && process.env.DATABASE_URL) {
    const runtime = await createRuntimeStore();
    const vec = await createVectorStore(runtime.sql);
    store = runtime.store;
    vector = vec.store;
    vectorAnn = vec.kind === "ann";
  } else if (wantsAnn) {
    console.error(
      "[shadow-retrieval] VECTOR_ANN=true but DATABASE_URL is unset — falling back to an in-memory store " +
        "for this run. Set DATABASE_URL to actually exercise pgvector.",
    );
  }

  // Index the SAME demo catalog the brain grounds on, under the "demo" tenant the eval cases resolve to.
  const demo = await grounding.getContext("demo");
  const { retriever } = await buildIndexedRetriever(demo.products, model, "demo", store, vector);

  const champion: BrainFactory = (m) => createBrain(m, grounding, DEFAULT_POLICY, commerce, "shopper-demo");
  // Candidate: positions 11 (retriever) + 12 (catalogRetrievalEnabled) + 13 (k) on; everything else default.
  const candidate: BrainFactory = (m) =>
    createBrain(m, grounding, DEFAULT_POLICY, commerce, "shopper-demo", undefined, false, false, false, false, retriever, true, RETRIEVAL_K);

  console.log(`SHADOW CATALOG_RETRIEVAL: ${cases.length} cases (champion=full catalog vs candidate=top-${RETRIEVAL_K})\n`);
  const summary = await runShadow(cases, champion, candidate, model, { concurrency: Number(process.env.SHADOW_CONCURRENCY ?? 6) });

  for (const r of summary.rows) process.stdout.write(`${r.violations.length ? "❌" : r.changed ? "✳️" : "·"} ${r.id} `);
  console.log(`\n\nSHADOW: ${summary.total} cases | ${summary.changed} reply changed (expected) | ${summary.violations} VIOLATION(s)`);
  const violated = summary.rows.filter((r) => r.violations.length);
  for (const r of violated) {
    console.log(`\n  ❌ ${r.id} (${r.layer}): ${r.violations.join("; ")}`);
    console.log(`     champion : ${r.championReply.slice(0, 150)}`);
    console.log(`     candidate: ${r.candidateReply.slice(0, 150)}`);
  }
  if (violated.length) {
    console.error(`\nSHADOW FAIL — ${violated.length} case(s) regressed safety/money when the catalog was narrowed.`);
    process.exit(1);
  }
  // Evidence is written ONLY on this zero-violation path: `runShadow`'s `violations` are free-text
  // per-case messages (safety-lowered / offer-added / escalation-dropped), not categorized into
  // fabricated/stale/missing-product — so the only split this run can HONESTLY report is the trivial
  // all-zero one a clean pass guarantees. See retrieval-promotion-evidence.ts's `shadow` field doc.
  const probe = await model.embed({ texts: ["shadow-retrieval evidence probe"], purpose: "document" });
  const evidencePath = writeRetrievalEvidence({
    tenantId: process.env.RETRIEVAL_TENANT ?? "demo",
    model: probe.model,
    dimension: probe.dimension,
    corpusSize: demo.products.length,
    recallAtK: null,
    noWrongProduct: null,
    shadow: { fabricated: 0, stale: 0, missingProduct: 0 },
    vectorAnn,
    at: new Date().toISOString(),
  });
  console.log(`[shadow-retrieval] evidence written: ${evidencePath}`);
  console.log("SHADOW OK — narrowing the catalog never lowered safety, dropped an escalation, or added an offer.");
}

// Run only as a script, never on import — same guard as widget-backend/src/eval-retrieval.ts and the
// jobs/*.ts CLIs.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
