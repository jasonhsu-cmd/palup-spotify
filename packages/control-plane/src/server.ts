import Fastify from "fastify";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { DEFAULT_POLICY } from "@palup/widget-brain";
import { EvolutionEngine, MockGrader, seedCandidates, type Grader, type PolicyMetrics } from "@palup/evolution";
import { isVertexConfigured } from "@palup/model-vertex";
import { isAnthropicApiConfigured } from "@palup/judge";
import { LiveGrader } from "./live-grader.js";

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

  const app = Fastify({ logger: false });
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
  app.post("/api/kill", async () => act(() => engine.kill("operator")));
  app.post("/api/unkill", async () => act(() => engine.unkill()));
  app.post("/api/monitor", async (req) => {
    const b = (req.body ?? {}) as { qualityScore?: number; safetyPass?: boolean };
    return act(() => engine.monitor({ qualityScore: Number(b.qualityScore ?? 0.4), safetyPass: b.safetyPass !== false }));
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
