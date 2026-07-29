import Fastify from "fastify";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { DEFAULT_POLICY } from "@palup/widget-brain";
import { AutoLoop, EvolutionEngine, FileStore, MockGrader, seedCandidates, type Grader, type PolicyMetrics } from "@palup/evolution";
import { createVertexAdapter, isVertexConfigured } from "@palup/model-vertex";
import { createAnthropicApiAdapter, createAnthropicApiJudge, isAnthropicApiConfigured } from "@palup/judge";
import { LiveGrader } from "./live-grader.js";
import { ScenarioGrader } from "./scenario-grader.js";
import { ModelProposer } from "./model-proposer.js";
import { SCENARIOS } from "./scenarios.js";
import { canaryConfig, canaryStats, startCanary, stopCanary, shadowEvaluate, DEFAULT_CANARY, MAX_CANARY_PCT } from "./canary-controller.js";
import { createRuntimeStore, killStatus, armKill, disarmKill, type KillScope } from "@palup/state-postgres";
import { createOperatorTokenIdentity, createStoreTelemetry, deriveCostUsd, loadModelPrices } from "@palup/platform-ports";

const here = dirname(fileURLToPath(import.meta.url));
const dashboardHtml = readFileSync(join(here, "..", "public", "index.html"), "utf8");

// Preset scores for instant offline demonstration (CP_MODE unset). CP_MODE=live measures policies for
// real via the live Gemini agent + cross-family judge.
const MOCK_SCORES: Record<string, PolicyMetrics> = {
  [DEFAULT_POLICY.id]: { policyId: DEFAULT_POLICY.id, safetyPass: true, floorPass: true, qualityScore: 0.75, counterMetrics: { returnRate: 0.08, complaintRate: 0.03 } },
  "cand-warm-concise": { policyId: "cand-warm-concise", safetyPass: true, floorPass: true, qualityScore: 0.9, counterMetrics: { returnRate: 0.06, complaintRate: 0.02 } },
  "cand-confident": { policyId: "cand-confident", safetyPass: true, floorPass: true, qualityScore: 0.8, counterMetrics: { returnRate: 0.08, complaintRate: 0.03 } },
  "cand-aggressive": { policyId: "cand-aggressive", safetyPass: true, floorPass: true, qualityScore: 0.6, counterMetrics: { returnRate: 0.18, complaintRate: 0.09 } },
};

function chooseGrader(): { grader: Grader; mode: string; judgeFamily: string } {
  if (process.env.CP_MODE === "live" && isVertexConfigured()) {
    return { grader: new LiveGrader(), mode: "live", judgeFamily: isAnthropicApiConfigured() ? "anthropic (Opus)" : "gemini (advisory)" };
  }
  return { grader: new MockGrader(MOCK_SCORES), mode: "mock", judgeFamily: "preset" };
}

