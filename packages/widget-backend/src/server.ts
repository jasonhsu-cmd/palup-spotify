import Fastify from "fastify";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import {
  createBrain,
  createSession,
  type Policy,
  type Signals,
  type Consent,
} from "@palup/widget-brain";
import { DEFAULT_POLICY, normalizeHistory } from "@palup/widget-brain";
import type { RuntimeStatePort, ModelPort, VectorPort, Principal } from "@palup/platform-ports";
import {
  createWidgetTokenIdentity,
  mintWidgetToken,
  createShopperTokenIdentity,
  mintShopperToken,
  shopperIdTenant,
  createEnvSecrets,
  createStoreTelemetry,
  createMeteringModelPort,
  createRedactingModelPort,
} from "@palup/platform-ports";
import { createMemoryService, isMemoryEnabled, validateAnonId, eraseSubject, classifyFact } from "@palup/widget-memory";
import { createRuntimeStore, createVectorStore, matchedKill, RUNTIME_AGENT_TYPE, recordConsent, lookupConsent, type Sql } from "@palup/state-postgres";
import { createModelPort, createGroundingPort, createCommercePort } from "./model.js";
import { createRuntimeSessionStore } from "./session-store.js";
import { deriveServingSignals } from "./signals.js";
import { buildAuditInput, buildIdentityAuditInput, buildCaaGrantAuditInput, buildCaaRevokeAuditInput } from "./audit.js";
import { allowRequest, clientIpKey, underLimit } from "./rate-limit.js";
import { assignCanary, logTraffic } from "./canary.js";
import { readActiveChampion } from "./champion.js";
import { guardCommercePort, withRequestPrincipal } from "./commerce-guard.js";
import { verifyShopifyAppProxyShopper, normalizeAppProxyQuery } from "./shopify-shopper-identity.js";
import { createCustomerGrantStore } from "./customer-grant-store.js";
import { logoutGrant } from "./refreshing-grant-store.js";
import {
  startCustomerLogin,
  completeCustomerCallback,
  redeemHandoff,
  CAA_CLIENT_ID_NAME,
  CAA_CLIENT_SECRET_NAME,
  type CallbackResult,
} from "./customer-account-flow.js";
import { parseStoreDomains } from "./merchant-store.js";

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
// ADR-0017 T7 — every commerce call goes through the ADR-0016 fail-closed guard. `commerceIsLive` is a
// capability marker from the composition root (model.ts): false for MockCommerceAdapter, so the guard
// is a tested no-op today; a future live adapter sets it true and every read/write below automatically
// requires a verified shopper principal (bound per-request via withRequestPrincipal in the /chat handler).
const { port: rawCommerce, isLive: commerceIsLive } = createCommercePort();
const commerce = guardCommercePort(rawCommerce, commerceIsLive);

// ADR-0018 task 5 — the callback landing page. Hands the one-time code to the widget via an
// exact-origin postMessage (never the token, never "*"), then closes. The payload is base64url/enum only
// (no injection surface); `<` is still escaped defensively before embedding in the inline script.
function caaCallbackHtml(res: CallbackResult, widgetOrigin: string): string {
  const esc = (s: string) => s.replace(/</g, "\\u003c");
  const payload = esc(res.ok ? JSON.stringify({ type: "palup:caa", ok: true, handoffCode: res.handoffCode }) : JSON.stringify({ type: "palup:caa", ok: false, reason: res.reason }));
  const msg = res.ok ? "You're signed in — you can return to the chat." : res.reason === "cancelled" ? "Sign-in cancelled. You can keep browsing." : "Sign-in didn't complete. Please try again.";
  const origin = esc(JSON.stringify(widgetOrigin));
  return `<!doctype html><meta charset="utf-8"><title>PalUp</title><body style="font-family:system-ui;padding:24px;color:#111"><p>${msg}</p><script>
    try { if (window.opener && ${origin}) window.opener.postMessage(${payload}, ${origin}); } catch (e) {}
    setTimeout(function(){ try { window.close(); } catch (e) {} }, 300);
  </script></body>`;
}

