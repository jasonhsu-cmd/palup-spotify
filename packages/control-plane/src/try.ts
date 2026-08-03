// `pnpm try` — an interactive tool to test the self-improving agent yourself. Type ANY shopper message;
// see the agent's live reply + a per-criteria grade. Then /evolve runs the real loop ON YOUR messages
// (propose → evaluate → gate → promote) and the agent improves in place. State persists to .palup-state/.
//
//   GOOGLE_CLOUD_PROJECT=palup-jason GOOGLE_CLOUD_LOCATION=global PALUP_MODEL=gemini-2.5-flash \
//     ANTHROPIC_MODEL=claude-sonnet-5 pnpm try
import readline from "node:readline";
import { DEFAULT_POLICY, createBrain, StaticGroundingAdapter, MockCommerceAdapter } from "@palup/widget-brain";
import { AutoLoop, EvolutionEngine, FileStore, type Champion, type ImprovementEntry } from "@palup/evolution";
import { createVertexAdapter, isVertexConfigured } from "@palup/model-vertex";
import { createAnthropicApiAdapter, createAnthropicApiJudge, isAnthropicApiConfigured } from "@palup/judge";
import { createRuntimeStore, matchedKill, RUNTIME_AGENT_TYPE, readOrchestratorState, recordAutoPromotion, rateLimitReason } from "@palup/state-postgres";
import { ScenarioGrader } from "./scenario-grader.js";
import { screenChange } from "./change-class.js";
import { ModelProposer } from "./model-proposer.js";
import { CRITERIA, rubricFor, type Scenario } from "./scenarios.js";

const CRIT = ["warm", "needs-first", "grounded", "concise", "no-pressure", "helpful-next-step"];

if (!isVertexConfigured()) { console.error("set GOOGLE_CLOUD_PROJECT (+ location/model) for the live agent"); process.exit(1); }
if (!isAnthropicApiConfigured()) { console.error("set ANTHROPIC_API_KEY for the judge + proposer"); process.exit(1); }

const agent = createVertexAdapter();
const judge = createAnthropicApiJudge();
const grounding = new StaticGroundingAdapter();
const commerce = new MockCommerceAdapter();
const store = new FileStore(".palup-state");

let champion: Champion = { policy: DEFAULT_POLICY, metrics: { policyId: DEFAULT_POLICY.id, safetyPass: true, floorPass: true, qualityScore: 0, counterMetrics: { returnRate: 0.1, complaintRate: 0.05, optOutRate: 0.15, escalationRecall: 1, personaPriceInvariance: 1, personaLeakRate: 0 } } };
let brain = createBrain(agent, grounding, champion.policy, commerce, "shopper-demo");
const myScenarios: Scenario[] = [];

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function banner() {
  console.log(`\n=== PalUp — try the self-improving agent ===`);
  console.log(`Type any shopper message. Commands: /evolve  /champion  /timeline  /scenarios  /reset  /help  /quit`);
  console.log(`Champion: "${champion.policy.label}"\n`);
}
const prompt = () => process.stdout.write("you (shopper) ▸ ");

async function grade(message: string, reply: string): Promise<{ score: number; line: string }> {
  const s: Scenario = { id: `m${myScenarios.length}`, message, criteria: CRIT };
  const v = await judge.grade({
    rubric: rubricFor(s),
    transcript: `Shopper: ${message}\nAssistant: ${reply}`,
    criteria: CRIT.map((c) => ({ id: c, description: CRITERIA[c] })),
  });
  const passed = v.results.filter((r) => r.pass).length;
  return { score: passed / CRIT.length, line: v.results.map((r) => `${r.pass ? "✓" : "✗"}${r.id}`).join(" ") };
}

async function handleMessage(msg: string) {
  try {
    const d = await brain.decide({} as never, msg);
    console.log(`\nassistant ▸ ${d.reply}`);
    console.log(`  [mode=${d.mode} · pitch=${d.pitch}${d.escalateToHuman ? " · escalate" : ""}]`);
    const g = await grade(msg, d.reply);
    console.log(`  graded on current champion: ${(g.score * 100).toFixed(0)}%   ${g.line}`);
    myScenarios.push({ id: `m${myScenarios.length}`, message: msg, criteria: CRIT });
    console.log(`  (added to your scenario set — ${myScenarios.length} so far; type /evolve to improve on them)`);
  } catch (e) {
    console.log(`  error: ${(e as Error).message}`);
  }
}

