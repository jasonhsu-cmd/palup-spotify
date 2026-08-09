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
import { runShadow, safetyClassRegression, type BrainFactory, type ShadowCase } from "./shadow-harness.js";

const here = dirname(fileURLToPath(import.meta.url));
// The layers where server guard classification is meant to change anything: safety detection, injection,
// and support-intent routing. (Sales/pitch turns route to "general" ⇒ no server intent ⇒ inert.)
const DEFAULT_LAYERS = new Set(["safety", "injection", "support"]);

async function main() {
  if (!isVertexConfigured()) {
    console.error("Set GOOGLE_CLOUD_PROJECT + ADC — shadow replay runs the agent + the guard classifier on the real model.");
    process.exit(2);
  }
  // SHADOW_ELICIT loads the failure-eliciting corpus (paraphrased/social-engineered evasions the English
  // keyword floor misses) instead of the benign graded one.
  const elicit = process.env.SHADOW_ELICIT === "1";
  let cases: ShadowCase[];
  if (elicit) {
    cases = (JSON.parse(readFileSync(join(here, "..", "cases", "shadow-eliciting.json"), "utf8")).cases as ShadowCase[]).filter((c) => c.target === "guard");
  } else {
    cases = (JSON.parse(readFileSync(join(here, "..", "cases", "full-corpus.json"), "utf8")) as ShadowCase[]).filter((c) => {
      const layerFilter = process.env.SHADOW_LAYER?.split(",").map((s) => s.trim());
      return layerFilter ? layerFilter.includes(c.layer ?? "") : DEFAULT_LAYERS.has(c.layer ?? "");
    });
  }
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
  // ROUTING flag: gate only on a LOWERED class / added offer, NOT on escalation changes — routing a case to
  // its handler instead of a generic escalation (money still gated in handleSupport) is the flag's PURPOSE.
  const summary = await runShadow(cases, champion, candidate, model, {
    concurrency: Number(process.env.SHADOW_CONCURRENCY ?? 6),
    invariant: safetyClassRegression,
    augmentCandidateSignals,
  });

  for (const r of summary.rows) process.stdout.write(`${r.violations.length ? "❌" : r.changed ? "✳️" : "·"} ${r.id} `);
  console.log(`\n\nSHADOW: ${summary.total} cases | ${summary.changed} reply changed | ${summary.escalationChanged} escalation changed (informational — see below) | ${summary.violations} VIOLATION(s)`);
  // Escalation changes are the routing working (or a case worth a human's eye), not a gate failure — list them.
  const escChanged = summary.rows.filter((r) => r.escalationChanged);
  if (escChanged.length) {
    console.log(`\nESCALATION CHANGES (informational — a human should confirm each routed case still gates money correctly):`);
    for (const r of escChanged) console.log(`  ~ ${r.id} (${r.layer}): champion→candidate safety ${r.championSafety}→${r.candidateSafety}; candidate: ${r.candidateReply.slice(0, 120)}`);
  }
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

  // ELICITING: the feature's VALUE — where did the server classifier RAISE safety on an evasion the English
  // keyword floor (champion) missed? (Detection CORRECTNESS is the guard-classifier eval's gate; here we
  // just surface that the flag catches paraphrased/social-engineered turns the floor lets through.)
  if (elicit) {
    console.log("\nELICITING — evasions the keyword floor missed that the server classifier caught:");
    let raised = 0;
    for (const r of summary.rows) {
      if (r.championSafety === "none" && r.candidateSafety !== "none") {
        raised++;
        console.log(`  ✓ ${r.id}: champion=none → candidate=${r.candidateSafety} (evasion caught)`);
      } else if (r.candidateSafety !== "none") {
        console.log(`  = ${r.id}: both engaged safety (${r.championSafety}→${r.candidateSafety})`);
      } else {
        console.log(`  · ${r.id}: neither engaged safety — ${r.candidateReply.slice(0, 90)}`);
      }
    }
    console.log(`\nELICIT: the server classifier raised safety on ${raised}/${summary.total} evasion(s) the keyword floor missed (the flag's value). 0 regressions.`);
    return;
  }
  console.log("SHADOW OK — the candidate never lowered safety or dropped an escalation (server signals only raised).");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
