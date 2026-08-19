import Fastify, { type FastifyRequest, type FastifyReply } from "fastify";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { DEFAULT_POLICY } from "@palup/widget-brain";
import { AutoLoop, EvolutionEngine, EngineRegistry, FileStore, MockGrader, seedCandidates, type Grader, type PolicyMetrics } from "@palup/evolution";
import { createVertexAdapter, isVertexConfigured } from "@palup/model-vertex";
import { createAnthropicApiAdapter, createAnthropicApiJudge, isAnthropicApiConfigured } from "@palup/judge";
import { LiveGrader } from "./live-grader.js";
import { AGENT_FAMILY, decideGating, liveJudgeFamily } from "./gating.js";
import { ScenarioGrader } from "./scenario-grader.js";
import { ModelProposer } from "./model-proposer.js";
import { SCENARIOS } from "./scenarios.js";
import { canaryConfig, canaryStats, startCanary, stopCanary, shadowEvaluate, DEFAULT_CANARY, MAX_CANARY_PCT, DEFAULT_CANARY_POWER } from "./canary-controller.js";
import { applyCanaryVerdict } from "./canary-reaction.js";
import { promoteToServing, monitorServing } from "./champion-promoter.js";
import { readServingMeasuredOutcome } from "./measured-outcome-caller.js";
import { toGateMeasuredOutcome } from "./measured-outcome-signal.js";
import { createRuntimeStore, killStatus, armKill, disarmKill, matchedKill, RUNTIME_AGENT_TYPE, setAutoPromoteOptIn, setPlatformAutoPromote, costCapStatus, setCostCap, clearCostCap, type KillScope, type KillEntry, type CostCapScope } from "@palup/state-postgres";
import { createOperatorTokenIdentity, createStoreTelemetry, deriveCostUsd, loadModelPrices, type RuntimeStatePort } from "@palup/platform-ports";

const here = dirname(fileURLToPath(import.meta.url));
const dashboardHtml = readFileSync(join(here, "..", "public", "index.html"), "utf8");

