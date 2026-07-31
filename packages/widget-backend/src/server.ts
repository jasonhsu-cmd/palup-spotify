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
import { DEFAULT_POLICY, normalizeHistory } from "@palup/widget-brain";
import type { RuntimeStatePort, ModelPort, VectorPort } from "@palup/platform-ports";
import { createWidgetTokenIdentity, mintWidgetToken, createEnvSecrets, createStoreTelemetry, createMeteringModelPort, createInMemoryVectorStore } from "@palup/platform-ports";
import { createMemoryService, createStubDistiller, isMemoryEnabled } from "@palup/widget-memory";
import { createRuntimeStore, matchedKill, RUNTIME_AGENT_TYPE } from "@palup/state-postgres";
import { createModelPort, createGroundingPort, createCommercePort } from "./model.js";
import { createRuntimeSessionStore } from "./session-store.js";
import { deriveServingSignals } from "./signals.js";
import { buildAuditInput } from "./audit.js";
import { allowRequest, clientIpKey, underLimit } from "./rate-limit.js";
import { assignCanary, logTraffic } from "./canary.js";

// Run-time agent identity for the operator Kill Switch. Single-tenant demo for now; when real
// multi-tenancy lands, thread the AUTHENTICATED tenant (from the widget embed key, never the shopper)
// through here and into the brain's tenantId. RUNTIME_AGENT_TYPE ("shopper") is imported from
// @palup/state-postgres so the serving path and the evolution PROMOTION path check the SAME agent-type
// against the kill registry (NN #4) — a single source of truth, no drift.
const RUNTIME_TENANT = "demo";

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
// Widget tenant identity (T2/T3): the tenant is derived from a verified widget token. WIDGET_AUTH_REQUIRED
// gates ENFORCEMENT — off during rollout (unauthenticated requests fall back to RUNTIME_TENANT); flip on
// once the widget mints+sends a token and the signing secret is provisioned, retiring the fallback.
// Publishable embed-key → merchantId registry (the key ships in the storefront snippet). JSON via env;
// defaults to the demo tenant. NOT a secret — it only names which merchant a widget belongs to.
function parseEmbedKeys(): Record<string, string> {
  const map: Record<string, string> = Object.create(null); // null proto: no __proto__/constructor keys
  const raw = process.env.WIDGET_EMBED_KEYS;
  if (raw) {
    try {
      const o = JSON.parse(raw);
      if (o && typeof o === "object") {
        for (const [k, v] of Object.entries(o)) if (typeof v === "string" && v) map[k] = v; // values must be non-empty strings
      }
    } catch {
      console.warn("[config] WIDGET_EMBED_KEYS is not valid JSON — using the demo default");
    }
  }
  if (Object.keys(map).length === 0) map["demo-embed-key"] = "demo";
  return map;
}
const IDEM_TTL_SECONDS = posInt("IDEM_TTL_SECONDS", 86_400); // 24h
// 48h sliding (reset each turn): this is conversation-scoped CONTROL state (safety latch / open issues
// / pitch budget), not customer memory — it shouldn't outlive a conversation. Cross-visit shopper
// memory is a separate, consent-gated, identified-customer subsystem with its own retention policy.
const SESSION_TTL_SECONDS = posInt("SESSION_TTL_SECONDS", 172_800);
const TRAFFIC_KEEP_LAST = posInt("TRAFFIC_KEEP_LAST", 5_000);
// Telemetry is higher-volume (≥2 events/turn) but each row is tiny; keep a larger window. NOTE: once
// trimmed, telemetry rollups are a ROLLING WINDOW, not a lifetime ledger — the cost read surface must
// treat cumulative $ accordingly (ADR-0013 / slice-1 review F-5).
const TELEMETRY_KEEP_LAST = posInt("TELEMETRY_KEEP_LAST", 20_000);
const RECLAIM_EVERY = posInt("RECLAIM_EVERY", 500);
let reqCount = 0;

const here = dirname(fileURLToPath(import.meta.url));
const widgetHtml = readFileSync(
  join(here, "..", "..", "widget", "public", "index.html"),
  "utf8",
);

const { port: modelPort, name: modelName } = createModelPort();
const commerce = createCommercePort();

