// SHADOW-REPLAY runner for SERVER_GUARD_SIGNALS (broaden) — ADR-0020 promotion plan, Track A, stage 2.
// Champion = flag OFF (the brain uses only its English keyword guardrail floor). Candidate = flag ON: for
// each turn the SERVER guard classifier (classifyGuardSignals — the same producer the server runs) is run
// on the message, and its serverSafetyClass / serverInjection / serverSupportIntent are injected into the
// candidate's signals (as the unspoofable server-authored inputs deriveServingSignals would supply live).
//
// The invariant that gates: SERVER_GUARD_SIGNALS can only RAISE safety / ROUTE (worstSafety / boolean-OR),
// never lower a class or authorize an action — so the candidate must NEVER be less safe than the champion.
// safetyRegression enforces exactly that (no lowered safetyClass, no dropped escalation). Turns where the
// server classifier RAISES safety show up as `changed` (the feature working), not as violations.
//   pnpm shadow:guard-signals
//   SHADOW_LAYER=safety,injection pnpm shadow:guard-signals   SHADOW_LIMIT=20 pnpm shadow:guard-signals
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createBrain, DEFAULT_POLICY, DEFAULT_CATALOG_RETRIEVAL_K, StaticGroundingAdapter, MockCommerceAdapter } from "@palup/widget-brain";
import { createVertexAdapter, isVertexConfigured } from "@palup/model-vertex";
import type { ModelPort } from "@palup/platform-ports";
import { classifyGuardSignals } from "@palup/widget-backend/src/guard-classifier.js";
import { runShadow, type BrainFactory, type ShadowCase } from "./shadow-harness.js";

const here = dirname(fileURLToPath(import.meta.url));
// The layers where server guard classification is meant to change anything: safety detection, injection,
// and support-intent routing. (Sales/pitch turns route to "general" ⇒ no server intent ⇒ inert.)
const DEFAULT_LAYERS = new Set(["safety", "injection", "support"]);

async function main() {
  if (!isVertexConfigured()) {
    console.error("Set GOOGLE_CLOUD_PROJECT + ADC — shadow replay runs the agent + the guard classifier on the real model.");
    process.exit(2);
  }
  let cases = JSON.parse(readFileSync(join(here, "..", "cases", "full-corpus.json"), "utf8")) as ShadowCase[];
  const layerFilter = process.env.SHADOW_LAYER?.split(",").map((s) => s.trim());
  cases = cases.filter((c) => (layerFilter ? layerFilter.includes(c.layer ?? "") : DEFAULT_LAYERS.has(c.layer ?? "")));
  if (process.env.SHADOW_LIMIT) cases = cases.slice(0, Number(process.env.SHADOW_LIMIT));

  const grounding = new StaticGroundingAdapter();
  const commerce = new MockCommerceAdapter();
  const model = createVertexAdapter();

  const champion: BrainFactory = (m) => createBrain(m, grounding, DEFAULT_POLICY, commerce, "shopper-demo");
  // Candidate: position 17 (serverGuardSignalsEnabled) = true; every other flag stays default OFF.
  const candidate: BrainFactory = (m) =>
    createBrain(
      m, grounding, DEFAULT_POLICY, commerce, "shopper-demo", undefined,
      false, false, false, false,
      undefined, false, DEFAULT_CATALOG_RETRIEVAL_K,
      false, false, false, true,
    );

  // The producer: run the server guard classifier for THIS turn and hand the brain its server-authored
  // signals (undefined class/intent are OMITTED, exactly as deriveServingSignals does live).
  const augmentCandidateSignals = async (c: ShadowCase, m: ModelPort) => {
    const msg = c.message ?? c.turns?.[c.turns.length - 1] ?? "";
    if (!msg.trim()) return undefined;
    const gs = await classifyGuardSignals(m, msg, "eval");
    return {
      ...(gs.safetyClass ? { serverSafetyClass: gs.safetyClass } : {}),
      serverInjection: gs.injection,
      ...(gs.supportIntent ? { serverSupportIntent: gs.supportIntent } : {}),
    };
  };

  console.log(`SHADOW SERVER_GUARD_SIGNALS: ${cases.length} cases (champion=off vs candidate=on + server classifier)\n`);
  const summary = await runShadow(cases, champion, candidate, model, {
    concurrency: Number(process.env.SHADOW_CONCURRENCY ?? 6),
    augmentCandidateSignals,
  });

  for (const r of summary.rows) process.stdout.write(`${r.violations.length ? "❌" : r.changed ? "✳️" : "·"} ${r.id} `);
  console.log(`\n\nSHADOW: ${summary.total} cases | ${summary.changed} reply changed | ${summary.violations} VIOLATION(s)`);
  const violated = summary.rows.filter((r) => r.violations.length);
  for (const r of violated) {
    console.log(`\n  ❌ ${r.id} (${r.layer}): ${r.violations.join("; ")}`);
    console.log(`     champion  safety=${r.championSafety}: ${r.championReply.slice(0, 140)}`);
    console.log(`     candidate safety=${r.candidateSafety}: ${r.candidateReply.slice(0, 140)}`);
  }
  if (violated.length) {
    console.error(`\nSHADOW FAIL — ${violated.length} case(s) regressed safety. SERVER_GUARD_SIGNALS must only RAISE safety, never lower it.`);
    process.exit(1);
  }
  console.log("SHADOW OK — the candidate never lowered safety or dropped an escalation (server signals only raised).");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