// Preset scores for instant offline demonstration (CP_MODE unset). CP_MODE=live measures policies for
// real via the live Gemini agent + cross-family judge.
// PR-1 governance floor: personaPriceInvariance/personaLeakRate are FAIL-CLOSED in engine.gate (absent
// blocks) — every preset score below carries the inert-today values (1 / 0) so this offline demo mode
// keeps passing candidates exactly as before (ships INERT, no champion-behavior change).
const MOCK_SCORES: Record<string, PolicyMetrics> = {
  [DEFAULT_POLICY.id]: { policyId: DEFAULT_POLICY.id, safetyPass: true, floorPass: true, qualityScore: 0.75, counterMetrics: { returnRate: 0.08, complaintRate: 0.03, optOutRate: 0.1, escalationRecall: 1, personaPriceInvariance: 1, personaLeakRate: 0 } },
  "cand-warm-concise": { policyId: "cand-warm-concise", safetyPass: true, floorPass: true, qualityScore: 0.9, counterMetrics: { returnRate: 0.06, complaintRate: 0.02, optOutRate: 0.08, escalationRecall: 1, personaPriceInvariance: 1, personaLeakRate: 0 } },
  "cand-confident": { policyId: "cand-confident", safetyPass: true, floorPass: true, qualityScore: 0.8, counterMetrics: { returnRate: 0.08, complaintRate: 0.03, optOutRate: 0.1, escalationRecall: 1, personaPriceInvariance: 1, personaLeakRate: 0 } },
  "cand-aggressive": { policyId: "cand-aggressive", safetyPass: true, floorPass: true, qualityScore: 0.6, counterMetrics: { returnRate: 0.18, complaintRate: 0.09, optOutRate: 0.4, escalationRecall: 0.7, personaPriceInvariance: 1, personaLeakRate: 0 } },
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
  // T4g — per-tenant engine binding via the shared EngineRegistry (a routed candidate lives on the
  // tenant's engine; an in-process orchestrator shares this same registry). All existing routes use
  // engineFor(PROMOTE_TENANT), so their behavior is unchanged. (Cross-PROCESS candidate/approval
  // visibility needs durable engine state — enablement work.)
  // W3-1 (deploy-prep): configurable via env so a real deploy can point this at the actual merchant
  // tenant it's promoting for (e.g. PROMOTE_TENANT=palup-skincare-jason) instead of the demo tenant.
  // Default stays "demo" for back-compat with every existing caller/test that doesn't set it.
  // `?.trim() || "demo"` (not `??`) so an empty/whitespace env value (a deploy misconfig) also falls
  // back to "demo" rather than promoting to a blank tenant id.
  const PROMOTE_TENANT = process.env.PROMOTE_TENANT?.trim() || "demo";
  const engines = new EngineRegistry(() => new EvolutionEngine({ champion: { policy: DEFAULT_POLICY, metrics: championMetrics }, grader }));
  const engine = engines.engineFor(PROMOTE_TENANT);

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
  // NAMED OPERATORS — `OPERATOR_TOKENS` is a JSON map of operatorId -> token, e.g.
  // {"alice":"...","bob":"..."}. The legacy single OPERATOR_TOKEN still works and still resolves to
  // "operator", so an existing deployment is unaffected until names are configured. Malformed JSON is
  // IGNORED (with a warning) rather than throwing: a typo in this env must never take the control plane
  // down, and the legacy token keeps it operable.
  const namedOperators = (() => {
    const raw = process.env.OPERATOR_TOKENS;
    if (!raw) return undefined;
    try {
      const o = JSON.parse(raw);
      if (o && typeof o === "object" && !Array.isArray(o)) return o as Record<string, string>;
    } catch { /* fall through */ }
    console.warn("[config] OPERATOR_TOKENS is not a valid JSON object — ignoring; named operators disabled");
    return undefined;
  })();
  const operatorIdentity = createOperatorTokenIdentity(process.env.OPERATOR_TOKEN, namedOperators);
  // A two-person rule needs two people. With one shared token every operator IS "operator", so enforcing
  // it would block every promotion; silently skipping it would be the "control that never applies"
  // pattern. It activates exactly when it becomes satisfiable, and the state is reported on /api/state.
  const twoPersonPromote = operatorIdentity.operatorCount >= 2;
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
  /** The operator id behind THIS request, from the same token the auth hook already validated. Falls
   * back to "operator" so a single-token deployment behaves exactly as before. */
  const actingOperator = async (req: FastifyRequest): Promise<string> => {
    const auth = req.headers["authorization"];
    const token = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : undefined;
    const p = await operatorIdentity.authenticate(token);
    return p.kind === "operator" ? p.operatorId : "operator";
  };
  const state = () => ({
    mode,
    judgeFamily,
    /** Whether approver != promoter is being ENFORCED. False means one shared operator identity, so the
     * rule is unsatisfiable — surfaced rather than left to look enforced. */
    twoPersonPromote,
    operatorCount: operatorIdentity.operatorCount,
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

  // GET-route operator gate (W1-B / security review): the global onRequest hook above deliberately
  // leaves ALL GET requests open (so the dashboard's plain reads work without wiring auth through every
  // fetch) — that posture was fine while every GET was non-sensitive, but /api/state and /api/timeline
  // both return governance-sensitive data (approval/audit history, the durable champion) and were
  // reachable by ANY caller with no token at all. This is the same self-authenticating shape
  // /api/telemetry and /api/canary already use (defined once here, reused everywhere a read needs it),
  // moved above the routes so /api/state is never accidentally left off. FAIL-CLOSED: if OPERATOR_TOKEN
  // (and OPERATOR_TOKENS) are both unset, operatorIdentity.authenticate has no way to mint a valid
  // principal, so authorize() denies every caller — a read stays refused, not silently open.
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

  app.get("/api/state", async (req, reply) => {
    if (!(await requireOperatorRead(req, reply))) return;
    return state();
  });
  app.get("/health", async () => ({ ok: true, mode }));

  // M3 — cost/latency telemetry read (ADR-0013). EXPLICITLY operator-gated: cost data is sensitive and
  // the global onRequest hook leaves GET open (dashboard reads; info-disclosure follow-up), so this
  // route must NOT rely on that posture — it authenticates the bearer itself. $ is derived at read from
  // the price table; an unpriced (real) model is flagged, never guessed; margin is unavailable until the
  // ADR-0007 revenue ledger exists.
  app.get("/api/telemetry", async (req, reply) => {
    if (!(await requireOperatorRead(req, reply))) return;
    const q = (req.query as { tenantId?: unknown })?.tenantId;
    const tenantId = typeof q === "string" && q ? q : "demo"; // coerce odd/array/missing → default
    // Bound the read (review Finding 1): roll up the most recent N events, independent of stream-trim
    // status, so an operator read can never load an unbounded stream into memory.
    const rollup = await createStoreTelemetry(runtimeStore).query({ tenantId }, { limit: 10_000 });
    const cost = deriveCostUsd(rollup, loadModelPrices());
    // W1-A — tier-mix (docs/design/cost-margin-telemetry.md §4): surfaced ONLY when at least one recorded
    // event actually carried a ModelTier. Nothing wires a real tier yet (the model gateway that would pick
    // one is design-only), so today this key is absent on every tenant — honest, not a fabricated 0/0 mix.
    const tierMix =
      rollup.byTier && Object.keys(rollup.byTier).length > 0
        ? { byTier: rollup.byTier, totalTieredEvents: Object.values(rollup.byTier).reduce((n, t) => n + t.events, 0) }
        : undefined;
    return {
      tenantId,
      rollup,
      cost,
      ...(tierMix ? { tierMix } : {}),
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
    // Revenue-flywheel W3-2 — gate stage: attach the incumbent champion's LIVE measured-outcome baseline
    // (over the W2-A/B outcome ledger, tenant PROMOTE_TENANT) before evaluate()/gate() reads it. Cheap
    // KV reads (unlike the live grading below), so this stays awaited unconditionally in both modes. A
    // brand-new candidate's own measuredOutcome stays absent — the gate falls back to the proxy for it.
    engine.setChampionMeasuredOutcome(toGateMeasuredOutcome(await readServingMeasuredOutcome(runtimeStore, PROMOTE_TENANT)));
    // Status flips to "evaluating" synchronously. In live mode grading (~15–30s: live Gemini + Opus
    // judge) runs in the background and the dashboard picks up the result by polling; in mock mode it's
    // instant, so we await it (keeps the CI E2E deterministic).
    const p = engine.evaluate(id).catch((e) => console.error(`[eval ${id}]`, (e as Error).message));
    if (mode !== "live") await p;
    return state();
  });
  // The approver of record is the AUTHENTICATED operator, not the literal string "operator". This is the
  // name bound into the immutable audit and compared by the two-person rule at promotion, so it must come
  // from the credential that was actually presented.
  app.post("/api/approve/:id", async (req) => act(async () => { await assertRuntimeNotKilled(); engine.approve((req.params as { id: string }).id, await actingOperator(req)); }));
  app.post("/api/reject/:id", async (req) => act(() => engine.reject((req.params as { id: string }).id, "operator")));
  app.post("/api/promote/:id", async (req) =>
    act(async () => {
      await assertRuntimeNotKilled();
      // T4g — write the DURABLE serving slot (was in-memory engine.promote ONLY, which never reached
      // shoppers). promoteToServing verifies the human approval, fails closed on the shared kill registry,
      // persists CHAMPION/active (put + audit atomically), THEN advances the engine — the human path made
      // end-to-end, and what makes the orchestrator's route-to-human actionable.
      // Supply the promoter identity ONLY when the rule is satisfiable (>= 2 configured operators);
      // otherwise every id is "operator" and the check would refuse every promotion.
      await promoteToServing(engine, (req.params as { id: string }).id, runtimeStore, PROMOTE_TENANT, undefined, {
        promotedBy: twoPersonPromote ? await actingOperator(req) : undefined,
      });
    }),
  );
  // --- The HUMAN lane's staging surface (CLAUDE.md §3 NN#2: shadow → canary before any promotion) ---
  //
  // These exist because `promoteToServing` now REQUIRES both stage markers. Without them the human lane
  // would have no lawful path at all — the stage machine was previously reachable only from the dormant
  // auto lane, so enforcing it without adding these would have "closed" the hole by permanently breaking
  // the only promotion route an operator can drive. Fixing a governance gap by disabling the feature is
  // not a fix.
  //
  // HONEST LIMITATION, and it is a real one: the numbers below are OPERATOR-SUPPLIED, not measured by
  // this service. The machinery that actually measures shadow/canary against live traffic lives in the
  // auto-optimize orchestrator, which is dormant and not deployed. So these routes record an ATTESTATION
  // that a stage was run, attributable and audited — not proof that it was. That is strictly better than
  // no stage at all (which is what shipped before) and strictly worse than measured staging. It is the
  // same posture /api/monitor already has. Wire these to real measurement before enabling auto-optimize.
  //
  // THRESHOLDS ARE SERVER-SIDE, deliberately: they are the SAME constants the auto lane uses
  // (DEFAULT_CANARY_POWER, and auto-optimize.ts's shadow bounds). If the request body could set them, an
  // operator could pass maxRegression: 999 and "pass" any stage — which would reintroduce the hole in a
  // form that looks compliant in the audit log.
  const HUMAN_SHADOW_BOUNDS = { maxRegression: 0.05, maxImprovement: 0.5 } as const;
  app.post("/api/stage/:id", async (req) =>
    act(async () => {
      await assertRuntimeNotKilled();
      engine.beginStaging((req.params as { id: string }).id);
    }),
  );
  app.post("/api/stage/:id/shadow", async (req) =>
    act(async () => {
      await assertRuntimeNotKilled();
      const b = (req.body ?? {}) as { n?: number; delta?: number };
      engine.recordShadow(
        (req.params as { id: string }).id,
        { n: Number(b.n), delta: Number(b.delta), at: new Date().toISOString() },
        HUMAN_SHADOW_BOUNDS,
      );
    }),
  );
  app.post("/api/stage/:id/canary", async (req) =>
    act(async () => {
      await assertRuntimeNotKilled();
      const b = (req.body ?? {}) as { n?: number; delta?: number; elapsedMs?: number };
      engine.recordCanary(
        (req.params as { id: string }).id,
        { n: Number(b.n), delta: Number(b.delta), elapsedMs: Number(b.elapsedMs), at: new Date().toISOString() },
        DEFAULT_CANARY_POWER,
      );
    }),
  );

  // BUILD-TIME plane kill: halts candidate approvals/promotions in the evolution pipeline.
  app.post("/api/kill", async () => act(() => engine.kill("operator")));
  app.post("/api/unkill", async () => act(() => engine.unkill()));

  // RUN-TIME plane kill (governance NN #4): halts the LIVE shopper agent for a scope (global / one
  // tenant / one agent-type), via the SHARED RuntimeStatePort so it propagates to every serving
  // instance (prod: both this plane and the backend point at the same Cloud SQL via DATABASE_URL).
  // Distinct from /api/kill above — this stops the product, not the promotion pipeline. Arm/disarm is
  // audited on the immutable log inside the store.
  app.get("/api/runtime-kill", async (req, reply) => {
    if (!(await requireOperatorRead(req, reply))) return;
    return { scopes: await killStatus(runtimeStore) };
  });
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
  // §8a inv 14 — the cost circuit-breaker's operator surface. Separate from the kill routes above
  // BECAUSE THE TWO MEAN DIFFERENT THINGS: a kill halts the agent and hands the shopper to a person; a
  // cost cap puts it in BASIC MODE — no proactive initiation, live chat still answered, and the merchant's
  // billing state never shown to the shopper. Overloading one flag with both would break the middle
  // clause. These are the routes the registry's audit `reversalPath` names, so the reversal an immutable
  // record promises is one an operator can actually run (NN#5 — the same discipline PR #166 applied after
  // finding the kill switch's reversalPath pointing at an undeployed route).
  app.get("/api/cost-cap", async (req, reply) => {
    if (!(await requireOperatorRead(req, reply))) return;
    return { scopes: await costCapStatus(runtimeStore) };
  });
  app.post("/api/cost-cap", async (req) => {
    const b = (req.body ?? {}) as { scope?: CostCapScope; reason?: string };
    // Default `global` matches /api/runtime-kill's default: the platform-wide COGS cap is the one an
    // operator reaches for in an incident, and it is the SAFE direction (it only removes autonomy).
    await setCostCap(runtimeStore, b.scope ?? "global", b.reason ?? "cost cap reached", undefined, "operator");
    return { scopes: await costCapStatus(runtimeStore) };
  });
  app.post("/api/cost-cap/clear", async (req) => {
    const b = (req.body ?? {}) as { scope?: CostCapScope };
    // Clearing RESTORES autonomy, so it is attributed to `operator` in the audit rather than to the
    // breaker — a machine may apply a cap, only a person lifts one.
    await clearCostCap(runtimeStore, b.scope);
    return { scopes: await costCapStatus(runtimeStore) };
  });
  app.post("/api/monitor", async (req) => {
    const b = (req.body ?? {}) as { qualityScore?: number; safetyPass?: boolean };
    // Was `engine.monitor(...)` — IN-MEMORY ONLY. On a detected regression it reverted this process's
    // champion and left the DURABLE serving champion untouched, so shoppers kept getting the regressing
    // policy while this dashboard reported a successful rollback. `monitorServing` reverts the store
    // first (and freezes the auto-promote fast-lane), then advances the engine; on a healthy observation
    // it records the serving champion as the durable known-good baseline, which is what makes a
    // beyond-depth-1 delayed rollback possible at all.
    //
    // Revenue-flywheel W3-2 — monitor stage: read the serving champion's LIVE measured lift for the
    // current period (over the same W2-A/B outcome ledger) and pass it as `observed.measuredOutcome` so
    // a MEASURED regression can trigger rollback even when the caller-attested qualityScore looks
    // healthy (`regressionVerdict`'s "measured-outcome-regression" verdict). Dark-safe: with no ledger
    // activity yet the read is the honest zero (underpowered), which `regressionVerdict` already treats
    // as a no-op fallback to `qualityScore` — byte-identical to today.
    return act(async () => {
      const measuredOutcome = toGateMeasuredOutcome(await readServingMeasuredOutcome(runtimeStore, PROMOTE_TENANT));
      await monitorServing(engine, runtimeStore, PROMOTE_TENANT, {
        qualityScore: Number(b.qualityScore ?? 0.4),
        safetyPass: b.safetyPass !== false,
        measuredOutcome,
      });
    });
  });

  // --- Real self-improvement loop: the durable improvement timeline + an interactive live round. ---
  const store = new FileStore(".palup-state");
  let evolving = false;

  app.get("/api/timeline", async (req, reply) => {
    if (!(await requireOperatorRead(req, reply))) return;
    return {
      timeline: await store.readLog("improvement-timeline"),
      champion: await store.read("champion"),
      scenarios: SCENARIOS.length,
      evolving,
    };
  });

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
  // leaves GET open, so this route self-authenticates `operator:read` via the shared `requireOperatorRead`
  // defined above (mirrors /api/telemetry / /api/state / /api/timeline), else an anonymous caller could
  // read ANY merchant's canary data via ?tenantId=<victim>. The POST paths (start/stop/shadow) are already
  // operator:mutate-gated by the onRequest hook and stay platform-operator-scoped (the shared
  // OPERATOR_TOKEN — no per-tenant authz yet; acceptable while this is the PalUp operator/admin plane, NOT
  // merchant-facing).
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
  // ADR-0014 prereq #6 — SET the PLATFORM-MASTER auto-promote override (force-human whenever off,
  // regardless of any tenant's opt-in — see autoPromoteGate). Same guard chain as
  // /api/autopromote/optin above, exactly: POST ⇒ already operator:mutate-gated by the onRequest hook;
  // ON TOP of that this requires a real STEP-UP assertion bound to THIS action
  // (PLATFORM_STEPUP_ACTION = "autopromote.platform.set") + the reserved platform tenant, single-use,
  // and audited. The actor passed to setPlatformAutoPromote is ALWAYS the string "operator" — the
  // server-authenticated principal, never anything client-supplied in the body — so this surface can
  // never be used to record an agent as the setter; setPlatformAutoPromote's own assertHumanActor is
  // the backstop even if that changed. This ONLY exposes the already-guarded setter; it does not flip
  // anything itself, and today nothing calls it — enabling the platform switch stays a deliberate,
  // separately-audited operator action (docs/MEMORY-GO-LIVE-CHECKLIST.md-style human step).
  app.post("/api/autopromote/platform", async (req, reply) => {
    const b = (req.body ?? {}) as { enabled?: unknown };
    const hdr = req.headers["x-stepup-assertion"];
    const stepUpToken = typeof hdr === "string" ? hdr : undefined;
    try {
      await setPlatformAutoPromote(runtimeStore, b.enabled === true, {
        actor: "operator", // the authenticated operator principal (shared-token model → "operator")
        stepUpToken,
        stepUpSecret: process.env.AUTOPROMOTE_STEPUP_SECRET,
      });
      return { ok: true, enabled: b.enabled === true };
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
  // Deploy-prep (W1-B): a Cloud Run deploy needs to bind 0.0.0.0 to accept traffic; the default stays the
  // safe loopback-only posture (dev/CI never accidentally expose the dashboard), so an operator must opt
  // in explicitly via HOST rather than the code silently widening its own bind address.
  const host = process.env.HOST ?? "127.0.0.1";
  buildServer()
    .then((app) => app.listen({ port, host }))
    .then(() => console.log(`control plane on http://${host}:${Number(process.env.PORT ?? 8990)}  (mode=${process.env.CP_MODE === "live" ? "live" : "mock"})`))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
