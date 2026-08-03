// `pnpm evolve` — runs the REAL self-improvement loop live and prints the improvement timeline.
//   GOOGLE_CLOUD_PROJECT=... GOOGLE_CLOUD_LOCATION=global PALUP_MODEL=gemini-2.5-flash \
//   ANTHROPIC_API_KEY=... ANTHROPIC_MODEL=claude-sonnet-5 pnpm evolve
// State (champion, candidates, audit, improvement-timeline) is persisted to .palup-state/.
import { DEFAULT_POLICY } from "@palup/widget-brain";
import { AutoLoop, EvolutionEngine, FileStore } from "@palup/evolution";
import { createVertexAdapter, isVertexConfigured } from "@palup/model-vertex";
import { createAnthropicApiAdapter, createAnthropicApiJudge, isAnthropicApiConfigured } from "@palup/judge";
import { createRuntimeStore, matchedKill, RUNTIME_AGENT_TYPE } from "@palup/state-postgres";
import { ScenarioGrader } from "./scenario-grader.js";
import { ModelProposer } from "./model-proposer.js";
import { SCENARIOS } from "./scenarios.js";

async function main() {
  if (!isVertexConfigured()) throw new Error("set GOOGLE_CLOUD_PROJECT (+ location/model) for the live agent");
  if (!isAnthropicApiConfigured()) throw new Error("set ANTHROPIC_API_KEY for the cross-family judge + proposer");

  const log = (m: string) => console.log(m);
  const agent = createVertexAdapter();
  const judge = createAnthropicApiJudge(); // cross-family (Claude); respects ANTHROPIC_MODEL
  const proposerModel = createAnthropicApiAdapter(); // author candidates with the capable model
  const grader = new ScenarioGrader(agent, judge, SCENARIOS, log);
  const proposer = new ModelProposer(proposerModel, 2, log);
  const store = new FileStore(".palup-state");
  // ADR-0014 #1 / NN #4 — the SHARED run-time kill registry (global > tenant > agent), on the same
  // RuntimeStatePort serving reads. The auto-approve fast-lane consults it (fail-closed) before every
  // promotion, so an operator kill halts self-improvement even mid-run.
  const { store: runtimeStore } = await createRuntimeStore();
  const RUNTIME_TENANT = "demo"; // single-tenant demo; per-tenant when multi-tenancy lands (ADR-0014)

  const rounds = Number(process.env.EVOLVE_ROUNDS ?? 3);
  // NN #2: promotion requires a HUMAN by default. Auto-approve is strictly opt-IN (never the default),
  // and even then only promotes a candidate that already passed the eval gate AND with no kill armed.
  const autoApprove = process.env.EVOLVE_AUTO_APPROVE === "true";

  console.log(`\n=== SELF-IMPROVEMENT LOOP (live) — ${SCENARIOS.length} scenarios, up to ${rounds} rounds ===`);
  console.log("Grading the baseline champion…");
  const championMetrics = await grader.grade(DEFAULT_POLICY);
  const engine = new EvolutionEngine({ champion: { policy: DEFAULT_POLICY, metrics: championMetrics }, grader });

  const loop = new AutoLoop({
    engine,
    grader,
    proposer,
    store,
    now: () => new Date().toISOString(),
    candidatesPerRound: 2,
    minDelta: Number(process.env.EVOLVE_MIN_DELTA ?? 0.05),
    autoApprove,
    killCheck: () => matchedKill(runtimeStore, { tenantId: RUNTIME_TENANT, agentType: RUNTIME_AGENT_TYPE }),
    log,
  });
  const timeline = await loop.run(rounds);

  // Proof: the improvement timeline.
  console.log("\n=== IMPROVEMENT TIMELINE (persisted to .palup-state/improvement-timeline.json) ===");
  for (const e of timeline) {
    const q = e.qualityBefore !== undefined ? `${(e.qualityBefore * 100).toFixed(0)}% → ${(e.qualityAfter * 100).toFixed(0)}%` : `${(e.qualityAfter * 100).toFixed(0)}%`;
    console.log(`  round ${e.round} [${e.event}] quality ${q}  ${e.note ?? ""}`);
  }
  const first = timeline[0];
  const last = timeline[timeline.length - 1];
  const gain = (last.qualityAfter - first.qualityAfter) * 100;
  console.log(`\nNet quality change: ${gain >= 0 ? "+" : ""}${gain.toFixed(0)} pts (${(first.qualityAfter * 100).toFixed(0)}% → ${(last.qualityAfter * 100).toFixed(0)}%)`);
  console.log(`Final champion: ${engine.getChampion().policy.id} — "${engine.getChampion().policy.label}"`);
  console.log(`Promotions: ${engine.getHistory().length} | audit entries: ${engine.getAudit().length}`);
}

main().catch((e) => {
  console.error("evolve failed:", e?.message ?? e);
  process.exit(1);
});
