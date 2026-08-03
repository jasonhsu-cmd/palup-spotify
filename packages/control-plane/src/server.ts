import Fastify, { type FastifyRequest, type FastifyReply } from "fastify";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { DEFAULT_POLICY } from "@palup/widget-brain";
import { AutoLoop, EvolutionEngine, FileStore, MockGrader, seedCandidates, type Grader, type PolicyMetrics } from "@palup/evolution";
import { createVertexAdapter, isVertexConfigured } from "@palup/model-vertex";
import { createAnthropicApiAdapter, createAnthropicApiJudge, isAnthropicApiConfigured } from "@palup/judge";
import { LiveGrader } from "./live-grader.js";
import { AGENT_FAMILY, decideGating, liveJudgeFamily } from "./gating.js";
import { ScenarioGrader } from "./scenario-grader.js";
import { ModelProposer } from "./model-proposer.js";
import { SCENARIOS } from "./scenarios.js";
import { canaryConfig, canaryStats, startCanary, stopCanary, shadowEvaluate, DEFAULT_CANARY, MAX_CANARY_PCT } from "./canary-controller.js";
import { applyCanaryVerdict } from "./canary-reaction.js";
import { createRuntimeStore, killStatus, armKill, disarmKill, matchedKill, RUNTIME_AGENT_TYPE, setAutoPromoteOptIn, type KillScope, type KillEntry } from "@palup/state-postgres";
import { createOperatorTokenIdentity, createStoreTelemetry, deriveCostUsd, loadModelPrices, type RuntimeStatePort } from "@palup/platform-ports";

const here = dirname(fileURLToPath(import.meta.url));
const dashboardHtml = readFileSync(join(here, "..", "public", "index.html"), "utf8");

// Preset scores for instant offline demonstration (CP_MODE unset). CP_MODE=live measures policies for
// real via the live Gemini agent + cross-family judge.
const MOCK_SCORES: Record<string, PolicyMetrics> = {
  [DEFAULT_POLICY.id]: { policyId: DEFAULT_POLICY.id, safetyPass: true, floorPass: true, qualityScore: 0.75, counterMetrics: { returnRate: 0.08, complaintRate: 0.03, optOutRate: 0.1, escalationRecall: 1 } },
  "cand-warm-concise": { policyId: "cand-warm-concise", safetyPass: true, floorPass: true, qualityScore: 0.9, counterMetrics: { returnRate: 0.06, complaintRate: 0.02, optOutRate: 0.08, escalationRecall: 1 } },
  "cand-confident": { policyId: "cand-confident", safetyPass: true, floorPass: true, qualityScore: 0.8, counterMetrics: { returnRate: 0.08, complaintRate: 0.03, optOutRate: 0.1, escalationRecall: 1 } },
  "cand-aggressive": { policyId: "cand-aggressive", safetyPass: true, floorPass: true, qualityScore: 0.6, counterMetrics: { returnRate: 0.18, complaintRate: 0.09, optOutRate: 0.4, escalationRecall: 0.7 } },
};

function chooseGrader(): { grader: Grader; mode: string; judgeFamily: string } {
  if (process.env.CP_MODE === "live" && isVertexConfigured()) {
    // Fail-CLOSED label (ADR-0014): the same-family Gemini fallback is advisory and CANNOT gate a
    // promotion — LiveGrader stamps metrics.gating=false and engine.gate refuses it. Label it honestly.
    const decision = decideGating(AGENT_FAMILY, liveJudgeFamily(isAnthropicApiConfigured()));
    const label = decision.gating ? "anthropic (Opus) — gating" : "gemini (advisory — NOT gating: same family)";
    return { grader: new LiveGrader(), mode: "live", judgeFamily: label };
  }
  return { grader: new MockGrader(MOCK_SCORES), mode: "mock", judgeFamily: "preset" };
}

