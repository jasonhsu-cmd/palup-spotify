// SHADOW-REPLAY runner for CATALOG_RETRIEVAL (E1) — ADR-0020 promotion plan, Track B, stage 2.
// Champion = flag OFF (the full catalog is rendered into every prompt). Candidate = flag ON: the demo
// catalog is indexed through the REAL path and the brain narrows each turn's CATALOG block to the
// retriever's top-k. The shadow question here is NOT retrieval quality (the eval gate — pnpm eval:retrieval,
// recall@k — answers that); it is "does narrowing the prompt ever make a turn LESS safe / add an offer?"
// safetyRegression enforces that zero-tolerance bar. Reply CHANGES are expected (a smaller catalog is a
// different prompt) and reported, not failed.
//   pnpm shadow:retrieval
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createBrain, DEFAULT_POLICY, StaticGroundingAdapter, MockCommerceAdapter } from "@palup/widget-brain";
import { createVertexAdapter, isVertexConfigured } from "@palup/model-vertex";
import { canEmbed } from "@palup/platform-ports";
import { buildIndexedRetriever } from "@palup/widget-backend/src/retrieval-eval.js";
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
  // Index the SAME demo catalog the brain grounds on, under the "demo" tenant the eval cases resolve to.
  const demo = await grounding.getContext("demo");
  const { retriever } = await buildIndexedRetriever(demo.products, model, "demo");

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
  console.log("SHADOW OK — narrowing the catalog never lowered safety, dropped an escalation, or added an offer.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
