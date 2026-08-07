// Full corpus runner: grades the ENTIRE authored corpus (~190 cases, all design-doc layers) by
// running the agent on the live Gemini model and grading each case's criteria with the cross-family
// judge (Claude/Opus 4.8). Requires GCP creds + ANTHROPIC_API_KEY.
//   pnpm eval:full                    # all cases
//   EVAL_LIMIT=8 pnpm eval:full       # first 8 (quick harness check)
//   EVAL_LAYER=safety,injection pnpm eval:full   # only some layers
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createBrain, createSession, DEFAULT_POLICY, StaticGroundingAdapter, MockCommerceAdapter, demoCommerceGroundTruth } from "@palup/widget-brain";
import type { HistoryTurn } from "@palup/widget-brain";
import { createVertexAdapter, isVertexConfigured } from "@palup/model-vertex";
import {
  createGeminiJudge,
  createAnthropicApiJudge,
  createAnthropicJudge,
  isAnthropicApiConfigured,
  crossFamilyGuard,
} from "@palup/judge";
import { createCaseMeter, caseReportFields, aggregate, formatRunMetrics } from "./metrics.js";
import { scoreSuites, formatSuiteReport, liveSuiteCases, liveMeasurements } from "./suites.js";

interface FullCase {
  id: string;
  layer: string;
  signals?: Record<string, unknown>;
  message?: string;
  turns?: string[];
  rubric: string;
  criteria: { id: string; description: string }[];
}

const FLOOR_LAYERS = new Set(["safety", "injection"]);
const here = dirname(fileURLToPath(import.meta.url));
let cases = JSON.parse(readFileSync(join(here, "..", "cases", "full-corpus.json"), "utf8")) as FullCase[];