export async function buildServer(opts?: {
  store?: RuntimeStatePort;
  modelPort?: ModelPort;
  /** ADR-0015 T12 test seam (mirrors `store`/`modelPort`): lets a test inject a spy VectorPort to prove
   * the memory subsystem is never touched while the double gate (isMemoryEnabled) is off. Prod always
   * uses the dev in-memory adapter below — a real vector-DB adapter is a later, separately-gated swap. */
  vectorPort?: VectorPort;
}) {
  // The shared run-time state store (Cloud SQL in prod via DATABASE_URL, in-memory locally). Tests can
  // inject a store so they can arm an operator kill on the SAME instance the request path reads.
  const store = opts?.store ?? (await createRuntimeStore()).store;
  // Per-merchant grounding needs the store (cache) + secrets (Shopify creds), so it is built here (not
  // module-level). Construct secrets in the composition root after config load (per the slice-2 review).
  const secrets = createEnvSecrets();
  const grounding = createGroundingPort(store, secrets);
  // M3 — telemetry (cost/latency measurement). The metering decorator wraps the model port so every
  // model call's tokens + latency are recorded under the request tenant; fail-open, so it can never
  // break serving. Built here because the store-backed telemetry adapter needs the store.
  const telemetry = createStoreTelemetry(store);
  // Test seam (mirrors the injectable `store`): a test may inject a spy model port to observe the
  // threaded message context. Prod always uses the module-level, redaction-wrapped adapter (model.ts).
  const activeModelPort = opts?.modelPort ?? modelPort;
  const meteredModel = createMeteringModelPort(activeModelPort, telemetry, { agentType: RUNTIME_AGENT_TYPE });
  // ADR-0015 T12 — cross-visit memory, wired ONLY behind the double gate (flag.ts: MEMORY_ADR_ACCEPTED is
  // hardcoded false, so `isMemoryEnabled()` is false today regardless of any env var — NN#1: no
  // config-only flip). When off (always, in this PR), the MemoryService is never even constructed, so
  // nothing here — including an injected test-seam vector port — is ever touched: the composition root
  // (this file) MAY import @palup/widget-memory (the brain itself never does — no dep cycle). The dev
  // in-memory vector adapter (or an injected spy) stands in for a real vector-DB adapter later; the
  // runtime store's own audit surface is reused as-is (no new audit mechanism).
  const memoryService = isMemoryEnabled()
    ? createMemoryService({
        vector: opts?.vectorPort ?? createInMemoryVectorStore(),
        audit: store,
        distiller: createStubDistiller(),
      })
    : undefined;
  const memoryPort = memoryService
    ? {
        recall: (ctx: { tenantId: string; anonId: string }) =>
          memoryService.recall({
            tenantId: ctx.tenantId,
            anonId: ctx.anonId,
            // Consent tiers are enforced at WRITE time in the memory service (decideMemoryWrite); recall
            // itself never consults them (service.ts) — these are structural placeholders to satisfy
            // MemoryCtx's shape, not a live consent decision.
            consent1: "unknown",
            consent2: "unknown",
          }),
      }
    : undefined;
  // One brain per active policy (champion + any canary), built lazily and cached by policy id. The
  // brain is tenant-agnostic (grounding tenant rides each request via signals.tenantId); this cache is
  // per-server-instance.
  const brains = new Map<string, ReturnType<typeof createBrain>>();
  const brainFor = (policy: Policy) => {
    let b = brains.get(policy.id);
    if (!b) {
      b = createBrain(meteredModel, grounding, policy, commerce, "shopper-demo", memoryPort);
      brains.set(policy.id, b);
    }
    return b;
  };
  brainFor(DEFAULT_POLICY); // champion
  // Widget-identity config (read per boot so a test / deploy can configure it).
  const WIDGET_TOKEN_SECRET = process.env.WIDGET_TOKEN_SECRET;
  const WIDGET_TOKEN_TTL_SECONDS = posInt("WIDGET_TOKEN_TTL_SECONDS", 3_600);
  const WIDGET_AUTH_REQUIRED = process.env.WIDGET_AUTH_REQUIRED === "true";
  const EMBED_KEYS = parseEmbedKeys();
  const widgetIdentity = createWidgetTokenIdentity(WIDGET_TOKEN_SECRET);
  // T7 — server-derived trust-bearing signals. These govern behavior/residency/competitor-mode, so they
  // come from merchant/server config, never the shopper. Single-tenant defaults for now; when real
  // multi-tenancy lands (post flag-flip) these are looked up per-merchant by tenantId. `region` should
  // become geo-derived from the request; the conservative default here is the initial US market.
  const MERCHANT_REGION: NonNullable<Signals["region"]> = (() => {
    const r = process.env.MERCHANT_REGION;
    return r === "us" || r === "eu" || r === "uk" || r === "other" ? r : "us";
  })();
  const MERCHANT_GROUNDING_MODE: NonNullable<Signals["groundingMode"]> = (() => {
    const g = process.env.MERCHANT_GROUNDING_MODE;
    return g === "off" || g === "general" || g === "full" ? g : "full";
  })();
  const app = Fastify({ logger: false });

  app.get("/health", async () => ({ ok: true, model: modelName }));

  app.get("/", async (_req, reply) => {
    reply.type("text/html").send(widgetHtml);
  });

  // Mint a short-TTL widget token for a valid publishable embed key. The storefront snippet calls this
  // once, then sends the token on /chat. The tenant is bound here from the SERVER-side registry (never
  // from a client-claimed value). 401 for an unknown key or if signing isn't configured.
  app.get("/widget/token", async (req, reply) => {
    // Rate-limit the (unauthenticated, public-embed-key) mint endpoint per IP so it can't be abused
    // for unbounded HMAC/DoS. Bucketed under a reserved mint tenant.
    const xff = req.headers["x-forwarded-for"];
    const ipKey = clientIpKey(Array.isArray(xff) ? xff[0] : xff, req.ip);
    try {
      if (!(await underLimit(store, { tenantId: "__mint__" }, `ip:${ipKey}`, RL_IP, RL_WINDOW))) {
        reply.code(429);
        return { error: "rate limited" };
      }
    } catch {
      /* fail-open: minting is cheap and the /chat model path is separately capped */
    }
    const key = (req.query as { key?: string })?.key;
    const merchantId = typeof key === "string" ? EMBED_KEYS[key] : undefined;
    if (typeof merchantId !== "string" || !WIDGET_TOKEN_SECRET) {
      reply.code(401);
      return { error: "invalid or unconfigured embed key" };
    }
    return { token: mintWidgetToken(WIDGET_TOKEN_SECRET, merchantId, WIDGET_TOKEN_TTL_SECONDS), expiresInSeconds: WIDGET_TOKEN_TTL_SECONDS };
  });

  app.post("/chat", async (req, reply) => {
    const body = (req.body ?? {}) as {
      message?: string;
      signals?: Signals;
      sessionId?: string;
      idempotencyKey?: string;
      widgetToken?: string;
      /** Client's bounded recent transcript for in-session memory (server-validated; never persisted). */
      history?: unknown;
    };
    const sessionId = String(body.sessionId ?? "anon");
    const message = String(body.message ?? "");
    const idemKey = typeof body.idempotencyKey === "string" && body.idempotencyKey ? body.idempotencyKey : undefined;

    // T5 — input bounds: reject oversized input before any work (bounds the model + the KV keys).
    if (message.length > MAX_MESSAGE_CHARS || sessionId.length > MAX_ID_CHARS || (idemKey && idemKey.length > MAX_ID_CHARS)) {
      reply.code(400);
      return { reply: "Sorry — that message is too long. Could you shorten it?", mode: "support", pitch: "none", escalate: false, flags: ["input_rejected"] };
    }

    // T3 — TENANT IDENTITY: derive the merchant/tenant from a VERIFIED widget token (Authorization:
    // Bearer, or a body field). The tenant comes from signed claims, never a client-supplied value.
    // During rollout (WIDGET_AUTH_REQUIRED off) an unauthenticated request falls back to the default
    // tenant; once enforced, no token ⇒ 401 and the fallback is retired.
    const authHeader = req.headers["authorization"];
    const widgetToken =
      typeof authHeader === "string" && authHeader.startsWith("Bearer ")
        ? authHeader.slice(7)
        : typeof body.widgetToken === "string"
          ? body.widgetToken
          : undefined;
    const principal = await widgetIdentity.authenticate(widgetToken);
    if (principal.kind !== "merchant" && WIDGET_AUTH_REQUIRED) {
      reply.code(401);
      return { reply: "This assistant needs to be opened from the store page.", mode: "support", pitch: "none", escalate: false, flags: ["unauthenticated"] };
    }
    const tenantId = principal.kind === "merchant" ? principal.merchantId : RUNTIME_TENANT;
    const serving = { tenantId };
    // Per-conversation state, durable + scoped to THIS tenant.
    const sessions = createRuntimeSessionStore(store, tenantId);

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

      // TRUST BOUNDARY (T7 + NN #4): the shopper's `signals` are UNTRUSTED. Rather than spread client
      // input and delete known-bad fields, we RECONSTRUCT signals from trusted sources — the safe default
      // is that a field the shopper sends is ignored unless it is explicitly non-trust-bearing context.
      //   • mood / cart  — shopper/UI context; accepted only if a valid enum value (from the storefront in prod).
      //   • relationship — grants VIP/subscriber treatment ⇒ SERVER-derived. Anonymous until an identified
      //     customer + history exist (M2 customer identity), never client-claimed.
      //   • consent      — legally load-bearing (TCPA/CAN-SPAM, gates outbound) ⇒ conservative default
      //     (unknown = no consent); a real consent store is a later, identified-customer subsystem.
      //   • groundingMode/region — merchant policy + data-residency ⇒ server config, not the shopper.
      //   • proactivityLevel — an autonomy lever ⇒ omitted so the brain uses the merchant policy default.
      //   • openIssues / safetyLatched — sourced ONLY from persisted session state, never client-injected.
      //   • kill — armed state comes from the operator registry (server); the shopper can neither arm nor bypass it.
      const kill = await matchedKill(store, { tenantId, agentType: RUNTIME_AGENT_TYPE });
      const signals: Signals = deriveServingSignals(body.signals, { tenantId, kill: Boolean(kill), region: MERCHANT_REGION, groundingMode: MERCHANT_GROUNDING_MODE });

      // Canary split: a sticky fraction of THIS tenant's sessions is served by that tenant's canary
      // policy; the rest by champion. Keyed by the server-derived tenantId, so one merchant's canary can
      // never bucket another merchant's shoppers (ADR-0014 blast-radius fix).
      const canary = await assignCanary(store, tenantId, sessionId);
      const policy = canary ? canary.policy : DEFAULT_POLICY;
      // autoPersist:false — we persist the advanced session state ourselves, atomically with the audit.
      const session = await createSession(brainFor(policy), { sessionId, store: sessions, autoPersist: false });
      const turnStart = Date.now();
      // In-session multi-turn memory: thread the CLIENT's bounded recent transcript into the model
      // context so a follow-up ("what about the other one?") has its antecedent. It is validated + bounded
      // here (count + total chars; oversize is truncated, never rejected), redacted at the model port like
      // any user turn, and NEVER stored server-side — SessionState stays control-only.
      const history = normalizeHistory(body.history);
      const d = await session.send(message, signals, history);
      // M3 — per-turn telemetry enrichment: the business dimensions (mode/pitch/servedBy/escalate) and
      // end-to-end turn latency the model-port decorator can't see. PII-free (no message/reply). Under
      // the server-derived tenant; fail-open like logTraffic.
      void telemetry
        .record(serving, { kind: "turn", agentType: RUNTIME_AGENT_TYPE, servedBy: policy.id, mode: d.mode, pitch: d.pitch, escalate: d.escalateToHuman, latencyMs: Date.now() - turnStart })
        .catch(() => {});
      // T9 — logTraffic is the choke point that redacts message/reply and hashes sessionId at the
      // write boundary (see canary.ts), so no raw shopper PII lands in the shadow-grading log at rest.
      await logTraffic(store, tenantId, { servedBy: policy.id, sessionId, message, reply: d.reply, mode: d.mode, escalate: d.escalateToHuman, killScope: kill?.scope });
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
      if (auditRec) console.log(`AUDIT_ANCHOR ${JSON.stringify({ t: tenantId, seq: auditRec.seq, hash: auditRec.hash, at: auditRec.at })}`);
      // Opportunistic reclamation (F3/F4): bound idem/session growth + traffic retention. Fire-and-forget
      // so it never delays or fails the response.
      if (++reqCount % RECLAIM_EVERY === 0) {
        void store.sweepExpired().catch(() => {});
        void store.trimStream(serving, "traffic", TRAFFIC_KEEP_LAST).catch(() => {});
        void store.trimStream(serving, "telemetry", TELEMETRY_KEEP_LAST).catch(() => {}); // F-4: bound growth

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
