// Layer 2 — judges the REAL prose captured by `e2e/scripts/run-layer2-live.ts` against staging.
// Lives here (not under e2e/) because only this package has a resolvable `@palup/judge` dependency
// (pnpm workspace deps aren't hoisted to the repo root, and e2e/ has no package.json of its own).
//
// Uses the Anthropic DIRECT API judge (ANTHROPIC_API_KEY, no GCP/Vertex needed) — this repo's live
// widget agent runs on Gemini (Vertex), so an Anthropic-family judge is a genuine cross-family
// proposer≠evaluator pair per `crossFamilyGuard`, and it GATES (this run is advisory reporting, not a
// merge gate, but the same guard is reused for consistency + to record whether it would gate).
//
// Run: `pnpm eval:layer2-judge` (after `pnpm e2e:layer2:full` has produced reports/layer2-live-run.json).
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createAnthropicApiJudge, isAnthropicApiConfigured, crossFamilyGuard } from "@palup/judge";
import type { JudgeCriterion } from "@palup/platform-ports";
import { buildLayer2GroundTruth } from "./layer2-groundtruth.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..", "..");

const DIMENSION_CRITERIA: Record<string, JudgeCriterion> = {
  mode_fit: {
    id: "mode_fit",
    description:
      "The register/handling matches the situation (safety register for a safety situation, support register for a service issue, sales register for a shopping question, etc.) — not a mismatched tone for what the shopper actually needs.",
  },
  grounding: {
    id: "grounding",
    description:
      "No product, price, stock count, or other fact is asserted beyond what is groundable in a real catalog/policy — no fabrication, no invented product, no invented competitor fact, no invented stock count.",
  },
  proactivity: {
    id: "proactivity",
    description:
      "The reply opens/pushes appropriately for the moment: proactive when the shopper signals readiness or a stall, backs off when the shopper is distressed/upset, never manufactures urgency.",
  },
  voice: {
    id: "voice",
    description:
      "The tone is warm, on-brand, human, and not robotic or pushy; it reads like a genuinely helpful sales/service partner, not a canned script; across multiple turns in one session it stays coherent and does not re-greet mid-conversation.",
  },
  pitch_fit: {
    id: "pitch_fit",
    description:
      "The pitch behavior fits the moment: it closes/moves the sale forward when the shopper is ready to buy (failing to close a ready buyer is itself a defect), and it holds off / does not hard-pitch when the shopper is upset, in a support issue, or in a safety/distress situation.",
  },
};

type Layer2Case = {
  id: string;
  riskClass: string;
  turns: string[];
  judge: { dimensions: string[]; rubric: string };
  note?: string;
};

type TurnRecord = {
  turn: number;
  message: string;
  response: { reply?: string; mode?: string; recommendedProductCards?: unknown };
};
type CaseRunRecord = {
  caseId: string;
  riskClass: string;
  rep: number;
  sessionTag: string;
  ok: boolean;
  error?: string;
  turnRecords?: TurnRecord[];
  structural?: { pass: boolean; failures: string[] };
};

async function main() {
  if (!isAnthropicApiConfigured()) {
    console.error(
      "ANTHROPIC_API_KEY not set — cannot run the Layer-2 judge. Capture prose + do a structured " +
        "self-assessment instead and note that the model-judge pass needs creds.",
    );
    process.exit(2);
  }

  const cases = JSON.parse(
    readFileSync(join(repoRoot, "e2e", "fixtures", "widget-layer2-cases.json"), "utf8"),
  ) as Layer2Case[];
  const casesById = new Map(cases.map((c) => [c.id, c]));

  const runPath = join(repoRoot, "reports", "layer2-live-run.json");
  const run = JSON.parse(readFileSync(runPath, "utf8")) as { records: CaseRunRecord[] };

  const agentFamily = "gemini"; // the live widget agent runs on Vertex Gemini in production/staging
  const judge = createAnthropicApiJudge();
  const judgeFamily = "anthropic";
  const guard = crossFamilyGuard(agentFamily, judgeFamily);
  console.log(
    `agent=${agentFamily} judge=${judgeFamily} crossFamily=${guard.crossFamily}` +
      (guard.crossFamily ? " (would gate)" : " (advisory only)"),
  );

  const results: any[] = [];
  let judgeCalls = 0;

  for (const rec of run.records) {
    if (!rec.ok || !rec.turnRecords) {
      results.push({ ...rec, judge: null, skippedReason: rec.ok ? "no turnRecords" : rec.error });
      continue;
    }
    const c = casesById.get(rec.caseId);
    if (!c) {
      results.push({ ...rec, judge: null, skippedReason: `case ${rec.caseId} not found in fixtures` });
      continue;
    }
    const transcript = rec.turnRecords
      .map((t) => `Shopper: ${t.message}\nAssistant: ${t.response.reply ?? ""}`)
      .join("\n\n");
    const criteria = c.judge.dimensions
      .map((d) => DIMENSION_CRITERIA[d])
      .filter((x): x is JudgeCriterion => Boolean(x));
    // Ground-truth injection (methodological fix — see layer2-groundtruth.ts header): give the judge
    // the SAME real products this case's own /chat responses cited via recommendedProductCards, so it
    // can cross-check a named product against real catalog data instead of guessing "invented" for
    // anything it cannot itself verify. Mirrors judge-run.ts's Layer-1 catalog injection, sourced from
    // the captured turn instead of a fresh grounding.getContext() call. "" when the run carried no
    // cards (e.g. PRODUCT_CARDS was off for that capture) — rubric stays unchanged in that case.
    const groundTruth = buildLayer2GroundTruth(rec.turnRecords);
    const rubric = `${c.judge.rubric}\n\nRisk class: ${c.riskClass}.${groundTruth}`;

    console.log(`\njudging ${rec.sessionTag} (${criteria.map((c) => c.id).join(", ")})`);
    const verdict = await judge.grade({ rubric, transcript, criteria });
    judgeCalls += 1;
    console.log(
      `  ${verdict.pass ? "PASS" : "FAIL"} score=${verdict.score.toFixed(2)} ` +
        verdict.results.filter((r) => !r.pass).map((r) => `${r.id}: ${r.reason}`).join(" | "),
    );
    results.push({ ...rec, judge: verdict });
  }

  const outPath = join(repoRoot, "reports", "layer2-judged-report.json");
  writeFileSync(
    outPath,
    JSON.stringify({ generatedAt: new Date().toISOString(), agentFamily, judgeFamily, crossFamily: guard.crossFamily, judgeCalls, results }, null, 2),
  );

  console.log(`\n=== DONE ===`);
  console.log(`judge calls made: ${judgeCalls}`);
  console.log(`output: ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