export async function buildServer(opts?: {
  store?: RuntimeStatePort;
  modelPort?: ModelPort;
  /** ADR-0015 T12 test seam (mirrors `store`/`modelPort`): lets a test inject a spy VectorPort to prove
   * the memory subsystem is never touched while the double gate (isMemoryEnabled) is off. Prod always
   * uses the dev in-memory adapter below — a real vector-DB adapter is a later, separately-gated swap. */
  vectorPort?: VectorPort;
  /** ADR-0018 test seam: inject the outbound fetch used by the CAA OAuth routes (discovery/token/JWKS)
   * so route tests never hit the network. Prod uses the global fetch. */
  caaFetch?: typeof globalThis.fetch;
  /**
   * PR-8 test seam — mirrors `createMemoryService`'s own `enabled` override (service.ts), and is
   * subject to the EXACT SAME safeguard: honored ONLY under a real test runner (VITEST=true /
   * NODE_ENV=test). Lets a test force the memory service to actually be constructed + live so the
   * /chat -> remember()/recall() wiring can be exercised ahead of the MEMORY_ADR_ACCEPTED flip. In
   * production (no test runner) this is IGNORED — isMemoryEnabled() (the hardcoded double gate) is
   * authoritative regardless, so no caller can flip memory on via config/injection alone (NN#1).
   */
  memoryEnabled?: boolean;
}) {
  // The shared run-time state store (Cloud SQL in prod via DATABASE_URL, in-memory locally). Tests can
  // inject a store so they can arm an operator kill on the SAME instance the request path reads. When a
  // test injects `opts.store`, `createRuntimeStore()` is never called at all (same as before this PR) —
  // `runtimeResult.sql` then stays `undefined`, so `createVectorStore` below falls back to building its
  // OWN pool if DATABASE_URL happens to be set, exactly as it would with no runtime store at all.
  const runtimeResult = opts?.store
    ? { store: opts.store, kind: "injected", sql: undefined as Sql | undefined }
    : await createRuntimeStore();
  const store = runtimeResult.store;
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
  // config-only flip). When off (always in real production), the MemoryService is never even
  // constructed, so nothing in the remember()/recall() PATH — including an injected test-seam vector
  // port — is ever touched: the composition root (this file) MAY import @palup/widget-memory (the brain
  // itself never does — no dep cycle). The dev in-memory vector adapter (or an injected spy) stands in
  // for a real vector-DB adapter later; the runtime store's own audit surface is reused as-is (no new
  // audit mechanism).
  //
  // PR-8 (opts.memoryEnabled test seam): honored ONLY under a real test runner — see its own doc comment
  // above — so this can NEVER flip memory on in production; `isMemoryEnabled()` alone gates construction
  // there, byte-identical to before this PR.
  //
  // PR-11b: `vectorPort` is now constructed UNCONDITIONALLY (hoisted out of the `memoryServiceEnabled`
  // ternary below) so the new POST /forget data-rights endpoint has somewhere to erase from regardless of
  // the double gate's current state — a shopper's right to erase what may have been stored does not
  // depend on the feature being live right now (a killed/rolled-back feature can still have prior data
  // sitting in the store). This is the ONE deliberate exception to "nothing here is touched while off":
  // /forget calls `eraseSubject` directly against this port; every OTHER consumer (recall/remember, via
  // `memoryService`/`memoryPort` below) remains strictly gated on `memoryServiceEnabled` exactly as
  // before.
  //
  // Durable, portable VectorPort adapter (ADR-0001 `vector` port; ADR-0015 durable cross-visit memory):
  // `createVectorStore()` mirrors `createRuntimeStore()`'s own env-driven selection — a real, durable
  // Postgres-backed store when DATABASE_URL is set (so cross-visit memory survives a restart and is
  // shared across Cloud Run instances, and a POST /forget erasure is REAL — ADR-0015 Inv 5), else the
  // same in-memory dev adapter as before. `runtimeResult.sql` is threaded through so the Postgres branch
  // reuses the SAME pool the runtime store already opened (security review, HIGH — a second, unshared
  // `pg.Pool` here would double per-process connections against a shared-core Cloud SQL tier and risk
  // starving the pool /chat's kill-switch read depends on). Constructing it when memory is off is
  // NOT a no-op (that prior claim was inaccurate): the Postgres branch still runs its own idempotent
  // `CREATE TABLE IF NOT EXISTS`/index DDL — the same class of startup-only migration `store` above
  // already runs unconditionally, sharing its pool rather than opening a second one — nothing here ever
  // calls upsert/query on this port except /forget (see above), which is the part that genuinely stays
  // gated on memoryServiceEnabled.
  const vectorResult = opts?.vectorPort
    ? { store: opts.vectorPort, kind: "injected" }
    : await createVectorStore(runtimeResult.sql);
  const vectorPort = vectorResult.store;
  // Surfaces which adapter is actually live for BOTH stores (security review, MEDIUM — "no operator/log
  // line reveals which adapter is live"); also exposed on GET /health below.
  console.log(`[boot] runtime store=${runtimeResult.kind} vector store=${vectorResult.kind}`);
  const underTestRunner = process.env.VITEST === "true" || process.env.NODE_ENV === "test";
  const memoryServiceEnabled = underTestRunner ? (opts?.memoryEnabled ?? isMemoryEnabled()) : isMemoryEnabled();
  const memoryService = memoryServiceEnabled
    ? createMemoryService({
        vector: vectorPort,
        audit: store,
        // PR-8 / PR-6 Finding H: the distiller sends the RAW shopper turn to the model — wrap it with the
        // SAME PII-redaction guardrail every other model call gets (createRedactingModelPort) so a
        // pasted card/SSN never reaches the provider, on top of (not instead of) sanitizeFact's separate
        // redaction of the OUTPUT candidate text. Wrapped explicitly here rather than relying on
        // `meteredModel` happening to already be redaction-wrapped upstream (it is, via module-level
        // `modelPort`, in real production — but NOT when a test injects `opts.modelPort` directly), so
        // this holds regardless of how the underlying model port was constructed. Double-wrapping (when
        // `meteredModel` IS already wrapped) is harmless — `redactPII` is idempotent on already-redacted
        // text.
        model: createRedactingModelPort(meteredModel),
        enabled: memoryServiceEnabled,
        // ADR-0015 Inv 9 (go-live blocker #2) — encryption-at-rest for special-category facts. Reuses
        // the SAME composition-root `secrets` port already constructed above (Shopify creds, CAA client
        // id/secret) rather than a second SecretsPort instance; a tenant's memory-encryption key is
        // provisioned into PALUP_SECRETS exactly like any other tenant secret. Still fully inert while
        // `memoryServiceEnabled` is false (MEMORY_ADR_ACCEPTED) — this dependency is never even
        // constructed-into-use until that double gate is on.
        secrets,
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
  // ADR-0016 enactment — the subscription skip/pause self-serve posture flag. Default OFF ⇒ byte-
  // identical to today (skip/pause always human-routed); read here (not hardcoded) and threaded into
  // every brain exactly like every other posture flag (WIDGET_AUTH_REQUIRED/SHOPPER_AUTH below). The
  // brain/support.ts layer independently re-requires a server-VERIFIED shopper before ever auto-executing
  // — this flag alone can never grant autonomy to an anonymous shopper.
  const SUBSCRIPTION_SELFSERVE = process.env.SUBSCRIPTION_SELFSERVE === "true";
  // One brain per active policy (champion + any canary), built lazily and cached by policy id. The
  // brain is tenant-agnostic (grounding tenant rides each request via signals.tenantId); this cache is
  // per-server-instance.
  // Keyed by (tenantId, policy.id): champion/candidate policy ids are non-tenant-scoped constants
  // (e.g. "prop-0"), so a global policy.id key would serve tenant A's cached brain (its styleDirective/
  // proactivity) to tenant B whenever both promote a same-id/different-content policy. The composite key
  // keeps each tenant's champion AND canary brains isolated (blast-radius; matches the per-tenant champion
  // store keying).
  const brains = new Map<string, ReturnType<typeof createBrain>>();
  const brainFor = (tenantId: string, policy: Policy) => {
    const key = `${tenantId}::${policy.id}`;
    let b = brains.get(key);
    if (!b) {
      b = createBrain(meteredModel, grounding, policy, commerce, "shopper-demo", memoryPort, SUBSCRIPTION_SELFSERVE);
      brains.set(key, b);
    }
    return b;
  };
  brainFor(RUNTIME_TENANT, DEFAULT_POLICY); // prewarm the default-tenant champion
  // Widget-identity config (read per boot so a test / deploy can configure it).
  const WIDGET_TOKEN_SECRET = process.env.WIDGET_TOKEN_SECRET;
  const WIDGET_TOKEN_TTL_SECONDS = posInt("WIDGET_TOKEN_TTL_SECONDS", 3_600);
  const WIDGET_AUTH_REQUIRED = process.env.WIDGET_AUTH_REQUIRED === "true";
  const EMBED_KEYS = parseEmbedKeys();
  const widgetIdentity = createWidgetTokenIdentity(WIDGET_TOKEN_SECRET);
  // ADR-0017 — shopper identity, default OFF ⇒ byte-identical to today (every shopper stays anonymous).
  // F4 (startup precondition): SHOPPER_AUTH is only ever HONORED when WIDGET_AUTH_REQUIRED is ALSO on —
  // it needs a VERIFIED widget tenant to cross-check the shopper's tenant against (F1); under the
  // unauthenticated RUNTIME_TENANT fallback that check would be vacuous. Misconfiguration (flag on,
  // precondition unmet) degrades to "shoppers are anonymous", never to an unchecked cross-tenant bypass.
  const SHOPPER_AUTH_FLAG = process.env.SHOPPER_AUTH === "true";
  if (SHOPPER_AUTH_FLAG && !WIDGET_AUTH_REQUIRED) {
    console.warn("[config] SHOPPER_AUTH=true requires WIDGET_AUTH_REQUIRED=true (ADR-0017 F4) — shoppers will be treated as anonymous until both are set.");
  }
  const SHOPPER_AUTH_ENABLED = SHOPPER_AUTH_FLAG && WIDGET_AUTH_REQUIRED;
  // ADR-0016 — SUBSCRIPTION_SELFSERVE has no effect at all unless shoppers can actually BE verified
  // (SHOPPER_AUTH_ENABLED); without it `signals.shopperId` is never set, so support.ts's own
  // shopperVerified gate is always false and skip/pause stays human-routed regardless of this flag. This
  // is a safe (never security-relevant) degrade — warn, don't hard-gate like SHOPPER_AUTH_ENABLED's F4.
  if (SUBSCRIPTION_SELFSERVE && !SHOPPER_AUTH_ENABLED) {
    console.warn("[config] SUBSCRIPTION_SELFSERVE=true has no effect without SHOPPER_AUTH enabled (ADR-0016 prereq #1) — every shopper is unverified, so skip/pause stays human-routed.");
  }
  const SHOPPER_TOKEN_SECRET = process.env.SHOPPER_TOKEN_SECRET;
  const SHOPPER_TOKEN_TTL_SECONDS = posInt("SHOPPER_TOKEN_TTL_SECONDS", 3_600);
  const shopperIdentity = createShopperTokenIdentity(SHOPPER_TOKEN_SECRET);
  // Keyed-HMAC key for the T8 identity-resolution audit ref (F7 — never a bare hash). A verified shopper
  // principal can only reach /chat after /shopper/session minted a token with SHOPPER_TOKEN_SECRET, so
  // that secret is guaranteed configured whenever this key is actually used; AUDIT_HMAC_SECRET is an
  // optional, separately-provisionable override so the audit ref key needn't literally equal the token-
  // signing key (defense-in-depth key separation), while still needing nothing extra to provision today.
  const AUDIT_HMAC_SECRET = process.env.AUDIT_HMAC_SECRET || SHOPPER_TOKEN_SECRET;
  // T7 — server-derived trust-bearing signals. These govern behavior/residency/competitor-mode, so they
  // come from merchant/server config, never the shopper. Single-tenant defaults for now; when real
  // multi-tenancy lands (post flag-flip) these are looked up per-merchant by tenantId. `region` should
  // become geo-derived from the request; the conservative default here is the initial US market.
  const MERCHANT_REGION: NonNullable<Signals["region"]> = (() => {
    const r = process.env.MERCHANT_REGION;
    return r === "us" || r === "eu" || r === "uk" || r === "other" ? r : "us";
  })();
  // PR-11b — read-only client-facing memory state, returned on every /chat response so the (still fully
  // inert-by-default) widget can learn it and gate its own anonId-minting/consent-UX ONLY off the real
  // server state — never guessed client-side. `memoryEnabled` mirrors the SAME double-gated
  // `memoryServiceEnabled` computed above (false in real production — the double gate, flag.ts).
  // `consentMode` mirrors ADR-0015's region split: the US gets an opt-out NOTICE (memory defaults on,
  // shopper may decline); every other region gets an opt-in PROMPT (memory defaults off, shopper must
  // accept). Both are static per boot (no per-request cost).
  const CONSENT_MODE: "opt_in" | "opt_out" = MERCHANT_REGION === "us" ? "opt_out" : "opt_in";
  const MERCHANT_GROUNDING_MODE: NonNullable<Signals["groundingMode"]> = (() => {
    const g = process.env.MERCHANT_GROUNDING_MODE;
    return g === "off" || g === "general" || g === "full" ? g : "full";
  })();
  // ADR-0018 — Customer Account API OAuth (shopper sign-in that yields a token to read their own orders/
  // subscriptions). Gated by the SAME SHOPPER_AUTH_ENABLED posture (so it's inert exactly when App-Proxy
  // identity is) PLUS a configured redirect_uri PLUS a shopper-token secret to mint. Per-shop client creds
  // (per-shop client model, ADR-0018 spike) come from the tenant-scoped SecretsPort. When off ⇒ 404 (inert).
  const CAA_REDIRECT_URI = process.env.CAA_REDIRECT_URI;
  const CAA_SCOPE = process.env.CAA_SCOPE || "openid email customer-account-api:full";
  const CAA_ENABLED = SHOPPER_AUTH_ENABLED && typeof CAA_REDIRECT_URI === "string" && CAA_REDIRECT_URI.length > 0 && typeof SHOPPER_TOKEN_SECRET === "string" && SHOPPER_TOKEN_SECRET.length > 0;
  const caaFetch = opts?.caaFetch ?? globalThis.fetch;
  const grantStore = createCustomerGrantStore(store, secrets);
  // Exact-origin target for the callback→widget handoff postMessage (never "*"). The widget iframe is
  // served by THIS backend, so its origin equals the redirect_uri's origin.
  const CAA_WIDGET_ORIGIN = (() => {
    try {
      return CAA_REDIRECT_URI ? new URL(CAA_REDIRECT_URI).origin : "";
    } catch {
      return "";
    }
  })();
  const nowSec = () => Math.floor(Date.now() / 1000);
  // NN#4 — no new credential custody may begin/accrue for a halted tenant/agent (mirrors the /chat gate).
  const caaKillCheck = async (tenant: string): Promise<boolean> => (await matchedKill(store, { tenantId: tenant, agentType: RUNTIME_AGENT_TYPE })) !== null;

  const app = Fastify({ logger: false });

  // `store`/`vector` surface which adapter is actually live (security review, MEDIUM — same rationale as
  // the [boot] log line above): "postgres" in every real deploy (DATABASE_URL set), "memory" only in
  // local/dev/test, "injected" only under a test that supplies its own store/vectorPort.
  app.get("/health", async () => ({ ok: true, model: modelName, store: runtimeResult.kind, vector: vectorResult.kind }));

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

  // ADR-0017 T2/T4 — mint a shopper session token from a verified Shopify App-Proxy request. Reached via
  // the store's App Proxy, so `req.query` carries the App-Proxy-signed params (shop, timestamp,
  // logged_in_customer_id, signature, ...). The widget's OWN token (Authorization: Bearer) establishes
  // WHICH merchant tenant this request is for — the App-Proxy `shop` MUST cross-check against THAT
  // verified tenant (step 5), never a client-claimed one. Off (SHOPPER_AUTH not honored, F4) ⇒ 404, so
  // the feature is fully inert rather than partially reachable.
  app.get("/shopper/session", async (req, reply) => {
    if (!SHOPPER_AUTH_ENABLED) {
      reply.code(404);
      return { error: "not found" };
    }
    // Rate-limit the mint endpoint per IP (mirrors /widget/token) so a holder of one valid widget token
    // can't hammer it for unbounded HMAC/mint work. Bucketed under the reserved mint tenant.
    const rlXff = req.headers["x-forwarded-for"];
    const rlIpKey = clientIpKey(Array.isArray(rlXff) ? rlXff[0] : rlXff, req.ip);
    try {
      if (!(await underLimit(store, { tenantId: "__mint__" }, `ip:${rlIpKey}`, RL_IP, RL_WINDOW))) {
        reply.code(429);
        return { error: "rate limited" };
      }
    } catch {
      /* fail-open: minting is cheap and the /chat model path is separately capped */
    }
    const authHeader = req.headers["authorization"];
    const widgetToken = typeof authHeader === "string" && authHeader.startsWith("Bearer ") ? authHeader.slice(7) : undefined;
    const merchantPrincipal = await widgetIdentity.authenticate(widgetToken);
    if (merchantPrincipal.kind !== "merchant") {
      reply.code(401);
      return { error: "unauthenticated" };
    }
    if (!SHOPPER_TOKEN_SECRET) {
      reply.code(500);
      return { error: "shopper auth not configured" };
    }
    // shop-domain -> tenant reverse lookup (the forward map, tenant -> domain, is the same registry
    // model.ts's grounding router already reuses for Storefront creds — see merchant-store.ts).
    const domains = parseStoreDomains();
    const reverseDomains: Record<string, string> = Object.create(null); // null-proto: no __proto__ pollution
    for (const [tenant, domain] of Object.entries(domains)) if (domain) reverseDomains[domain] = tenant;
    // Preserve repeated-key arrays (Shopify signs them comma-joined) so a legitimately-signed request
    // isn't rejected; non-string junk is dropped. Semantic fields are still single-value-guarded downstream.
    const params = normalizeAppProxyQuery(req.query as Record<string, unknown>);
    const principal = await verifyShopifyAppProxyShopper(params, {
      expectedTenant: merchantPrincipal.merchantId,
      resolveTenant: (shop) => (Object.hasOwn(reverseDomains, shop) ? reverseDomains[shop] : undefined),
      secrets,
    });
    if (principal.kind !== "shopper") return { shopper: null }; // browsing, not logged in — not an error
    const token = mintShopperToken(SHOPPER_TOKEN_SECRET, principal.shopperId, principal.source, SHOPPER_TOKEN_TTL_SECONDS);
    return { token, expiresInSeconds: SHOPPER_TOKEN_TTL_SECONDS };
  });

  // ADR-0018 task 4 — begin CAA OAuth. Authenticates the widget token to establish the merchant tenant
  // (like /shopper/session), then 302s to the shop's authorize URL. 404 when the feature is off (inert).
  app.get("/auth/customer/login", async (req, reply) => {
    if (!CAA_ENABLED) {
      reply.code(404);
      return { error: "not found" };
    }
    const xff = req.headers["x-forwarded-for"];
    const ipKey = clientIpKey(Array.isArray(xff) ? xff[0] : xff, req.ip);
    try {
      if (!(await underLimit(store, { tenantId: "__mint__" }, `ip:${ipKey}`, RL_IP, RL_WINDOW))) {
        reply.code(429);
        return { error: "rate limited" };
      }
    } catch {
      /* fail-open: minting is cheap and the token exchange is separately bounded */
    }
    // Establish the merchant tenant. A window.open navigation (the widget sign-in, task 10) can't set an
    // Authorization header, so accept the publishable embed key via ?key= (resolved through EMBED_KEYS,
    // exactly like /widget/token) OR a Bearer widget token (fetch callers). The embed key is publishable
    // and only NAMES the tenant — the OAuth state/PKCE + the shop's own auth protect the flow.
    const keyParam = (req.query as { key?: string })?.key;
    let tenant: string | undefined;
    if (typeof keyParam === "string" && Object.hasOwn(EMBED_KEYS, keyParam)) {
      tenant = EMBED_KEYS[keyParam];
    } else {
      const authHeader = req.headers["authorization"];
      const widgetToken = typeof authHeader === "string" && authHeader.startsWith("Bearer ") ? authHeader.slice(7) : undefined;
      const merchantPrincipal = await widgetIdentity.authenticate(widgetToken);
      if (merchantPrincipal.kind === "merchant") tenant = merchantPrincipal.merchantId;
    }
    if (!tenant) {
      reply.code(401);
      return { error: "unauthenticated" };
    }
    const domains = parseStoreDomains();
    const shopDomain = Object.hasOwn(domains, tenant) ? domains[tenant] : undefined;
    if (!shopDomain) {
      reply.code(404);
      return { error: "not found" }; // no store mapped for this tenant
    }
    const r = await startCustomerLogin(
      { store, fetchFn: caaFetch, clientIdFor: (t) => secrets.get(t, CAA_CLIENT_ID_NAME), killCheck: caaKillCheck, redirectUri: CAA_REDIRECT_URI!, scope: CAA_SCOPE, now: nowSec },
      { tenant, shopDomain },
    );
    if (!r) {
      reply.code(404);
      return { error: "not found" }; // no CAA client provisioned, or discovery failed — fail closed
    }
    reply.header("location", r.authorizeUrl).code(302).send();
  });

  // ADR-0018 task 5 — the OAuth callback (a top-level Shopify redirect: only code/state/error, NO widget
  // Bearer). Returns an HTML page that hands the one-time code to the widget; never the token in the URL.
  app.get("/auth/customer/callback", async (req, reply) => {
    if (!CAA_ENABLED) {
      reply.code(404);
      return { error: "not found" };
    }
    const xff = req.headers["x-forwarded-for"];
    const ipKey = clientIpKey(Array.isArray(xff) ? xff[0] : xff, req.ip);
    try {
      if (!(await underLimit(store, { tenantId: "__mint__" }, `ip:${ipKey}`, RL_IP, RL_WINDOW))) {
        reply.code(429);
        return { error: "rate limited" };
      }
    } catch {
      /* fail-open */
    }
    const q = req.query as { code?: unknown; state?: unknown; error?: unknown };
    const res = await completeCustomerCallback(
      {
        store,
        fetchFn: caaFetch,
        grants: grantStore,
        clientIdFor: (t) => secrets.get(t, CAA_CLIENT_ID_NAME),
        clientSecretFor: (t) => secrets.get(t, CAA_CLIENT_SECRET_NAME),
        killCheck: caaKillCheck,
        redirectUri: CAA_REDIRECT_URI!,
        shopperTokenSecret: SHOPPER_TOKEN_SECRET!,
        shopperTokenTtlSeconds: SHOPPER_TOKEN_TTL_SECONDS,
        now: nowSec,
        audit: async (e) => {
          await store.audit({ tenantId: e.tenant }, buildCaaGrantAuditInput({ shopperId: e.shopperId, source: "shopify", tenantId: e.tenant, hmacKey: AUDIT_HMAC_SECRET ?? "", scope: e.scope }));
        },
      },
      {
        code: typeof q.code === "string" ? q.code : undefined,
        state: typeof q.state === "string" ? q.state : undefined,
        error: typeof q.error === "string" ? q.error : undefined,
      },
    );
    reply.type("text/html");
    return caaCallbackHtml(res, CAA_WIDGET_ORIGIN);
  });

  // ADR-0018 task 5 — redeem the one-time handoff code for the minted shopper session token.
  app.post("/auth/customer/handoff", async (req, reply) => {
    if (!CAA_ENABLED) {
      reply.code(404);
      return { error: "not found" };
    }
    // Rate-limit the redeem too (mirrors /shopper/session) — the code is already unguessable + single-use +
    // 120s, but this bounds brute-force attempts under the reserved mint tenant.
    const xff = req.headers["x-forwarded-for"];
    const ipKey = clientIpKey(Array.isArray(xff) ? xff[0] : xff, req.ip);
    try {
      if (!(await underLimit(store, { tenantId: "__mint__" }, `ip:${ipKey}`, RL_IP, RL_WINDOW))) {
        reply.code(429);
        return { error: "rate limited" };
      }
    } catch {
      /* fail-open */
    }
    const body = (req.body ?? {}) as { code?: unknown };
    const token = await redeemHandoff(store, typeof body.code === "string" ? body.code : "");
    if (!token) {
      reply.code(404);
      return { token: null };
    }
    return { token, expiresInSeconds: SHOPPER_TOKEN_TTL_SECONDS };
  });

  // ADR-0018 task 7 — logout: DELETE the shopper's stored OAuth grant (local-first; there is no Shopify
  // token-revocation endpoint — the browser end_session flow is the widget's concern, task 10). The
  // shopper identifies themselves with their shopper session token; the grant to delete is derived from
  // its verified namespaced shopperId, never a client-supplied tenant/id.
  app.post("/auth/customer/logout", async (req, reply) => {
    if (!CAA_ENABLED) {
      reply.code(404);
      return { error: "not found" };
    }
    const xff = req.headers["x-forwarded-for"];
    const ipKey = clientIpKey(Array.isArray(xff) ? xff[0] : xff, req.ip);
    try {
      if (!(await underLimit(store, { tenantId: "__mint__" }, `ip:${ipKey}`, RL_IP, RL_WINDOW))) {
        reply.code(429);
        return { error: "rate limited" };
      }
    } catch {
      /* fail-open */
    }
    const hdr = req.headers["x-shopper-token"];
    const body = (req.body ?? {}) as { shopperToken?: unknown };
    const shopperToken = typeof hdr === "string" ? hdr : typeof body.shopperToken === "string" ? body.shopperToken : undefined;
    const principal = await shopperIdentity.authenticate(shopperToken);
    if (principal.kind !== "shopper") {
      reply.code(401);
      return { error: "unauthenticated" };
    }
    const t = shopperIdTenant(principal.shopperId);
    if (t) {
      const { shopperId, source } = principal;
      await logoutGrant(grantStore, t, shopperId, async () => {
        await store.audit({ tenantId: t }, buildCaaRevokeAuditInput({ shopperId, source, tenantId: t, hmacKey: AUDIT_HMAC_SECRET ?? "" }));
      });
    }
    return { ok: true };
  });

  // PR-11a (ADR-0015 T12) — the server-side consent-record CAPTURE point: the future in-chat consent-UX
  // PR (PR-11) calls this to record the shopper's OWN memory-consent choice for THEIR OWN subject. The
  // (tenantId, anonId) pair is derived the EXACT same server-trusted way `/chat` derives it — tenantId
  // from the verified widget token (falling back to RUNTIME_TENANT during the same rollout window /chat
  // uses), NEVER a client-supplied tenant; anonId must pass the SAME `validateAnonId` charset/length
  // bound `/chat`'s `signals.anonId` does, so a shopper can only ever record consent for a well-formed
  // subject key they hold — never an arbitrary/forged one. `recordConsent` (runtime-consent-store.ts)
  // audits the write atomically inside its own transaction — no separate audit call needed here.
  app.post("/consent", async (req, reply) => {
    // Rate-limit this public (unauthenticated during the rollout window) audit-writing endpoint the SAME
    // way the mint endpoints do — per IP, under the reserved mint bucket — so it can't be flooded to grow
    // the immutable, non-trimmable audit log (denial-of-wallet / audit-flood anti-forensics). recordConsent
    // below is an atomic KV-put + audit-append; every sibling write path here is IP-capped, and /consent
    // must not regress that baseline. Fail-open on the RL check, exactly like the mint endpoints.
    const xff = req.headers["x-forwarded-for"];
    const ipKey = clientIpKey(Array.isArray(xff) ? xff[0] : xff, req.ip);
    try {
      if (!(await underLimit(store, { tenantId: "__mint__" }, `ip:${ipKey}`, RL_IP, RL_WINDOW))) {
        reply.code(429);
        return { error: "rate limited" };
      }
    } catch {
      /* fail-open: mirrors the mint endpoints; recordConsent also fails under real store distress */
    }
    const body = (req.body ?? {}) as {
      anonId?: unknown;
      memoryOrdinary?: unknown;
      memorySpecial?: unknown;
      widgetToken?: string;
    };
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
      return { error: "unauthenticated" };
    }
    const tenantId = principal.kind === "merchant" ? principal.merchantId : RUNTIME_TENANT;
    // Per-tenant ceiling — backstop against a distributed-IP flood inside one tenant. Reuses /chat's cap.
    try {
      if (!(await underLimit(store, { tenantId }, "consent", RL_TENANT, RL_WINDOW))) {
        reply.code(429);
        return { error: "rate limited" };
      }
    } catch {
      /* fail-open, as above */
    }
    // NN#4 — the operator kill switch outranks everything: while this tenant/agent is halted, refuse the
    // audited consent write (parity with the CAA routes' killCheck and /chat's kill handling). Recording
    // memory consent is a governed, audited write; the operator halt must be able to stop it too.
    if (await matchedKill(store, { tenantId, agentType: RUNTIME_AGENT_TYPE })) {
      reply.code(503);
      return { error: "paused" };
    }

    const anonId = validateAnonId(typeof body.anonId === "string" ? body.anonId : undefined);
    const isTriStateConsent = (v: unknown): v is Consent => v === "in" || v === "out" || v === "unknown";
    if (!anonId || !isTriStateConsent(body.memoryOrdinary) || !isTriStateConsent(body.memorySpecial)) {
      reply.code(400);
      return { error: "invalid anonId or consent value" };
    }

    await recordConsent(store, { tenantId, anonId, memoryOrdinary: body.memoryOrdinary, memorySpecial: body.memorySpecial });
    return { ok: true };
  });

  // PR-11b (ADR-0015 Inv 5 — right-to-erasure) — the shopper-facing data-RIGHTS endpoint: erase THIS
  // subject's durable memory via `eraseSubject` (widget-memory/src/erasure.ts, reused unchanged). The
  // (tenantId, anonId) pair is derived the EXACT same server-trusted way `/consent` derives it — tenantId
  // from the verified widget token (falling back to RUNTIME_TENANT), anonId bound by the SAME
  // `validateAnonId` charset/length check — so a shopper can only ever erase a well-formed subject key
  // they hold, never an arbitrary one or another tenant's. Guarded exactly like `/consent`: per-IP +
  // per-tenant rate limit (429) and the NN#4 operator kill switch (503).
  //
  // UNLIKE every other memory-subsystem entry point, this one runs regardless of `memoryServiceEnabled` —
  // a shopper's right to erase what may already be stored does not depend on the feature's current on/off
  // state (see `vectorPort`'s own doc comment above). It no-ops safely (still `{ ok: true }`) when there
  // is nothing to erase — which, in real production today, is EVERY call, since the double gate has never
  // let anything be written in the first place.
  app.post("/forget", async (req, reply) => {
    const xff = req.headers["x-forwarded-for"];
    const ipKey = clientIpKey(Array.isArray(xff) ? xff[0] : xff, req.ip);
    try {
      if (!(await underLimit(store, { tenantId: "__mint__" }, `ip:${ipKey}`, RL_IP, RL_WINDOW))) {
        reply.code(429);
        return { error: "rate limited" };
      }
    } catch {
      /* fail-open: mirrors /consent */
    }
    const body = (req.body ?? {}) as { anonId?: unknown; widgetToken?: string };
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
      return { error: "unauthenticated" };
    }
    const tenantId = principal.kind === "merchant" ? principal.merchantId : RUNTIME_TENANT;
    // Per-tenant ceiling — backstop against a distributed-IP flood inside one tenant (own bucket key so a
    // /forget flood can't spend down /consent's budget or vice versa).
    try {
      if (!(await underLimit(store, { tenantId }, "forget", RL_TENANT, RL_WINDOW))) {
        reply.code(429);
        return { error: "rate limited" };
      }
    } catch {
      /* fail-open, as above */
    }
    // NN#4 — the operator kill switch outranks everything: while this tenant/agent is halted, refuse the
    // audited erasure too (parity with /consent and /chat's kill handling).
    if (await matchedKill(store, { tenantId, agentType: RUNTIME_AGENT_TYPE })) {
      reply.code(503);
      return { error: "paused" };
    }

    const anonId = validateAnonId(typeof body.anonId === "string" ? body.anonId : undefined);
    if (!anonId) {
      reply.code(400);
      return { error: "invalid anonId" };
    }

    await eraseSubject({ vector: vectorPort, audit: store }, { tenantId, anonId });
    return { ok: true };
  });

  app.post("/chat", async (req, reply) => {
    const body = (req.body ?? {}) as {
      message?: string;
      signals?: Signals;
      sessionId?: string;
      idempotencyKey?: string;
      widgetToken?: string;
      /** ADR-0017 — the shopper session token minted by /shopper/session (Bearer alternative below is
       * the x-shopper-token HEADER; this body field mirrors widgetToken's dual-transport fallback). */
      shopperToken?: string;
      /** Client's bounded recent transcript for in-session memory (server-validated; never persisted). */
      history?: unknown;
    };
    const sessionId = String(body.sessionId ?? "anon");
    const message = String(body.message ?? "");
    const idemKey = typeof body.idempotencyKey === "string" && body.idempotencyKey ? body.idempotencyKey : undefined;

    // T5 — input bounds: reject oversized input before any work (bounds the model + the KV keys).
    if (message.length > MAX_MESSAGE_CHARS || sessionId.length > MAX_ID_CHARS || (idemKey && idemKey.length > MAX_ID_CHARS)) {
      reply.code(400);
      return { reply: "Sorry — that message is too long. Could you shorten it?", mode: "support", pitch: "none", escalate: false, flags: ["input_rejected"], memoryEnabled: memoryServiceEnabled, consentMode: CONSENT_MODE };
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
      return { reply: "This assistant needs to be opened from the store page.", mode: "support", pitch: "none", escalate: false, flags: ["unauthenticated"], memoryEnabled: memoryServiceEnabled, consentMode: CONSENT_MODE };
    }
    const tenantId = principal.kind === "merchant" ? principal.merchantId : RUNTIME_TENANT;
    const serving = { tenantId };
    // Per-conversation state, durable + scoped to THIS tenant.
    const sessions = createRuntimeSessionStore(store, tenantId);

    // ADR-0017 — shopper identity. A client-supplied shopperId/signals.shopperId is ALWAYS ignored (only
    // a shopper session TOKEN, verified here, can establish one). F1 /chat tenant re-binding: even a
    // validly-signed shopper token degrades to anonymous unless its embedded tenant prefix
    // (`shopify:<tenant>:…`) equals THIS request's verified widget tenant — the mint-time cross-shop
    // check (shopify-shopper-identity.ts step 5) is not enough on its own, because it only proves the
    // token was minted for SOME verified tenant, not that it's being presented on THAT tenant's session.
    let shopperPrincipal: Principal = { kind: "anonymous" };
    if (SHOPPER_AUTH_ENABLED && principal.kind === "merchant") {
      const shopperTokenHeader = req.headers["x-shopper-token"];
      const shopperToken =
        typeof shopperTokenHeader === "string"
          ? shopperTokenHeader
          : typeof body.shopperToken === "string"
            ? body.shopperToken
            : undefined;
      const resolvedShopper = await shopperIdentity.authenticate(shopperToken);
      if (resolvedShopper.kind === "shopper" && shopperIdTenant(resolvedShopper.shopperId) === tenantId) {
        shopperPrincipal = resolvedShopper;
      }
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
      return { reply: "You're sending messages a little too fast — give me a moment and try again.", mode: "support", pitch: "none", escalate: false, flags: ["rate_limited"], memoryEnabled: memoryServiceEnabled, consentMode: CONSENT_MODE };
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
      //     (unknown = no consent) for email/sms (still no CMP for those); the two MEMORY consent tiers
      //     (memoryOrdinary/memorySpecial) are now server-looked-up below (PR-11a) — still NEVER the
      //     client's own `signals.consent`.
      //   • groundingMode/region — merchant policy + data-residency ⇒ server config, not the shopper.
      //   • proactivityLevel — an autonomy lever ⇒ omitted so the brain uses the merchant policy default.
      //   • openIssues / safetyLatched — sourced ONLY from persisted session state, never client-injected.
      //   • kill — armed state comes from the operator registry (server); the shopper can neither arm nor bypass it.
      const kill = await matchedKill(store, { tenantId, agentType: RUNTIME_AGENT_TYPE });
      // PR-11a (ADR-0015 T12) — look up this subject's server-recorded memory-consent BEFORE deriving
      // signals, using the SAME validated anonId deriveServingSignals will itself derive from
      // body.signals.anonId (validateAnonId is pure/idempotent, so validating it here too is safe and
      // keeps deriveServingSignals itself unaware of any store). No valid anonId ⇒ nothing to key a
      // lookup on (mirrors the remember() "no subject key" guard below) ⇒ consentRecord stays undefined
      // ⇒ deriveServingSignals's own `ctx.consent?.… ?? "unknown"` fail-closed default applies.
      // Only reach the consent store when memory is actually live (memoryService constructed). While the
      // double gate is off, the looked-up value is consumed by NOBODY (its sole consumers — remember() and
      // the brain recall path — are gated on the same off memoryService/memoryPort), so the read is pure
      // overhead; skipping it keeps the inert /chat path byte-identical to pre-PR-11a (consentRecord stays
      // undefined ⇒ deriveServingSignals's own `ctx.consent?.… ?? "unknown"` default, i.e. the old hardcode).
      const consentAnonId =
        memoryService && typeof body.signals?.anonId === "string" ? validateAnonId(body.signals.anonId) : undefined;
      const consentRecord = consentAnonId ? await lookupConsent(store, { tenantId, anonId: consentAnonId }) : undefined;
      // PR-11c — contextual in-the-moment health-consent prompt: the deferred follow-up to PR-11b's
      // manage-panel-only UX. Ask exactly when it's relevant — THIS turn's message reveals
      // special-category info — rather than only passively via the manage panel. This is a READ-ONLY
      // PROMPT SIGNAL: it decides nothing about storage. The actual write still goes through the full
      // gated distill -> classify -> consent path unchanged (remember()/decideMemoryWrite below); this
      // flag only tells the widget "ask now". `classifyFact` is the cheap, pure keyword classifier
      // (widget-memory/src/classifier.ts, reused UNCHANGED, no policy needed — its `.class` field is
      // policy-independent) — deliberately NOT the model/distiller, so this costs nothing extra even
      // when memory is live. Fires only when ALL hold:
      //   1. memoryServiceEnabled — the double gate (flag.ts); false in real production ⇒ always absent.
      //   2. this subject's recorded memorySpecial is "unknown" — not yet decided (mirrors the
      //      deriveServingSignals fail-closed default a few lines below: no record ⇒ "unknown").
      //      Already "in" ⇒ we already have it; already "out" ⇒ they declined — never nag either way.
      //   3. classifyFact(message).class === "special" — THIS message actually reveals special-category
      //      (health/allergy/medical) information.
      // Absent (undefined) otherwise, which `JSON.stringify` (Fastify's default serializer, no route
      // schema here) drops from the wire response entirely — byte-identical to before this PR when off.
      const consentPrompt: "special" | undefined =
        memoryServiceEnabled &&
        (consentRecord?.memorySpecial ?? "unknown") === "unknown" &&
        classifyFact(message).class === "special"
          ? "special"
          : undefined;
      const signals: Signals = deriveServingSignals(body.signals, {
        tenantId,
        kill: Boolean(kill),
        region: MERCHANT_REGION,
        groundingMode: MERCHANT_GROUNDING_MODE,
        // ADR-0017 — server-verified only (never body.signals.shopperId, which deriveServingSignals never
        // reads anyway): undefined when shopperPrincipal stayed anonymous (SHOPPER_AUTH off, no/invalid
        // token, or the F1 re-binding check above failed).
        shopperId: shopperPrincipal.kind === "shopper" ? shopperPrincipal.shopperId : undefined,
        shopperVerified: shopperPrincipal.kind === "shopper" ? shopperPrincipal.verified : undefined,
        consent: consentRecord,
      });

      // Canary split: a sticky fraction of THIS tenant's sessions is served by that tenant's canary
      // policy; the rest by champion. Keyed by the server-derived tenantId, so one merchant's canary can
      // never bucket another merchant's shoppers (ADR-0014 blast-radius fix).
      const canary = await assignCanary(store, tenantId, sessionId);
      // Champion is the store-backed active champion the control plane persisted on a human-approved
      // promotion (champion.ts / control-plane champion-promoter.ts), falling back to DEFAULT_POLICY when
      // nothing has been promoted yet — this is what makes engine.promote actually reach shoppers
      // (ADR-0003 promote→serving). Canary still overrides for its sticky traffic slice.
      const champion = (await readActiveChampion(store, tenantId)) ?? DEFAULT_POLICY;
      const policy = canary ? canary.policy : champion;
      // autoPersist:false — we persist the advanced session state ourselves, atomically with the audit.
      const session = await createSession(brainFor(tenantId, policy), { sessionId, store: sessions, autoPersist: false });
      const turnStart = Date.now();
      // In-session multi-turn memory: thread the CLIENT's bounded recent transcript into the model
      // context so a follow-up ("what about the other one?") has its antecedent. It is validated + bounded
      // here (count + total chars; oversize is truncated, never rejected), redacted at the model port like
      // any user turn, and NEVER stored server-side — SessionState stays control-only.
      const history = normalizeHistory(body.history);
      // ADR-0017 T7 — bind THIS request's shopper principal for the ADR-0016 fail-closed commerce guard
      // (commerce-guard.ts), so any commerce-port call the brain/support path makes during this turn
      // (support.ts's order lookups) is checked against the principal that reached /chat this turn,
      // never a stale/shared one (AsyncLocalStorage keeps concurrent requests from bleeding together).
      const d = await withRequestPrincipal(shopperPrincipal, () => session.send(message, signals, history));
      // PR-8 — persist persona/preference memory from THIS turn, POST-decision, on the clean (successful)
      // /chat path only: this line is only reached after a decision was actually computed, never on the
      // early-return validation paths above (input_rejected/unauthenticated/rate_limited) or the
      // catch-block model-error path below, where there is no real decision/reply to distill from. Gated
      // on an active memory service (the double gate, or the PR-8 test seam) AND a subject key
      // (signals.anonId) — mirrors the brain's own `if (memory && signals.anonId)` recall guard; there is
      // nothing to key a write on for an anonymous, non-recognized shopper. Every consent/classification/
      // TTL decision is made INSIDE `remember()` (reused unchanged); this call site only decides WHETHER
      // to call it and WITH WHAT turn. Never blocks or breaks the response — a memory-service failure is
      // caught and logged, exactly like every other fail-open side effect on this path (telemetry/traffic).
      //
      // NN#4 (kill-switch completeness) — a memory write IS an autonomous, audited action, so an operator
      // kill must halt it like everything else. Skip remember() when a kill is armed for this tenant/agent
      // (`kill`, the same registry match that drives `killScope` in the audit below), AND when the brain
      // returned a decision that took NO autonomous action at all (`no_autonomous_action` — kill-switch or
      // another guardrail halt, brain.ts): there is nothing legitimately learnable from a halted turn, and
      // the operator halt must genuinely stop the write, not just the reply. (Narrowing writes further to
      // the clean SALES path only is a separate PR-11 human-sign-off scope decision; this guard is the
      // code-owned guardrail, not a business-policy choice.)
      if (memoryService && signals.anonId && !kill && !d.flags.includes("no_autonomous_action")) {
        try {
          await memoryService.remember(
            {
              tenantId,
              anonId: signals.anonId,
              region: signals.region,
              consent1: signals.consent?.memoryOrdinary ?? "unknown",
              consent2: signals.consent?.memorySpecial ?? "unknown",
            },
            { message, reply: d.reply },
          );
        } catch (e) {
          console.error(`[/chat] memory remember error:`, (e as Error).message);
        }
      }
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
        // ADR-0017 T8 — identity-resolution audit (PII-safe, F7 keyed HMAC): only for a turn where the
        // shopper resolved to a server-verified principal (no noise for the anonymous common case,
        // mirrors the governance-relevant-only policy above). AUDIT_HMAC_SECRET is guaranteed configured
        // whenever shopperPrincipal.kind==="shopper" is reachable (see its declaration above).
        if (shopperPrincipal.kind === "shopper" && AUDIT_HMAC_SECRET) {
          await t.audit(
            buildIdentityAuditInput({ shopperId: shopperPrincipal.shopperId, source: shopperPrincipal.source, tenantId, hmacKey: AUDIT_HMAC_SECRET }),
          );
        }
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
      // PR-11b: memoryEnabled/consentMode are the widget's SOLE source of truth for whether to ever mint
      // a durable anonId or show any consent UI — read-only, never client-settable.
      const response = {
        reply: d.reply,
        mode: d.mode,
        pitch: d.pitch,
        escalate: d.escalateToHuman,
        outbound: d.outbound,
        flags: d.flags,
        servedBy: policy.id,
        memoryEnabled: memoryServiceEnabled,
        consentMode: CONSENT_MODE,
        consentPrompt,
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
        memoryEnabled: memoryServiceEnabled,
        consentMode: CONSENT_MODE,
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
