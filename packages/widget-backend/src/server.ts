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
import { buildAuditInput } from "./audit.js";
import { allowRequest, clientIpKey } from "./rate-limit.js";
import { assignCanary, logTraffic } from "./canary.js";

// Run-time agent identity for the operator Kill Switch. Single-tenant demo for now; when real
// multi-tenancy lands, thread the AUTHENTICATED tenant (from the widget embed key, never the shopper)
// through here and into the brain's tenantId.
const RUNTIME_TENANT = "demo";
const RUNTIME_AGENT_TYPE = "shopper";

// Reclamation bounds (F3/F4): TTLs cap growth of the client-keyed idem/session KV; traffic is trimmed.
// Reclamation runs opportunistically every N requests (Cloud Run throttles CPU between requests, so a
// setInterval is unreliable — request-driven is the safe trigger). All overridable via env.
// Validate each knob: a typo / empty value must NOT silently become 0 (a 0 TTL would expire state
// instantly → lost latch/budget) or NaN (a NaN modulo would disable reclamation). Reject non-positive
// / non-finite and fall back to the documented default with a warning.
function posInt(name: string, def: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return def;
  const v = Number(raw);
  if (!Number.isFinite(v) || v <= 0) {
    console.warn(`[config] ${name}=${JSON.stringify(raw)} is not a positive number — using default ${def}`);
    return def;
  }
  return v;
}
// Input bounds (T5) — reject oversized inputs before any work.
const MAX_MESSAGE_CHARS = posInt("MAX_MESSAGE_CHARS", 4_000);
const MAX_ID_CHARS = posInt("MAX_ID_CHARS", 200); // sessionId / idempotencyKey
// Rate limits (T6) — fixed-window, env-tunable; token-bucket-ish caps to stop denial-of-wallet.
const RL_SESSION = posInt("RL_SESSION_PER_MIN", 30); // ~1 turn / 2s per conversation
const RL_IP = posInt("RL_IP_PER_MIN", 60);
const RL_TENANT = posInt("RL_TENANT_PER_MIN", 2_000); // per-tenant ceiling (≈5× expected)
const RL_WINDOW = posInt("RL_WINDOW_SECONDS", 60);
const IDEM_TTL_SECONDS = posInt("IDEM_TTL_SECONDS", 86_400); // 24h
// 48h sliding (reset each turn): this is conversation-scoped CONTROL state (safety latch / open issues
// / pitch budget), not customer memory — it shouldn't outlive a conversation. Cross-visit shopper
// memory is a separate, consent-gated, identified-customer subsystem with its own retention policy.
const SESSION_TTL_SECONDS = posInt("SESSION_TTL_SECONDS", 172_800);
const TRAFFIC_KEEP_LAST = posInt("TRAFFIC_KEEP_LAST", 5_000);
const RECLAIM_EVERY = posInt("RECLAIM_EVERY", 500);
let reqCount = 0;

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

    // T5 — input bounds: reject oversized input before any work (bounds the model + the KV keys).
    if (message.length > MAX_MESSAGE_CHARS || sessionId.length > MAX_ID_CHARS || (idemKey && idemKey.length > MAX_ID_CHARS)) {
      reply.code(400);
      return { reply: "Sorry — that message is too long. Could you shorten it?", mode: "support", pitch: "none", escalate: false, flags: ["input_rejected"] };
    }

    // T6 — rate limit (denial-of-wallet): per-session / per-IP / per-tenant, atomic windowed counters on
    // the shared store. IP key is bounded/validated (an oversized X-Forwarded-For can't force a store
    // error). Buckets evaluated independently; the per-tenant ceiling fails-CLOSED (see rate-limit.ts).
    const xff = req.headers["x-forwarded-for"];
    const ipKey = clientIpKey(Array.isArray(xff) ? xff[0] : xff, req.ip);
    const allowed = await allowRequest(store, serving, {
      sessionId,
      ip: ipKey,
      sessionLimit: RL_SESSION,
      ipLimit: RL_IP,
      tenantLimit: RL_TENANT,
      windowSeconds: RL_WINDOW,
    });
    if (!allowed) {
      reply.code(429);
      return { reply: "You're sending messages a little too fast — give me a moment and try again.", mode: "support", pitch: "none", escalate: false, flags: ["rate_limited"] };
    }

    try {
      // IDEMPOTENCY: a client retry (e.g. the widget's offline-retry replaying the same turn) must NOT
      // re-process — that would double-count the governed pitch budget, double-audit, and re-open
      // issues. If we've already answered this key, return the SAME response and do nothing else.
      // Unambiguous composite key so ("a","b:c") and ("a:b","c") can't collide onto the same cache row.
      const idemStoreKey = idemKey ? JSON.stringify([sessionId, idemKey]) : undefined;
      if (idemStoreKey) {
        const cached = await store.get<Record<string, unknown>>(serving, "idem", idemStoreKey);
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
      // autoPersist:false — we persist the advanced session state ourselves, atomically with the audit.
      const session = await createSession(brainFor(policy), { sessionId, store: sessions, autoPersist: false });
      const d = await session.send(message, signals);
      await logTraffic(store, { servedBy: policy.id, sessionId, message, reply: d.reply, mode: d.mode, escalate: d.escalateToHuman, killScope: kill?.scope });
      // F11 (NN #5): commit the advanced session state AND its governance-audit record in ONE tx, so
      // the governed state (pitch budget / safety latch) can never advance without its audit on a
      // mid-turn store failure. Both live under the serving tenant. "session" matches session-store.ts.
      const auditEntry = buildAuditInput({ sessionId, messageLength: message.length, servedBy: policy.id, decision: d, killScope: kill?.scope });
      let auditRec: { seq: number; hash: string; at: string } | null = null;
      await store.tx(serving, async (t) => {
        await t.put("session", sessionId, session.state, { ttlSeconds: SESSION_TTL_SECONDS });
        if (auditEntry) auditRec = await t.audit(auditEntry);
      });
      // External audit-chain anchor (#19 head-anchor): emit the chain head to stdout → Cloud Logging
      // captures it immutably, OUTSIDE the DB's mutable surface. Reconciling these anchors against
      // rs_audit later detects tail-truncation / full re-hash that the in-DB chain alone can't (a
      // compromised DBA has no write path to Cloud Logging). PII-safe (seq + hash only).
      if (auditRec) console.log(`AUDIT_ANCHOR ${JSON.stringify({ t: RUNTIME_TENANT, seq: auditRec.seq, hash: auditRec.hash, at: auditRec.at })}`);
      // Opportunistic reclamation (F3/F4): bound idem/session growth + traffic retention. Fire-and-forget
      // so it never delays or fails the response.
      if (++reqCount % RECLAIM_EVERY === 0) {
        void store.sweepExpired().catch(() => {});
        void store.trimStream(serving, "traffic", TRAFFIC_KEEP_LAST).catch(() => {});
      }
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
      if (idemStoreKey) await store.put(serving, "idem", idemStoreKey, response, { ttlSeconds: IDEM_TTL_SECONDS });
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
