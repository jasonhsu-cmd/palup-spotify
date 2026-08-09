// SHADOW-REPLAY runner for PRODUCT_FACTS_HYDRATION (A1b) — ADR-0020 promotion plan, Track B, stage 2.
// Hydration only fires on the RETRIEVED subset, so this isolates it: BOTH variants run with CATALOG_RETRIEVAL
// ON; the champion has hydration OFF, the candidate has it ON over a seeded Tier-2 fact store. The shadow
// question is "does overlaying fresh facts ever make a turn LESS safe / add an offer?" — safetyRegression
// enforces that. Price FIDELITY (fresh vs stale vs base) is the money-facts eval gate's job (pnpm
// eval:money-facts, 7/7), not this. Facts are seeded FRESH at the catalog price, so the overlay is truthful.
//   pnpm shadow:hydration
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createBrain, DEFAULT_POLICY, StaticGroundingAdapter, MockCommerceAdapter } from "@palup/widget-brain";
import { createVertexAdapter, isVertexConfigured } from "@palup/model-vertex";
import { canEmbed, createInMemoryProductFactsStore } from "@palup/platform-ports";
import { buildIndexedRetriever } from "@palup/widget-backend/src/retrieval-eval.js";
import { runShadow, type BrainFactory, type ShadowCase } from "./shadow-harness.js";

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_LAYERS = new Set(["grounding", "pitch", "pairwise"]);
const RETRIEVAL_K = 5;
const MAX_AGE_MS = 3_600_000;

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
    console.error("This deployment's Vertex adapter cannot embed — hydration (which needs retrieval) cannot be shadowed.");
    process.exit(2);
  }
  const demo = await grounding.getContext("demo");
  const { retriever } = await buildIndexedRetriever(demo.products, model, "demo");

  // Seed FRESH Tier-2 facts at the current catalog price + availability (a truthful overlay). `updatedAt`
  // is the real clock so the facts are inside the staleness ceiling — the brain measures age against its own
  // new Date() (not injectable), so seeding from Date.now() is correct (same reason as the money-facts harness).
  const facts = createInMemoryProductFactsStore();
  await facts.upsertMany(
    "demo",
    demo.products.map((p) => ({
      productId: p.id,
      price: p.price,
      ...(p.availableForSale !== undefined ? { availableForSale: p.availableForSale } : {}),
      updatedAt: new Date().toISOString(),
    })),
  );

  // Champion: retrieval ON, hydration OFF (positions 11/12/13). Candidate: + facts (18) + hydration (19) +
  // the staleness ceiling (22). Isolating hydration means the champion already narrows identically.
  const champion: BrainFactory = (m) =>
    createBrain(m, grounding, DEFAULT_POLICY, commerce, "shopper-demo", undefined, false, false, false, false, retriever, true, RETRIEVAL_K);
  const candidate: BrainFactory = (m) =>
    createBrain(
      m, grounding, DEFAULT_POLICY, commerce, "shopper-demo", undefined,
      false, false, false, false,
      retriever, true, RETRIEVAL_K,
      false, false, false, false,
      facts, true,
      undefined, false,
      MAX_AGE_MS,
    );

  console.log(`SHADOW PRODUCT_FACTS_HYDRATION: ${cases.length} cases (both retrieval=on; champion hydration=off vs candidate=on)\n`);
  const summary = await runShadow(cases, champion, candidate, model, { concurrency: Number(process.env.SHADOW_CONCURRENCY ?? 6) });

  for (const r of summary.rows) process.stdout.write(`${r.violations.length ? "❌" : r.changed ? "✳️" : "·"} ${r.id} `);
  console.log(`\n\nSHADOW: ${summary.total} cases | ${summary.changed} reply changed | ${summary.violations} VIOLATION(s)`);
  const violated = summary.rows.filter((r) => r.violations.length);
  for (const r of violated) {
    console.log(`\n  ❌ ${r.id} (${r.layer}): ${r.violations.join("; ")}`);
    console.log(`     champion : ${r.championReply.slice(0, 150)}`);
    console.log(`     candidate: ${r.candidateReply.slice(0, 150)}`);
  }
  if (violated.length) {
    console.error(`\nSHADOW FAIL — ${violated.length} case(s) regressed safety/money when facts were overlaid.`);
    process.exit(1);
  }
  console.log("SHADOW OK — overlaying fresh facts never lowered safety, dropped an escalation, or added an offer.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