export async function buildServer() {
  const { grader, mode, judgeFamily } = chooseGrader();
  const championMetrics = await grader.grade(DEFAULT_POLICY);
  const engine = new EvolutionEngine({ champion: { policy: DEFAULT_POLICY, metrics: championMetrics }, grader });

  // Shared run-time state store for operator actions on the LIVE plane (run-time kill switch). Prod
  // points this at the same Cloud SQL as the widget backend (DATABASE_URL) so a kill propagates.
  const { store: runtimeStore } = await createRuntimeStore();

  const app = Fastify({ logger: false });

  // OPERATOR AUTH (M1 T4, governance NN #4/#2): default-deny every MUTATING (POST) route — arming/
  // disarming the kill switch, approving/promoting a candidate, starting/stopping a canary. Caller must
  // present `Authorization: Bearer <OPERATOR_TOKEN>`; an absent/wrong token → 401. FAIL-CLOSED: if
  // OPERATOR_TOKEN is unset, every mutation is denied (the control plane can't be operated without it).
  // Read routes stay open for the dashboard for now (info-disclosure follow-up when it gets an auth UI).
  // The shared-token gate is the interim posture; SSO/passkey + step-up + two-person land behind the
  // same identity port next (identity-and-access.md §1-2).
  const operatorIdentity = createOperatorTokenIdentity(process.env.OPERATOR_TOKEN);
  app.addHook("onRequest", async (req, reply) => {
    // Gate everything except the safe (read) methods, so a future non-POST mutation can't slip the gate.
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return;
    const auth = req.headers["authorization"];
    const token = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : undefined;
    const principal = await operatorIdentity.authenticate(token);
    if (!operatorIdentity.authorize(principal, "operator:mutate")) {
      await reply.code(401).send({ error: "operator authentication required (Authorization: Bearer <OPERATOR_TOKEN>)" });
      return; // stop the hook chain / handler (defensive; Fastify already halts after send)
    }
  });
  const state = () => ({
    mode,
    judgeFamily,
    killed: engine.isKilled(),
    champion: engine.getChampion(),
    candidates: engine.getCandidates(),
    history: engine.getHistory(),
    audit: engine.getAudit().slice(-40),
  });
  // Wrap engine mutations so an invalid transition returns {error} instead of a 500.
  const act = async (fn: () => unknown | Promise<unknown>) => {
    try {
      await fn();
      return state();
    } catch (e) {
      return { ...state(), error: (e as Error).message };
    }
  };

  app.get("/api/state", async () => state());
  app.get("/health", async () => ({ ok: true, mode }));

  // M3 — cost/latency telemetry read (ADR-0013). EXPLICITLY operator-gated: cost data is sensitive and
  // the global onRequest hook leaves GET open (dashboard reads; info-disclosure follow-up), so this
  // route must NOT rely on that posture — it authenticates the bearer itself. $ is derived at read from
  // the price table; an unpriced (real) model is flagged, never guessed; margin is unavailable until the
  // ADR-0007 revenue ledger exists.
  app.get("/api/telemetry", async (req, reply) => {
    const auth = req.headers["authorization"];
    const token = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : undefined;
    const principal = await operatorIdentity.authenticate(token);
    if (!operatorIdentity.authorize(principal, "operator:read")) {
      await reply.code(401).send({ error: "operator authentication required (Authorization: Bearer <OPERATOR_TOKEN>)" });
      return;
    }
    const q = (req.query as { tenantId?: unknown })?.tenantId;
    const tenantId = typeof q === "string" && q ? q : "demo"; // coerce odd/array/missing → default
    // Bound the read (review Finding 1): roll up the most recent N events, independent of stream-trim
    // status, so an operator read can never load an unbounded stream into memory.
    const rollup = await createStoreTelemetry(runtimeStore).query({ tenantId }, { limit: 10_000 });
    const cost = deriveCostUsd(rollup, loadModelPrices());
    return {
      tenantId,
      rollup,
      cost,
      margin: { status: "unavailable", reason: "revenue attribution (ADR-0007 outcome ledger) not yet built — showing COGS + latency only" },
    };
  });
  app.post("/api/seed", async () =>
    act(() => {
      const existing = new Set(engine.getCandidates().map((c) => c.policy.id));
      for (const c of seedCandidates()) if (!existing.has(c.id)) engine.propose(c);
    }),
  );
  app.post("/api/evaluate/:id", async (req) => {
    const id = (req.params as { id: string }).id;
    // Status flips to "evaluating" synchronously. In live mode grading (~15–30s: live Gemini + Opus
    // judge) runs in the background and the dashboard picks up the result by polling; in mock mode it's
    // instant, so we await it (keeps the CI E2E deterministic).
    const p = engine.evaluate(id).catch((e) => console.error(`[eval ${id}]`, (e as Error).message));
    if (mode !== "live") await p;
    return state();
  });
  app.post("/api/approve/:id", async (req) => act(() => engine.approve((req.params as { id: string }).id, "operator")));
  app.post("/api/reject/:id", async (req) => act(() => engine.reject((req.params as { id: string }).id, "operator")));
  app.post("/api/promote/:id", async (req) => act(() => engine.promote((req.params as { id: string }).id)));
  // BUILD-TIME plane kill: halts candidate approvals/promotions in the evolution pipeline.
  app.post("/api/kill", async () => act(() => engine.kill("operator")));
  app.post("/api/unkill", async () => act(() => engine.unkill()));

  // RUN-TIME plane kill (governance NN #4): halts the LIVE shopper agent for a scope (global / one
  // tenant / one agent-type), via the SHARED RuntimeStatePort so it propagates to every serving
  // instance (prod: both this plane and the backend point at the same Cloud SQL via DATABASE_URL).
  // Distinct from /api/kill above — this stops the product, not the promotion pipeline. Arm/disarm is
  // audited on the immutable log inside the store.
  app.get("/api/runtime-kill", async () => ({ scopes: await killStatus(runtimeStore) }));
  app.post("/api/runtime-kill", async (req) => {
    const b = (req.body ?? {}) as { scope?: KillScope; reason?: string };
    await armKill(runtimeStore, b.scope ?? "global", b.reason ?? "operator");
    return { scopes: await killStatus(runtimeStore) };
  });
  app.post("/api/runtime-unkill", async (req) => {
    const b = (req.body ?? {}) as { scope?: KillScope };
    await disarmKill(runtimeStore, b.scope);
    return { scopes: await killStatus(runtimeStore) };
  });
  app.post("/api/monitor", async (req) => {
    const b = (req.body ?? {}) as { qualityScore?: number; safetyPass?: boolean };
    return act(() => engine.monitor({ qualityScore: Number(b.qualityScore ?? 0.4), safetyPass: b.safetyPass !== false }));
  });

  // --- Real self-improvement loop: the durable improvement timeline + an interactive live round. ---
  const store = new FileStore(".palup-state");
  let evolving = false;

  app.get("/api/timeline", async () => ({
    timeline: await store.readLog("improvement-timeline"),
    champion: await store.read("champion"),
    scenarios: SCENARIOS.length,
    evolving,
  }));

  // Run the full loop fresh (baseline → propose → evaluate → gate → promote) on the LIVE model, writing
  // the improvement timeline to disk. Background + a flag so the dashboard can poll while it runs.
  app.post("/api/evolve", async () => {
    if (mode !== "live") return { error: "evolve requires CP_MODE=live (real Gemini + judge)" };
    if (!isAnthropicApiConfigured()) return { error: "set ANTHROPIC_API_KEY (judge + proposer)" };
    if (evolving) return { error: "already evolving" };
    evolving = true;
    void (async () => {
      try {
        await store.write("improvement-timeline", []); // fresh run
        const agent = createVertexAdapter();
        const sgrader = new ScenarioGrader(agent, createAnthropicApiJudge(), SCENARIOS);
        const proposer = new ModelProposer(createAnthropicApiAdapter(), 2);
        const championMetrics = await sgrader.grade(DEFAULT_POLICY);
        const eng = new EvolutionEngine({ champion: { policy: DEFAULT_POLICY, metrics: championMetrics }, grader: sgrader });
        // NN #2: the endpoint proposes → evaluates → gates and STOPS at human approval. It must never
        // auto-promote a candidate to shoppers; a human approves + promotes via the Approval Center.
        const loop = new AutoLoop({ engine: eng, grader: sgrader, proposer, store, now: () => new Date().toISOString(), candidatesPerRound: 2, minDelta: 0.05, autoApprove: false });
        await loop.run(Number(process.env.EVOLVE_ROUNDS ?? 2));
      } catch (e) {
        console.error("[evolve]", (e as Error).message);
      } finally {
        evolving = false;
      }
    })();
    return { started: true };
  });

  // --- Shadow / canary: split real traffic to a canary policy, shadow-grade it, auto-rollback. On the
  // shared store, so a start/rollback reaches every serving instance and shadow reads real traffic. ---
  app.get("/api/canary", async () => ({ config: await canaryConfig(runtimeStore), stats: await canaryStats(runtimeStore) }));
  app.post("/api/canary/start", async (req) => {
    const b = (req.body ?? {}) as { pct?: number };
    return { config: await startCanary(runtimeStore, DEFAULT_CANARY, Number(b.pct ?? MAX_CANARY_PCT)) };
  });
  app.post("/api/canary/stop", async () => ({ config: await stopCanary(runtimeStore) }));
  // Shadow-grade the canary on real logged traffic (live model + judge). Auto-rolls-back on regression.
  app.post("/api/canary/shadow", async () => {
    if (!isVertexConfigured() || !isAnthropicApiConfigured()) return { error: "shadow eval needs GOOGLE_CLOUD_PROJECT + ANTHROPIC_API_KEY" };
    const policy = (await canaryConfig(runtimeStore))?.policy ?? DEFAULT_CANARY;
    const result = await shadowEvaluate(runtimeStore, createVertexAdapter(), createAnthropicApiJudge(), policy);
    let rolledBack = false;
    if (result.verdict === "rollback") { await stopCanary(runtimeStore); rolledBack = true; }
    return { result, rolledBack };
  });

  app.get("/", async (_req, reply) => reply.type("text/html").send(dashboardHtml));
  return app;
}

const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (invoked === import.meta.url) {
  const port = Number(process.env.PORT ?? 8990);
  buildServer()
    .then((app) => app.listen({ port, host: "127.0.0.1" }))
    .then(() => console.log(`control plane on http://127.0.0.1:${Number(process.env.PORT ?? 8990)}  (mode=${process.env.CP_MODE === "live" ? "live" : "mock"})`))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
