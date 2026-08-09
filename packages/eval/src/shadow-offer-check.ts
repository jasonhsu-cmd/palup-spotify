// SHADOW-REPLAY runner for OUTGOING_OFFER_CHECK (3b) — ADR-0020 promotion plan, Track A, stage 2.
// Champion = the flag OFF (reply integrity is the deterministic keyword floor only). Candidate = the flag
// ON (the semantic offer check runs on every sales reply, as a backstop to the floor). Runs the graded
// corpus through both on the real model and asserts the candidate NEVER regresses safety or money vs the
// champion (the shadow exit bar). Reply changes are reported (expected — the check firing); a change that
// lowers safety, drops an escalation, or adds an ungrounded offer FAILS.
//   pnpm shadow:offer-check                 # a default sales-relevant subset
//   SHADOW_LAYER=pitch,grounding pnpm shadow:offer-check
//   SHADOW_LIMIT=40 pnpm shadow:offer-check
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  createBrain,
  DEFAULT_POLICY,
  DEFAULT_CATALOG_RETRIEVAL_K,
  StaticGroundingAdapter,
  MockCommerceAdapter,
} from "@palup/widget-brain";
import { createVertexAdapter, isVertexConfigured } from "@palup/model-vertex";
import { runShadow, type BrainFactory, type ShadowCase } from "./shadow-harness.js";

const here = dirname(fileURLToPath(import.meta.url));
// Layers where a sales reply (and therefore an offer) can plausibly arise — the offer check only runs on
// the clean sales path, so the safety/injection/support layers are not where it changes anything.
const DEFAULT_LAYERS = new Set(["pitch", "pairwise", "grounding", "golden", "relationship", "persona"]);

async function main() {
  if (!isVertexConfigured()) {
    console.error("Set GOOGLE_CLOUD_PROJECT + ADC — shadow replay runs the agent on the real model.");
    process.exit(2);
  }
  let cases = JSON.parse(readFileSync(join(here, "..", "cases", "full-corpus.json"), "utf8")) as ShadowCase[];
  const layerFilter = process.env.SHADOW_LAYER?.split(",").map((s) => s.trim());
  cases = cases.filter((c) => (layerFilter ? layerFilter.includes(c.layer ?? "") : DEFAULT_LAYERS.has(c.layer ?? "")));
  if (process.env.SHADOW_LIMIT) cases = cases.slice(0, Number(process.env.SHADOW_LIMIT));

  // Grounding + commerce are shared by both variants — the SAME source of truth, so the only difference
  // between champion and candidate is the flag under test.
  const grounding = new StaticGroundingAdapter();
  const commerce = new MockCommerceAdapter();
  const model = createVertexAdapter();

  const champion: BrainFactory = (m) => createBrain(m, grounding, DEFAULT_POLICY, commerce, "shopper-demo");
  // Candidate: identical, but positions 20/21 turn the semantic offer check on (offerCheckModel + enabled).
  const candidate: BrainFactory = (m) =>
    createBrain(
      m, grounding, DEFAULT_POLICY, commerce, "shopper-demo", undefined,
      false, false, false, false,
      undefined, false, DEFAULT_CATALOG_RETRIEVAL_K,
      false, false, false, false,
      undefined, false,
      m, true, // offerCheckModel = the same model, outgoingOfferCheckEnabled = true
    );

  console.log(`SHADOW OUTGOING_OFFER_CHECK: ${cases.length} cases (champion=off vs candidate=on)\n`);
  const summary = await runShadow(cases, champion, candidate, model, { concurrency: Number(process.env.SHADOW_CONCURRENCY ?? 6) });

  for (const r of summary.rows) {
    if (r.violations.length) process.stdout.write(`❌ ${r.id} `);
    else process.stdout.write(`${r.changed ? "✳️" : "·"} ${r.id} `);
  }
  console.log(`\n\nSHADOW: ${summary.total} cases | ${summary.changed} reply changed (expected) | ${summary.violations} VIOLATION(s)`);
  const violated = summary.rows.filter((r) => r.violations.length);
  for (const r of violated) {
    console.log(`\n  ❌ ${r.id} (${r.layer}): ${r.violations.join("; ")}`);
    console.log(`     champion : ${r.championReply.slice(0, 160)}`);
    console.log(`     candidate: ${r.candidateReply.slice(0, 160)}`);
  }
  if (violated.length) {
    console.error(`\nSHADOW FAIL — ${violated.length} case(s) regressed safety/money. OUTGOING_OFFER_CHECK must not exit shadow.`);
    process.exit(1);
  }
  console.log("SHADOW OK — the candidate never lowered safety, dropped an escalation, or added an ungrounded offer.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
