import Fastify from "fastify";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import {
  createBrain,
  createSession,
  type Policy,
  type Signals,
} from "@palup/widget-brain";
import { DEFAULT_POLICY } from "@palup/widget-brain";
import type { RuntimeStatePort } from "@palup/platform-ports";
import { createRuntimeStore, matchedKill } from "@palup/state-postgres";
import { createModelPort, createGroundingPort, createCommercePort } from "./model.js";
import { createRuntimeSessionStore } from "./session-store.js";
import { auditDecision } from "./audit.js";
import { assignCanary, logTraffic } from "./canary.js";

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

export async function buildServer(opts?: { store?: RuntimeStatePort }) {
  // The shared run-time state store (Cloud SQL in prod via DATABASE_URL, in-memory locally). Tests can
  // inject a store so they can arm an operator kill on the SAME instance the request path reads.
  const store = opts?.store ?? (await createRuntimeStore()).store;
  // Per-conversation state (latch / open-issues / pitch budget), durable + tenant-scoped on that store.
  const sessions = createRuntimeSessionStore(store, RUNTIME_TENANT);
  const app = Fastify({ logger: false });

  app.get("/health", async () => ({ ok: true, model: modelName }));

  app.get("/", async (_req, reply) => {
    reply.type("text/html").send(widgetHtml);
  });

  app.post("/chat", async (req, reply) => {
    const body = (req.body ?? {}) as {
      message?: string;
      signals?: Signals;
      sessionId?: string;
      idempotencyKey?: string;
    };
    const sessionId = String(body.sessionId ?? "anon");
    const message = String(body.message ?? "");
    const idemKey = typeof body.idempotencyKey === "string" && body.idempotencyKey ? body.idempotencyKey : undefined;
    const serving = { tenantId: RUNTIME_TENANT };
    try {
      // IDEMPOTENCY: a client retry (e.g. the widget's offline-retry replaying the same turn) must NOT
      // re-process — that would double-count the governed pitch budget, double-audit, and re-open
      // issues. If we've already answered this key, return the SAME response and do nothing else.
      if (idemKey) {
        const cached = await store.get<Record<string, unknown>>(serving, "idem", `${sessionId}:${idemKey}`);
        if (cached) return cached;
      }

      // TRUST BOUNDARY (governance NN #4): the shopper's browser must NOT be able to arm OR bypass the
      // operator Kill Switch. Strip any client-supplied `kill` and source the armed state server-side
      // from the operator registry. An operator halt thus takes effect for this session regardless of
      // what the shopper's request contains.
      const clientSignals: Signals = { ...(body.signals ?? {}) };
      delete clientSignals.kill;
      const kill = await matchedKill(store, { tenantId: RUNTIME_TENANT, agentType: RUNTIME_AGENT_TYPE });
      const signals: Signals = kill ? { ...clientSignals, kill: true } : clientSignals;

      // Canary split: a sticky fraction of sessions is served by the canary policy; the rest by champion.
      const canary = await assignCanary(store, sessionId);
      const policy = canary ? canary.policy : DEFAULT_POLICY;
      const session = await createSession(brainFor(policy), { sessionId, store: sessions });
      const d = await session.send(message, signals);
      await logTraffic(store, { servedBy: policy.id, sessionId, message, reply: d.reply, mode: d.mode, escalate: d.escalateToHuman, killScope: kill?.scope });
      // Immutable audit of a governance-relevant autonomous decision (NN #5), PII-safe (no raw message).
      await auditDecision(store, RUNTIME_TENANT, {
        sessionId,
        messageLength: message.length,
        servedBy: policy.id,
        decision: d,
        killScope: kill?.scope,
      });
      // Only the shopper-safe fields leave the server (no system prompt, no raw signals echo).
      const response = {
        reply: d.reply,
        mode: d.mode,
        pitch: d.pitch,
        escalate: d.escalateToHuman,
        outbound: d.outbound,
        flags: d.flags,
        servedBy: policy.id,
      };
      if (idemKey) await store.put(serving, "idem", `${sessionId}:${idemKey}`, response);
      return response;
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
    .then((app) => app.listen({ port, host }))
    .then(() => console.log(`widget backend listening on http://${host}:${port}`))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