export async function buildServer(opts?: { store?: RuntimeStatePort }) {
  const { grader, mode, judgeFamily } = chooseGrader();
  const championMetrics = await grader.grade(DEFAULT_POLICY);
  const engine = new EvolutionEngine({ champion: { policy: DEFAULT_POLICY, metrics: championMetrics }, grader });

  // Shared run-time state store for operator actions on the LIVE plane (run-time kill switch). Prod
  // points this at the same Cloud SQL as the widget backend (DATABASE_URL) so a kill propagates. Tests
  // can inject a store so an operator kill is armed on the SAME instance the promotion path reads.
  const runtimeStore = opts?.store ?? (await createRuntimeStore()).store;

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

  // RUN-TIME Kill Switch enforcement on the PROMOTION path (governance NN #4, ADR-0014). approve ->
  // promote pushes new behavior to the LIVE shopper agent, so it must honor the operator's RUN-TIME kill
  // — the 3-scope registry an operator actually arms via /api/runtime-kill on the SHARED store — NOT only
  // the engine's in-process build-time `killed` flag (engine.approve/promote still enforce that
  // SEPARATELY; this is IN ADDITION, not a replacement). The champion is platform-wide (no single tenant
  // in scope), so we check the two scopes that halt the shopper agent everywhere: `global` and
  // `agent:<RUNTIME_AGENT_TYPE>` (matchedKill with no tenantId — a per-tenant kill halts one merchant's
  // serving, not a platform-wide promotion). FAIL CLOSED: if the registry can't be read, an unknown kill
  // state is treated as KILLED. Reuses matchedKill + RUNTIME_AGENT_TYPE — no kill logic reimplemented.
  const assertRuntimeNotKilled = async () => {
    let kill: KillEntry | null = null;
    try {
      kill = await matchedKill(runtimeStore, { agentType: RUNTIME_AGENT_TYPE });
    } catch (e) {
      throw new Error(`run-time kill state unreadable — refusing to promote to the live agent (fail-closed): ${(e as Error).message}`);
    }
    if (kill) throw new Error(`run-time kill switch is ON (scope "${kill.scope}") — promotion to the live shopper agent is halted`);
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
  app.post("/api/approve/:id", async (req) => act(async () => { await assertRuntimeNotKilled(); engine.approve((req.params as { id: string }).id, "operator"); }));
  app.post("/api/reject/:id", async (req) => act(() => engine.reject((req.params as { id: string }).id, "operator")));
  app.post("/api/promote/:id", async (req) => act(async () => { await assertRuntimeNotKilled(); engine.promote((req.params as { id: string }).id); }));
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
  // Canary is keyed per SERVING tenant (ADR-0014 blast-radius fix): the operator names the merchant
  // (query/body `tenantId`, default the demo tenant), and start/stop/read touch ONLY that tenant's
  // config — never a cross-tenant __system__ bucket. Mirrors the /api/telemetry tenant coercion.
  const canaryTenant = (v: unknown): string => (typeof v === "string" && v ? v : "demo");
  // Security review B1 — the canary READ returns a caller-named tenant's stats/config; the global hook
  // leaves GET open, so this route self-authenticates `operator:read` (mirrors /api/telemetry), else an
  // anonymous caller could read ANY merchant's canary data via ?tenantId=<victim>. The POST paths
  // (start/stop/shadow) are already operator:mutate-gated by the onRequest hook and stay platform-
  // operator-scoped (the shared OPERATOR_TOKEN — no per-tenant authz yet; acceptable while this is the
  // PalUp operator/admin plane, NOT merchant-facing).
  const requireOperatorRead = async (req: FastifyRequest, reply: FastifyReply): Promise<boolean> => {
    const auth = req.headers["authorization"];
    const token = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : undefined;
    const principal = await operatorIdentity.authenticate(token);
    if (!operatorIdentity.authorize(principal, "operator:read")) {
      await reply.code(401).send({ error: "operator authentication required (Authorization: Bearer <OPERATOR_TOKEN>)" });
      return false;
    }
    return true;
  };
  app.get("/api/canary", async (req, reply) => {
    if (!(await requireOperatorRead(req, reply))) return;
    const tenantId = canaryTenant((req.query as { tenantId?: unknown })?.tenantId);
    return { config: await canaryConfig(runtimeStore, tenantId), stats: await canaryStats(runtimeStore, tenantId) };
  });
  app.post("/api/canary/start", async (req) => {
    const b = (req.body ?? {}) as { pct?: number; tenantId?: unknown };
    return { config: await startCanary(runtimeStore, canaryTenant(b.tenantId), DEFAULT_CANARY, Number(b.pct ?? MAX_CANARY_PCT)) };
  });
  app.post("/api/canary/stop", async (req) => {
    const b = (req.body ?? {}) as { tenantId?: unknown };
    return { config: await stopCanary(runtimeStore, canaryTenant(b.tenantId)) };
  });

  // ADR-0014 prereq #6 — SET a merchant's auto-promote opt-in. POST ⇒ already operator:mutate-gated by
  // the onRequest hook; ON TOP of that this high-sensitivity flag requires a real STEP-UP assertion
  // (x-stepup-assertion header, elevated AUTOPROMOTE_STEPUP_SECRET), bound to this exact action+tenant,
  // single-use, and audited. An agent can never reach this: the actor is the authenticated operator and
  // setAutoPromoteOptIn refuses a non-human actor. Ships dormant — the platform override defaults
  // force-human, so flipping one merchant's opt-in still does not enable the fast-lane on its own.
  app.post("/api/autopromote/optin", async (req, reply) => {
    const b = (req.body ?? {}) as { tenantId?: unknown; enabled?: unknown };
    const tenantId = typeof b.tenantId === "string" && b.tenantId ? b.tenantId : undefined;
    if (!tenantId) return reply.code(400).send({ error: "tenantId required" });
    const hdr = req.headers["x-stepup-assertion"];
    const stepUpToken = typeof hdr === "string" ? hdr : undefined;
    try {
      await setAutoPromoteOptIn(runtimeStore, tenantId, b.enabled === true, {
        actor: "operator", // the authenticated operator principal (shared-token model → "operator")
        stepUpToken,
        stepUpSecret: process.env.AUTOPROMOTE_STEPUP_SECRET,
      });
      return { ok: true, tenantId, enabled: b.enabled === true };
    } catch (e) {
      // Operator IS authenticated (onRequest hook) but the sensitive SET failed its step-up / actor
      // check → 403, not a 200-with-error. Message carries no secret.
      return reply.code(403).send({ error: (e as Error).message });
    }
  });
  // Shadow-grade the canary on real logged traffic (live model + judge). Auto-rolls-back on regression.
  app.post("/api/canary/shadow", async (req) => {
    if (!isVertexConfigured() || !isAnthropicApiConfigured()) return { error: "shadow eval needs GOOGLE_CLOUD_PROJECT + ANTHROPIC_API_KEY" };
    const b = (req.body ?? {}) as { tenantId?: unknown };
    const tenantId = canaryTenant(b.tenantId);
    const policy = (await canaryConfig(runtimeStore, tenantId))?.policy ?? DEFAULT_CANARY;
    const result = await shadowEvaluate(runtimeStore, createVertexAdapter(), createAnthropicApiJudge(), tenantId, policy);
    // ADR-0014 #9 — a canary "rollback" verdict stops the canary AND freezes this merchant's auto-promote
    // fast-lane (offline-testable helper; the live shadowEvaluate above stays credential-gated).
    const { rolledBack } = await applyCanaryVerdict(runtimeStore, tenantId, result.verdict);
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
