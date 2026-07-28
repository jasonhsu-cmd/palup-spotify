import Fastify from "fastify";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import {
  createBrain,
  createSession,
  createMemorySessionStore,
  type Policy,
  type Signals,
} from "@palup/widget-brain";
import { DEFAULT_POLICY } from "@palup/widget-brain";
import { createModelPort, createGroundingPort, createCommercePort } from "./model.js";
import { assignCanary, logTraffic } from "./canary.js";
import { matchedKill } from "./kill-switch.js";

// Run-time agent identity for the operator Kill Switch. Single-tenant demo for now; when real
// multi-tenancy lands, thread the AUTHENTICATED tenant (from the widget embed key, never the shopper)
// through here and into the brain's tenantId.
const RUNTIME_TENANT = "demo";
const RUNTIME_AGENT_TYPE = "shopper";

const here = dirname(fileURLToPath(import.meta.url));
const widgetHtml = readFileSync(
  join(here, "..", "..", "widget", "public", "index.html"),
  "utf8",
);

const { port: modelPort, name: modelName } = createModelPort();
const grounding = createGroundingPort();
const commerce = createCommercePort();
// One brain per active policy (champion + any canary), built lazily and cached by policy id.
const brains = new Map<string, ReturnType<typeof createBrain>>();
function brainFor(policy: Policy) {
  let b = brains.get(policy.id);
  if (!b) {
    b = createBrain(modelPort, grounding, policy, commerce, "shopper-demo");
    brains.set(policy.id, b);
  }
  return b;
}
brainFor(DEFAULT_POLICY); // champion
// Per-conversation state (latch / open-issues / pitch budget) persists here keyed by sessionId.
const sessions = createMemorySessionStore();

export function buildServer() {
  const app = Fastify({ logger: false });

  app.get("/health", async () => ({ ok: true, model: modelName }));

  app.get("/", async (_req, reply) => {
    reply.type("text/html").send(widgetHtml);
  });

  app.post("/chat", async (req, reply) => {
    const body = (req.body ?? {}) as { message?: string; signals?: Signals; sessionId?: string };
    const sessionId = String(body.sessionId ?? "anon");
    const message = String(body.message ?? "");
    try {
      // TRUST BOUNDARY (governance NN #4): the shopper's browser must NOT be able to arm OR bypass the
      // operator Kill Switch. Strip any client-supplied `kill` and source the armed state server-side
      // from the operator registry. An operator halt thus takes effect for this session regardless of
      // what the shopper's request contains.
      const clientSignals: Signals = { ...(body.signals ?? {}) };
      delete clientSignals.kill;
      const kill = matchedKill({ tenantId: RUNTIME_TENANT, agentType: RUNTIME_AGENT_TYPE });
      const signals: Signals = kill ? { ...clientSignals, kill: true } : clientSignals;

      // Canary split: a sticky fraction of sessions is served by the canary policy; the rest by champion.
      const canary = assignCanary(sessionId);
      const policy = canary ? canary.policy : DEFAULT_POLICY;
      const session = createSession(brainFor(policy), { sessionId, store: sessions });
      const d = await session.send(message, signals);
      logTraffic({ servedBy: policy.id, sessionId, message, reply: d.reply, mode: d.mode, escalate: d.escalateToHuman, killScope: kill?.scope });
      // Only the shopper-safe fields leave the server (no system prompt, no raw signals echo).
      return {
        reply: d.reply,
        mode: d.mode,
        pitch: d.pitch,
        escalate: d.escalateToHuman,
        outbound: d.outbound,
        flags: d.flags,
        servedBy: policy.id,
      };
    } catch (e) {
      // A model/config failure must degrade gracefully — never hang or leak internals to the shopper.
      console.error(`[/chat] model error (${modelName}):`, (e as Error).message);
      reply.code(200);
      return {
        reply:
          "Sorry — I'm having trouble right now. Let me get a team member to help; please try again in a moment.",
        mode: "support",
        pitch: "none",
        escalate: true,
        flags: ["model_error"],
      };
    }
  });

  return app;
}

// Listen only when run directly (not when imported by a test).
const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (invoked === import.meta.url) {
  const port = Number(process.env.PORT ?? 8787);
  // Cloud Run requires binding 0.0.0.0:$PORT (its health check hits the container over the network);
  // locally we keep 127.0.0.1. The container sets HOST=0.0.0.0 (see Dockerfile).
  const host = process.env.HOST ?? "127.0.0.1";
  buildServer()
    .listen({ port, host })
    .then(() => console.log(`widget backend listening on http://${host}:${port}`))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