async function main() {
  if (!isVertexConfigured()) {
    console.error("Set GOOGLE_CLOUD_PROJECT + ADC — the corpus runs the agent on the real model.");
    process.exit(2);
  }
  const layerFilter = process.env.EVAL_LAYER?.split(",").map((s) => s.trim());
  if (layerFilter) cases = cases.filter((c) => layerFilter.includes(c.layer));
  const limit = process.env.EVAL_LIMIT ? Number(process.env.EVAL_LIMIT) : cases.length;
  cases = cases.slice(0, limit);

  const agentFamily = "gemini";
  const grounding = new StaticGroundingAdapter();
  const commerce = new MockCommerceAdapter();
  // §8 `cost`/`latency` suites — MEASUREMENT ONLY (no threshold here; see metrics.ts). The adapter is
  // built once; each case then gets its OWN metering decorator around it (createCaseMeter) and its own
  // brain over that port, so the concurrency pool below cannot cross-attribute one case's tokens or
  // latency to another. createBrain is a pure factory (brain.ts — it allocates closures, does no I/O),
  // so one brain per case is free, and NOTHING in the brain or in any port changed to make this work.
  // Deliberately NOT metered: the judge's own calls. These figures are the AGENT's serving cost/latency,
  // which is what the production suites are about — folding the grader in would inflate both.
  const model = createVertexAdapter();
  const ctx = await grounding.getContext("demo");
  // The judge must be given the SAME first-party facts the agent grounds on — otherwise it cannot
  // verify a grounded claim and reads it as a guess (SX-01: an ingredient-grounded allergy answer was
  // failing `ground-ingredients` AND `forbid-guess` purely because ingredients were absent here). This
  // is the agent's source of truth, so richer ground truth makes the judge stricter on fabricated
  // ingredient/allergen claims, never more lenient — it does NOT change any criterion or threshold.
  const groundTruth =
    "AUTHORITATIVE CATALOG (ground truth — these products, prices, descriptions, and ingredient lists are REAL and correct; anything not listed here is not grounded):\n" +
    // Include the product DESCRIPTION: it is first-party catalog data the AGENT grounds on (brain.ts
    // systemPrompt catalog line: `${title} (${price}): ${sanitizeGroundingText(p.description)} [tags]`),
    // so without it here the judge false-flags a description-grounded claim ("smoother texture" from the
    // retinol's "Encapsulated 0.3% retinol for smoother texture") as an invented benefit. Same faithfulness
    // fix as ingredients/orders above — stricter on fabrication, never more lenient; no criterion changes.
    ctx.products
      .map((p) => `- ${p.title} (${p.price})${p.description ? ` — ${p.description}` : ""}${p.ingredients?.length ? ` — ingredients: ${p.ingredients.join(", ")}` : ""}`)
      .join("\n") +
    (ctx.policy.allergens ? `\nALLERGEN POLICY: ${ctx.policy.allergens}` : "") +
    // Order/policy/subscription ground truth — the support layer grounds on the shopper's real order
    // records; without them the judge reads a correct grounded status/return/refund reply as fabricated
    // (the order analogue of the SX-01 catalog-ground-truth fix). Faithful, never more lenient.
    (await demoCommerceGroundTruth(commerce, "shopper-demo"));

  const wantAnthropic = process.env.JUDGE_FAMILY !== "gemini" && isAnthropicApiConfigured();
  const judge = wantAnthropic
    ? createAnthropicApiJudge()
    : process.env.JUDGE_FAMILY === "anthropic"
      ? createAnthropicJudge()
      : createGeminiJudge();
  const judgeFamily = process.env.JUDGE_FAMILY === "gemini" || (!wantAnthropic && process.env.JUDGE_FAMILY !== "anthropic") ? "gemini" : "anthropic";
  const guard = crossFamilyGuard(agentFamily, judgeFamily);
  console.log(`\nFULL CORPUS: ${cases.length} cases | agent=${agentFamily} judge=${judgeFamily} crossFamily=${guard.crossFamily}${guard.crossFamily ? " (GATING)" : " (ADVISORY)"}\n`);

  // Grade one case (per-case isolation: an agent/judge error counts as a fail, never aborts the run).
  const gradeCase = async (c: any) => {
    // Per-case meter + brain over the metered port (see the comment at `model` above).
    const meter = createCaseMeter(model);
    const brain = createBrain(meter.port, grounding, DEFAULT_POLICY, commerce, "shopper-demo");
    const turns = c.turns?.length ?? 1; // shopper turns — the denominator for tokens/turn
    const measured = () => caseReportFields(meter, turns);
    try {
      let transcript: string;
      if (c.turns?.length) {
        const s = await createSession(brain); // createSession is async (durable store adapters)
        const lines: string[] = [];
        // Replay the accumulated transcript as `history` each turn, exactly like the production server
        // (server.ts: session.send(msg, signals, normalizeHistory(history))). Without this the brain saw
        // every turn cold, so cross-turn coherence/resume criteria (switching, multi-turn golden) were
        // untestable — the harness, not the agent, was failing them.
        const history: HistoryTurn[] = [];
        for (const t of c.turns) {
          const d = await s.send(t, (c.signals ?? {}) as never, history);
          lines.push(`Shopper: ${t}\nAssistant: ${d.reply}`);
          history.push({ role: "user", content: t }, { role: "agent", content: d.reply });
        }
        transcript = lines.join("\n\n");
      } else {
        const d = await brain.decide((c.signals ?? {}) as never, c.message ?? "");
        transcript = `Shopper: ${c.message}\nAssistant: ${d.reply}`;
      }
      const v = await judge.grade({ rubric: `${c.rubric}\n\n${groundTruth}`, transcript, criteria: c.criteria });
      process.stdout.write(`${v.pass ? "✅" : "❌"} ${c.id} `);
      return { id: c.id, layer: c.layer, pass: v.pass, score: v.score, fails: v.results.filter((r) => !r.pass).map((r) => r.id), message: c.message ?? c.turns?.join(" | "), signals: c.signals ?? {}, transcript, criteria: v.results, ...measured() };
    } catch (e) {
      process.stdout.write(`⚠️ ${c.id} `);
      // An errored case still reports whatever WAS measured before it failed (partial, honest — not zero).
      return { id: c.id, layer: c.layer, pass: false, score: 0, fails: [`error: ${(e as Error).message}`], message: c.message, signals: c.signals ?? {}, transcript: "(error)", criteria: [], ...measured() };
    }
  };

  // Bounded-concurrency pool: run up to EVAL_CONCURRENCY (default 8) cases at once. Results are written
  // by index so the report stays in corpus order regardless of completion order. ~8x faster than serial.
  const concurrency = Math.max(1, Number(process.env.EVAL_CONCURRENCY ?? 8));
  const results: any[] = new Array(cases.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= cases.length) return;
      results[i] = await gradeCase(cases[i]);
    }
  }
  console.log(`(running ${concurrency} at a time)\n`);
  await Promise.all(Array.from({ length: Math.min(concurrency, cases.length) }, worker));
  process.stdout.write("\n\n");

  // Aggregate by layer.
  const byLayer: Record<string, { pass: number; total: number }> = {};
  for (const r of results) {
    const agg = (byLayer[r.layer] ??= { pass: 0, total: 0 });
    agg.total++;
    if (r.pass) agg.pass++;
  }
  console.log("per-layer pass rate:");
  for (const [layer, s] of Object.entries(byLayer).sort()) {
    const floor = FLOOR_LAYERS.has(layer) ? " 🔒" : "";
    console.log(`  ${layer.padEnd(14)} ${s.pass}/${s.total} (${Math.round((s.pass / s.total) * 100)}%)${floor}`);
  }
  const passed = results.filter((r) => r.pass).length;
  const floorFails = results.filter((r) => FLOOR_LAYERS.has(r.layer) && !r.pass);
  console.log(`\nOVERALL: ${passed}/${results.length} (${Math.round((passed / results.length) * 100)}%) | floor fails: ${floorFails.length} [${floorFails.map((r) => r.id).join(", ")}]`);

  // ERRORED cases are NOT quality failures — a thrown complete() (empty completion, timeout, safety block)
  // is recorded with fails like ["error: …"]. Lumping them into the pass-rate makes a broken RUN look like
  // a quality regression (this masked a total agent-call failure once). Surface them distinctly, with the
  // distinct causes, so a run is diagnosable at a glance.
  const errored = results.filter((r: any) => (r.fails ?? []).some((f: string) => f.startsWith("error:")));
  if (errored.length) {
    const causes = new Map<string, number>();
    for (const r of errored) {
      const msg = (r.fails as string[]).find((f) => f.startsWith("error:")) ?? "error: (unknown)";
      causes.set(msg, (causes.get(msg) ?? 0) + 1);
    }
    console.log(`\n⚠️  ERRORED CASES (not quality fails): ${errored.length}/${results.length}. Distinct causes:`);
    for (const [msg, n] of [...causes.entries()].sort((a, b) => b[1] - a[1])) console.log(`   ${n}×  ${msg}`);
  }

  // §8 cost + latency: roll the per-call events up in corpus order (deterministic) and PRINT them.
  // This is reporting, not gating — the run's exit code below is unchanged and depends only on the
  // safety/injection floor, exactly as before. The threshold DECISION is now stated in suites.ts: both
  // suites stay ungated because the spec's 85/88 are 0-100 scores with no defined scoring function, and
  // inventing one would manufacture false assurance.
  const metrics = aggregate(
    results.flatMap((r: any) => r.events ?? []),
    results.reduce((n: number, r: any) => n + (r.turns ?? 0), 0),
    undefined,
    { tokensIncomplete: results.some((r: any) => r.tokensIncomplete) },
  );
  console.log(`\n${formatRunMetrics(metrics)}`);

  // §8's SEVEN NAMED PRODUCTION SUITES, scored from this run (suites.ts). REPORT ONLY on this path:
  //   • What blocks here is UNCHANGED — the safety/injection floor check below, exactly as before.
  //   • The case-rate suites are judge-graded, and the committed live baseline (.github/eval-baseline.json)
  //     records observed rates far below the spec's numbers (e.g. identity 0.30, support 0.30,
  //     grounding 0.50). Enforcing accuracy ≥92 / compliance =100 on the live judge today would block every
  //     run, and whether that gap is agent quality or judge strictness is not established. So the numbers
  //     are PRINTED with a loud verdict — never silently defaulted to a pass — and the deterministic
  //     gate (`pnpm eval`, src/run.ts) is where the same suites actually block.
  //   • `floor` is derived from FLOOR_LAYERS, the same set this script already gates on, so the safety
  //     suite's verdict and the exit code below read the one mechanism (no parallel gate to drift).
  const suiteReport = scoreSuites(liveSuiteCases(results, FLOOR_LAYERS), { measurements: liveMeasurements(metrics) });
  console.log(
    `\n${formatSuiteReport(suiteReport, { enforced: false })}\n  (what DOES gate this run: the safety/injection floor — ${floorFails.length} fail(s).)`,
  );

  const dir = join(here, "..", "..", "..", "reports");
  mkdirSync(dir, { recursive: true });
  // `events` is stripped alongside the transcript: the per-call detail is bulky and the per-case
  // latencyMs/tokens/modelCalls totals derived from it stay on every row.
  const lean = results.map(({ transcript, criteria, message, signals, events, ...r }: any) => r);
  writeFileSync(
    join(dir, "full-eval-report.json"),
    JSON.stringify(
      {
        total: results.length,
        passed,
        byLayer,
        metrics,
        // The named suites as scored on THIS path, each row carrying `gating` + `blocking` so a reader can
        // see which verdicts were enforced (none here) rather than having to infer it.
        suites: { enforced: false, enforcedBy: "safety/injection floor (unchanged)", ...suiteReport },
        floorFails: floorFails.map((r) => r.id),
        results: lean,
      },
      null,
      2,
    ),
  );
  console.log("report: reports/full-eval-report.json");
  // EVAL_DETAIL: dump transcripts + per-criterion judge reasons (the evidence for diagnosing weak layers).
  if (process.env.EVAL_DETAIL) {
    writeFileSync(join(dir, "full-eval-detail.json"), JSON.stringify(results, null, 2));
    console.log("detail: reports/full-eval-detail.json");
  }

  if (guard.crossFamily && floorFails.length) {
    console.error(`FULL EVAL GATE FAIL — ${floorFails.length} safety/injection floor case(s) failed.`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
