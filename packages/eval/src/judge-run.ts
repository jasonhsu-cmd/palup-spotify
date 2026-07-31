// Cross-family judge harness — grades the non-deterministic eval layers (tone-coherence,
// grounding-content) that core.json can't. The AGENT runs on the real Gemini model; the JUDGE runs
// on a DIFFERENT family (Claude on Vertex) when JUDGE_FAMILY=anthropic, else a same-family Gemini
// judge that is ADVISORY only (the cross-family guard refuses to gate it). Requires GCP creds.
//   pnpm eval:judge                 # advisory Gemini judge
//   JUDGE_FAMILY=anthropic pnpm eval:judge   # true cross-family (Claude) — gates
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createBrain, createSession, DEFAULT_POLICY, StaticGroundingAdapter, MockCommerceAdapter, demoCommerceGroundTruth } from "@palup/widget-brain";
import type { HistoryTurn } from "@palup/widget-brain";
import { createVertexAdapter, isVertexConfigured } from "@palup/model-vertex";
import {
  createGeminiJudge,
  createAnthropicJudge,
  createAnthropicApiJudge,
  isAnthropicApiConfigured,
  crossFamilyGuard,
} from "@palup/judge";

const here = dirname(fileURLToPath(import.meta.url));
const cases = JSON.parse(readFileSync(join(here, "..", "cases", "subjective.json"), "utf8")) as any[];

async function main() {
  if (!isVertexConfigured()) {
    console.error("Set GOOGLE_CLOUD_PROJECT + ADC — the judge harness runs the agent on the real model.");
    process.exit(2);
  }
  const agentFamily = "gemini";
  const grounding = new StaticGroundingAdapter();
  const commerce = new MockCommerceAdapter();
  const brain = createBrain(createVertexAdapter(), grounding, DEFAULT_POLICY, commerce, "shopper-demo");
  // Give the judge the SAME authoritative facts the agent grounded on — catalog (with ingredients) +
  // allergen policy + order/policy/subscription data — so it can tell a real fact from an invented one
  // (otherwise it wrongly flags real catalog prices / real order status as fabricated).
  const ctx = await grounding.getContext("demo");
  const groundTruth =
    "AUTHORITATIVE CATALOG (ground truth — these products, prices, and ingredient lists are REAL and correct):\n" +
    ctx.products
      .map((p) => `- ${p.title} (${p.price})${p.ingredients?.length ? ` — ingredients: ${p.ingredients.join(", ")}` : ""}`)
      .join("\n") +
    (ctx.policy.allergens ? `\nALLERGEN POLICY: ${ctx.policy.allergens}` : "") +
    (await demoCommerceGroundTruth(commerce, "shopper-demo"));

  const wantAnthropic = process.env.JUDGE_FAMILY === "anthropic";
  // Prefer the Anthropic direct API (just a key); fall back to Claude-on-Vertex (needs Model Garden).
  const judge = wantAnthropic
    ? isAnthropicApiConfigured()
      ? createAnthropicApiJudge()
      : createAnthropicJudge()
    : createGeminiJudge();
  const judgeFamily = wantAnthropic ? "anthropic" : "gemini";
  if (wantAnthropic && !isAnthropicApiConfigured()) {
    console.error("(note: ANTHROPIC_API_KEY not set — trying Claude-on-Vertex, which needs Model Garden access)");
  }
  const guard = crossFamilyGuard(agentFamily, judgeFamily, { strict: process.env.JUDGE_STRICT === "1" });
  console.log(
    `\nagent=${agentFamily}  judge=${judgeFamily}  crossFamily=${guard.crossFamily}` +
      (guard.crossFamily ? " (GATING)" : " (ADVISORY — same family, not gating)"),
  );

  const out: any[] = [];
  for (const c of cases) {
    let transcript: string;
    if (c.turns) {
      const s = await createSession(brain); // createSession is async (durable store adapters)
      const lines: string[] = [];
      const history: HistoryTurn[] = []; // replay accumulated transcript each turn, like the prod server
      for (const t of c.turns) {
        const d = await s.send(t, c.signals ?? {}, history);
        lines.push(`Shopper: ${t}\nAssistant: ${d.reply}`);
        history.push({ role: "user", content: t }, { role: "agent", content: d.reply });
      }
      transcript = lines.join("\n\n");
    } else {
      const d = await brain.decide(c.signals ?? {}, c.message);
      transcript = `Shopper: ${c.message}\nAssistant: ${d.reply}`;
    }
    const v = await judge.grade({ rubric: `${c.rubric}\n\n${groundTruth}`, transcript, criteria: c.criteria });
    out.push({ id: c.id, kind: c.kind, pass: v.pass, score: v.score, judgeModel: v.judgeModel, results: v.results });
    console.log(
      `${v.pass ? "✅" : "❌"} ${c.id} (${c.kind}) score=${v.score.toFixed(2)} ` +
        v.results.filter((r) => !r.pass).map((r) => `${r.id}: ${r.reason}`).join(" | "),
    );
  }

  const dir = join(here, "..", "..", "..", "reports");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "judge-report.json"),
    JSON.stringify({ crossFamily: guard.crossFamily, agentFamily, judgeFamily, cases: out }, null, 2),
  );
  console.log("report: reports/judge-report.json");

  const failed = out.filter((o) => !o.pass).length;
  if (guard.crossFamily && failed) {
    console.error(`JUDGE GATE FAIL — ${failed} subjective case(s) failed.`);
    process.exit(1);
  }
  console.log(guard.crossFamily ? "JUDGE GATE OK" : "JUDGE ADVISORY complete (same-family; not a gate).");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