/** Returns "quit" to end the session, otherwise "continue". */
async function route(line: string): Promise<"continue" | "quit"> {
  const msg = (line ?? "").trim();
  if (!msg) return "continue";
  if (!msg.startsWith("/")) { await handleMessage(msg); return "continue"; }
  const c = msg.toLowerCase();
  if (c === "/quit" || c === "/q") return "quit";
  if (c === "/help") { banner(); return "continue"; }
  if (c === "/champion") {
    console.log(`\nchampion: ${champion.policy.id} — "${champion.policy.label}"`);
    console.log(`  directive: ${champion.policy.styleDirective}\n`);
    return "continue";
  }
  if (c === "/scenarios") {
    console.log(myScenarios.length ? "\n" + myScenarios.map((s, i) => `  ${i + 1}. ${s.message}`).join("\n") + "\n" : "\n  (none yet — type some messages first)\n");
    return "continue";
  }
  if (c === "/timeline") {
    const tl = await store.readLog<ImprovementEntry>("improvement-timeline");
    console.log(tl.length ? "\n" + tl.map((e) => `  round ${e.round} [${e.event}] ${(e.qualityAfter * 100).toFixed(0)}%  ${e.note ?? ""}`).join("\n") + "\n" : "\n  (no evolution yet — type /evolve)\n");
    return "continue";
  }
  if (c === "/reset") {
    champion = { policy: DEFAULT_POLICY, metrics: { policyId: DEFAULT_POLICY.id, safetyPass: true, floorPass: true, qualityScore: 0, counterMetrics: { returnRate: 0.1, complaintRate: 0.05, optOutRate: 0.15, escalationRecall: 1, personaPriceInvariance: 1, personaLeakRate: 0 } } };
    brain = createBrain(agent, grounding, champion.policy, commerce, "shopper-demo");
    myScenarios.length = 0;
    console.log(`\nreset to baseline champion + cleared your scenarios.\n`);
    return "continue";
  }
  if (c === "/evolve") {
    if (myScenarios.length === 0) { console.log(`\n  type at least one message first, then /evolve.\n`); return "continue"; }
    console.log(`\n⟳ evolving on YOUR ${myScenarios.length} message(s) — propose → evaluate → gate → promote (live, ~1-2 min)…\n`);
    const grader = new ScenarioGrader(agent, judge, myScenarios, (m) => console.log(m));
    const proposer = new ModelProposer(createAnthropicApiAdapter(), 2, (m) => console.log(m));
    const metrics = await grader.grade(champion.policy);
    const engine = new EvolutionEngine({ champion: { policy: champion.policy, metrics }, grader });
    // Local demo, but still governed: human-gate by default so it demonstrates the real pipeline
    // (opt in with EVOLVE_AUTO_APPROVE=true to watch an auto-promote). NN #2: no default auto-promotion.
    // ADR-0014 #1 / NN #4 — the auto-approve fast-lane fails closed on the SHARED run-time kill registry.
    const { store: runtimeStore, kind: killStoreKind } = await createRuntimeStore();
    const autoApprove = process.env.EVOLVE_AUTO_APPROVE === "true";
    // Without DATABASE_URL the kill store is a per-process in-memory one no operator can arm cross-process;
    // refuse to auto-promote against it (an unarmable kill registry = no kill switch — ADR-0014 #1 / NN #4).
    if (autoApprove && killStoreKind !== "postgres") throw new Error("EVOLVE_AUTO_APPROVE requires a durable, SHARED kill registry — set DATABASE_URL (ADR-0014 #1 / NN #4).");
    const loop = new AutoLoop({ engine, grader, proposer, store, now: () => new Date().toISOString(), candidatesPerRound: 2, minDelta: 0.05, autoApprove, killCheck: () => matchedKill(runtimeStore, { tenantId: "demo", agentType: RUNTIME_AGENT_TYPE }), rateLimitCheck: async () => rateLimitReason(await readOrchestratorState(runtimeStore, "demo"), new Date().toISOString()), recordPromotion: () => recordAutoPromotion(runtimeStore, "demo"), changeScreen: async (p) => { const s = screenChange(p); return s.changeClass === "flagged" ? s.reasons.join(", ") : null; }, log: (m) => console.log(m) });
    await store.write("improvement-timeline", []);
    const tl = await loop.run(Number(process.env.EVOLVE_ROUNDS ?? 2));
    champion = engine.getChampion();
    brain = createBrain(agent, grounding, champion.policy, commerce, "shopper-demo");
    const net = ((tl[tl.length - 1].qualityAfter - tl[0].qualityAfter) * 100).toFixed(0);
    console.log(`\n=== improvement on your scenarios: ${(tl[0].qualityAfter * 100).toFixed(0)}% → ${(tl[tl.length - 1].qualityAfter * 100).toFixed(0)}% (${Number(net) >= 0 ? "+" : ""}${net} pts) ===`);
    console.log(`champion is now "${champion.policy.label}". Keep chatting — replies use the improved agent. (/timeline for detail)\n`);
    return "continue";
  }
  console.log(`  unknown command. /help for the list.`);
  return "continue";
}

async function main() {
  banner();
  prompt();
  // Async-iterate lines: each await completes before the next line is consumed (works for a TTY and
  // for piped input — no EOF race).
  for await (const line of rl) {
    const r = await route(line);
    if (r === "quit") break;
    prompt();
  }
  rl.close();
  process.exit(0);
}
main();
