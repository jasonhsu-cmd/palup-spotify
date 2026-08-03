// `tsx packages/control-plane/src/auto-optimize.ts` — the OPERATOR-RUN (non-cron) entrypoint for the
// ADR-0014 governed auto-optimize orchestrator (T4g). It composes the real live dependencies and drives
// AutoOptimizeOrchestrator.advance for a demo tenant/candidate.
//
// SHIPS DORMANT: the orchestrator's terminal write (serveAutoChampion) and its Stage-0 pre-flight both
// fail closed on the default-OFF opt-in + default-force-human platform override, so a run against a real
// tenant routes every candidate to the human Approval Center and serves nothing until a human enacts
// ADR-0014 and flips BOTH step-up-gated switches. This file is NEVER a default cron; an operator runs it.
//
//   GOOGLE_CLOUD_PROJECT=... GOOGLE_CLOUD_LOCATION=global PALUP_MODEL=gemini-2.5-flash \
//     ANTHROPIC_API_KEY=... ANTHROPIC_MODEL=claude-sonnet-5 DATABASE_URL=... \
//     tsx packages/control-plane/src/auto-optimize.ts
import { DEFAULT_POLICY, type Policy } from "@palup/widget-brain";
import { EngineRegistry, EvolutionEngine } from "@palup/evolution";
import { createVertexAdapter, isVertexConfigured } from "@palup/model-vertex";
import { createAnthropicApiJudge, isAnthropicApiConfigured } from "@palup/judge";
import { createRuntimeStore } from "@palup/state-postgres";
import { shadowEvaluate, readTrafficLog, DEFAULT_CANARY_POWER } from "./canary-controller.js";
import { measureCanary } from "./canary-measure.js";
import { servingChampion } from "./champion-promoter.js";
import { AutoOptimizeOrchestrator, type OrchestratorDeps } from "./auto-optimize-orchestrator.js";
import { LiveGrader } from "./live-grader.js";

const RUNTIME_TENANT = "demo"; // single-tenant demo; per-tenant when multi-tenancy lands (ADR-0014 #4)

async function main() {
  if (!isVertexConfigured()) throw new Error("set GOOGLE_CLOUD_PROJECT (+ location/model) for the live agent");
  if (!isAnthropicApiConfigured()) throw new Error("set ANTHROPIC_API_KEY for the cross-family gating judge");

  const agent = createVertexAdapter();
  const judge = createAnthropicApiJudge(); // cross-family (Anthropic judging Gemini) — the gating judge
  const grader = new LiveGrader();

  // ADR-0014 #1 / NN #4 — refuse to run auto-promotion against a NON-DURABLE store an operator cannot arm
  // cross-process (an unarmable kill registry = no kill switch). Mirrors evolve.ts's guard.
  const { store, kind } = await createRuntimeStore();
  if (kind !== "postgres") {
    throw new Error(
      "auto-optimize requires a durable, SHARED store — set DATABASE_URL. Refusing to run the governed " +
        "auto-promote orchestrator against a per-process in-memory store (ADR-0014 #1 / NN #4).",
    );
  }

  // Per-tenant engine, seeded from the tenant's live serving champion (or DEFAULT_POLICY) — the orchestrator
  // and any in-process operator surface share this ONE registry so a routed candidate is visible/actionable.
  const engines = new EngineRegistry((tenantId) => {
    void tenantId;
    // PR-1 governance floor: personaPriceInvariance/personaLeakRate are FAIL-CLOSED in engine.gate (absent
    // blocks) — seed the bootstrap champion with the inert-today values (1 / 0) so this entrypoint keeps
    // gating exactly as before (ships INERT, no champion-behavior change).
    return new EvolutionEngine({ champion: { policy: DEFAULT_POLICY, metrics: { policyId: DEFAULT_POLICY.id, safetyPass: true, floorPass: true, qualityScore: 0, counterMetrics: { returnRate: 0.1, complaintRate: 0.05, optOutRate: 0.15, escalationRecall: 1, personaPriceInvariance: 1, personaLeakRate: 0 } } }, grader });
  });

  // Re-grade a reply on a sales-quality rubric via the cross-family judge (for the live canary measurement).
  const CRIT = ["warm", "needs-first", "grounded", "concise", "no-pressure"];
  const gradeReply = async (reply: string, message: string): Promise<number> =>
    (await judge.grade({
      rubric: "Judge this skincare store's sales reply per criterion (pass/fail):\n" + CRIT.map((c) => `- ${c}`).join("\n"),
      transcript: `Shopper: ${message}\nAssistant: ${reply}`,
      criteria: CRIT.map((c) => ({ id: c, description: c })),
    })).score;

  const deps: OrchestratorDeps = {
    engines,
    store,
    runShadow: async (tenantId, policy: Policy) => {
      const r = await shadowEvaluate(store, agent, judge, tenantId, policy);
      return { n: r.n, delta: r.delta };
    },
    runCanaryMeasure: async (tenantId, canaryPolicyId, championPolicyId, window) =>
      measureCanary(await readTrafficLog(store, tenantId), gradeReply, { canaryPolicyId, championPolicyId }, window),
    // CONSERVATIVE PLACEHOLDER thresholds — the real per-tenant values are OWNER-SET at enablement.
    thresholds: DEFAULT_CANARY_POWER,
    // both-sided: bound a regression AND a suspiciously large positive swing (placeholder, owner-set).
    shadowBounds: { maxRegression: 0.05, maxImprovement: 0.5 },
    escalationTolerance: 0.1,
    now: () => new Date().toISOString(),
  };
  const orchestrator = new AutoOptimizeOrchestrator(deps);

  // Demo drive: propose + evaluate a candidate, then advance. While DORMANT this routes to the human
  // Approval Center at Stage 0 (opt-in default OFF) and serves nothing.
  const engine = engines.engineFor(RUNTIME_TENANT);
  const candidate: Policy = { id: "auto-cand-1", label: "auto-cand-1", styleDirective: DEFAULT_POLICY.styleDirective, proactivityDefault: DEFAULT_POLICY.proactivityDefault };
  engine.propose(candidate);
  await engine.evaluate(candidate.id);

  console.log(`\n=== GOVERNED AUTO-OPTIMIZE (dormant unless ADR-0014 enacted + both switches on) ===`);
  const served = await servingChampion(store, RUNTIME_TENANT).catch(() => null);
  console.log(`serving champion before: ${served ? served.policy.id : "DEFAULT_POLICY (none promoted)"}`);
  let steps = 0;
  while (steps++ < 6) {
    const r = await orchestrator.advance(RUNTIME_TENANT, candidate.id);
    console.log(`  advance → ${r.outcome}${r.reason ? ` (${r.reason})` : ""} [stage ${r.stage}]`);
    if (r.outcome === "served" || r.outcome === "routed-to-human") break;
    if (r.outcome === "canary-observing") { console.log("  (canary observing — re-run later as the window fills)"); break; }
  }
}

main().catch((e) => {
  console.error("auto-optimize failed:", e?.message ?? e);
  process.exit(1);
});
