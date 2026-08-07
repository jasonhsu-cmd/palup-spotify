import Fastify from "fastify";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import {
  createBrain,
  createSession,
  DEFAULT_CATALOG_RETRIEVAL_K,
  type Policy,
  type Signals,
  type Consent,
} from "@palup/widget-brain";
import { DEFAULT_POLICY, normalizeHistory, OFFER_CHECK_AGENT_TYPE } from "@palup/widget-brain";
import { createCatalogRetriever, CATALOG_RETRIEVAL_AGENT_TYPE } from "./catalog-retriever.js";
import { classifyGuardSignals, GUARD_CLASSIFIER_AGENT_TYPE } from "./guard-classifier.js";
import type { RuntimeStatePort, ModelPort, VectorPort, Principal, MerchantRegion, MerchantRegistryPort } from "@palup/platform-ports";
import {
  createWidgetTokenIdentity,
  mintWidgetToken,
  createGuestTokenIdentity,
  mintGuestToken,
  renewGuestToken,
  createShopperTokenIdentity,
  mintShopperToken,
  shopperIdTenant,
  createEnvSecrets,
  createAesGcmCrypto,
  createStoreTelemetry,
  createMeteringModelPort,
  createRedactingModelPort,
  createInMemoryProductFactsStore,
} from "@palup/platform-ports";
import { createMemoryService, isMemoryEnabled, validateAnonId, memorySubjectId, eraseSubject, classifyFact, sweepExpired, mergeAccountConsent, decideMemoryWrite } from "@palup/widget-memory";
import { createRuntimeStore, createVectorStore, matchedKill, matchedCostCap, RUNTIME_AGENT_TYPE, recordConsent, lookupConsent, revokeGuest, isGuestRevoked, PostgresMerchantRegistry, PostgresProductFactsStore, createMerchantCredentialStore, type Sql, type ConsentRecord } from "@palup/state-postgres";
import { createModelPort, createGroundingPort, createCommercePort } from "./model.js";
import { createRuntimeSessionStore } from "./session-store.js";
import { deriveServingSignals } from "./signals.js";
// E3 — both functions return `{}` unless the `Decision` already carries cited products, so they are inert
// for any turn E2 did not cite on. They are no longer inert BY CONSTRUCTION: this composition root now
// reads PRODUCT_CITATIONS/PRODUCT_CARDS and can produce such a Decision (see the Wave 4 flag block below).
// The flags still default OFF, so an environment that sets nothing behaves exactly as before.
// See recommendation-telemetry.ts for the not-a-billing-basis constraint that governs the telemetry half.
import { recommendationTelemetryFields, recommendationWireFields } from "./recommendation-telemetry.js";
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
import { createMerchantResolver, consentModeFor } from "./merchant-resolver.js";
import { SHOPIFY_APP_CLIENT_SECRET_NAME, SHOPIFY_APP_SECRET_SCOPE, DELEGATE_SCOPES_DEFAULT } from "./shopify-install-identity.js";
import {
  registerShopifyInstallRoutes,
  INSTALL_SCOPES_DEFAULT,
  type MerchantCredentialSink,
} from "./routes/shopify-install.js";
import { registerShopifyWebhookRoutes } from "./routes/shopify-webhooks.js";

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
// Publishable embed-key → merchantId registry (the key ships in the storefront snippet). JSON via env.
// NOT a secret — it only names which merchant a widget belongs to.
//
// FAIL CLOSED (this used to fail OPEN onto the demo tenant). The previous version `console.warn`ed on
// unparseable JSON, silently dropped any entry whose value wasn't a non-empty string, and then installed
// `{"demo-embed-key":"demo"}` whenever the result was empty. A logged fallback is still a silent
// fallback: a typo'd/truncated WIDGET_EMBED_KEYS substituted a DIFFERENT tenant registry than the one the
// operator declared, and every downstream write is keyed by the tenantId that registry resolves —
// sessions, the rate-limit buckets, the immutable audit log, telemetry, the traffic/canary log, consent
// records, the memory namespace, the per-tenant champion/canary policy, AND the Shopify grounding
// context. Concretely: merchant A's widget can no longer mint (its key isn't in the substituted
// registry), so with WIDGET_AUTH_REQUIRED off it drops the Authorization header (widget/public/index.html
// keeps `widgetToken = null` on a non-OK mint) and /chat, /consent and /forget all fall back to
// RUNTIME_TENANT="demo" — merchant A's shoppers are then served the demo tenant's catalog/policies and
// their state lands in the demo tenant's namespaces. That is the cross-tenant isolation invariant
// (docs/design/security-data-path.md §2 + Inv 1; docs/design/shopper-widget.md "tenant isolation"), and
// it also breaks NN#4: an operator arming a kill for `tenant-a` would not halt traffic being served as
// `demo`.
//
// So: refuse to BOOT rather than serve a substituted registry. Mirrors the two precedents in this repo
// rather than inventing a mechanism — `assertMemoryAuthCoupling` below (refuse to boot on a dangerous
// config, exported taking plain values so a test can exercise it without touching real env) and
// `createRuntimeStore`/`PALUP_REQUIRE_DATABASE_URL` (state-postgres/factory.ts: fail fast, never silently
// degrade). `requireExplicitRegistry` reuses that SAME existing "this is a real deployment" signal (set
// by the prod/staging deploy) rather than adding a new env var; local/dev/test, which set neither var,
// keep the built-in demo default byte-identical to before.
//
// The error names the variable and the rule but never echoes the configured value (it is operator input
// that lands in a boot log).
export function resolveEmbedKeys(raw: string | undefined, requireExplicitRegistry: boolean): Record<string, string> {
  const reject = (why: string): never => {
    throw new Error(
      `WIDGET_EMBED_KEYS ${why} — refusing to boot rather than silently serving the built-in ` +
        `"demo-embed-key" -> "demo" registry in its place (a substituted registry collapses every ` +
        `merchant onto the fallback tenant: see this function's own comment). Set WIDGET_EMBED_KEYS to ` +
        `a JSON object of {"<publishable-embed-key>":"<tenantId>"} with non-empty string values.`,
    );
  };
  if (raw === undefined || raw === "") {
    // Nothing declared. Convenient for local/dev/demo; unacceptable for a real deployment, which must
    // name its own tenants (staging declares the demo tenant explicitly — see deploy-staging.yml).
    if (requireExplicitRegistry) return reject("is not set, but this is a real deployment (PALUP_REQUIRE_DATABASE_URL=true)");
    const fallback: Record<string, string> = Object.create(null);
    fallback["demo-embed-key"] = "demo";
    return fallback;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return reject("is not valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return reject("is not a JSON object");
  const entries = Object.entries(parsed as Record<string, unknown>);
  // An explicitly EMPTY registry is unusable (no widget could ever mint) and is exactly the case that
  // used to become the demo tenant.
  if (entries.length === 0) return reject("declares no embed keys");
  const map: Record<string, string> = Object.create(null); // null proto: no __proto__/constructor keys
  for (const [k, v] of entries) {
    // Reject the WHOLE registry on ANY bad entry rather than dropping it: a dropped merchant's widget
    // cannot mint and then serves under the fallback tenant — the same collapse, one merchant at a time,
    // and the old code did not even warn for that case (the map stayed non-empty).
    if (!k) return reject("contains a blank embed key");
    if (typeof v !== "string" || !v) return reject("maps an embed key to something other than a non-empty string tenant id");
    map[k] = v;
  }
  return map;
}
// Go-live #3 — couple memory enablement to enforced widget auth. During the WIDGET_AUTH_REQUIRED
// rollout window (default off) POST /consent and the DESTRUCTIVE POST /forget are callable
// unauthenticated against RUNTIME_TENANT (both routes only 401 an unauthenticated caller when
// WIDGET_AUTH_REQUIRED is true — see their handlers below). Both prior security reviews recorded "set
// WIDGET_AUTH_REQUIRED=true before/at the flip" as a memory-enablement precondition. Rather than
// flipping WIDGET_AUTH_REQUIRED's OWN default (which would change behavior for every existing
// non-memory deployment), make the coupling STRUCTURAL and fail-closed: refuse to boot rather than
// silently serve memory endpoints unauthenticated — mirrors how `createRuntimeStore` fails fast on
// PALUP_REQUIRE_DATABASE_URL (state-postgres/factory.ts) rather than silently degrading to a
// per-process store. Exported (and taking plain booleans, not reading env/gates itself) so a test can
// exercise the guard directly without needing to flip the real flag.ts double gate.
export function assertMemoryAuthCoupling(memoryEnabled: boolean, widgetAuthRequired: boolean): void {
  if (memoryEnabled && !widgetAuthRequired) {
    throw new Error(
      "memory is enabled for this process but WIDGET_AUTH_REQUIRED is not \"true\" — refusing to " +
        "boot with the memory endpoints (POST /consent, POST /forget) reachable unauthenticated. Set " +
        "WIDGET_AUTH_REQUIRED=true before/at enabling memory (both prior security reviews recorded this " +
        "as an enablement precondition).",
    );
  }
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
  /** C1 test seam (mirrors `caaFetch`): the outbound fetch used by the Shopify install routes for the
   * token exchange and `delegateAccessTokenCreate`. Prod uses the global fetch. */
  installFetch?: typeof globalThis.fetch;
  /** C1 test seam: the MerchantRegistryPort the install routes write to. Prod builds a
   * `PostgresMerchantRegistry` over the SAME pool the runtime store opened, when DATABASE_URL is set. */
  merchantRegistry?: MerchantRegistryPort;
  /**
   * C1 — encrypted per-merchant credential custody for the delegate token. CORRECTED (this said "NOT
   * CONSTRUCTED IN PRODUCTION YET … #186 is unmerged"; B2 landed and the composition root below now builds
   * `createMerchantCredentialStore` unconditionally, so this seam is a TEST OVERRIDE, not the only source).
   * A missing sink ⇒ the install routes are NOT REGISTERED (see the gate below). That is deliberate, not an
   * oversight: an install that minted a delegate token and then had nowhere to store it would leave a live
   * Shopify credential with no custody and no revocation path. NOTE (D1): serving still does not READ this
   * store — the Storefront token comes from `SecretsPort` (merchant-store.ts). That is D2.
   */
  merchantCredentials?: MerchantCredentialSink;
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
  // Security review (Finding 6 — LOW, corrected): FAIL FAST, before any store/pool construction or DDL —
  // mirrors how `createRuntimeStore` fails fast on PALUP_REQUIRE_DATABASE_URL. This guard previously ran
  // AFTER createRuntimeStore/createVectorStore/createMemoryService below, so a misconfigured live-memory
  // boot would already have opened a pool and run idempotent CREATE TABLE/index DDL before refusing to
  // start; computing it here (both inputs are pure env/config reads with no I/O) means a rejected boot
  // leaves no pool/DDL work behind. `memoryServiceEnabled` (security review, Finding 2 — MEDIUM,
  // corrected) is the SAME predicate reused below to actually construct the MemoryService and arm the
  // retention sweep — not a parallel one that can diverge from it.
  const underTestRunner = process.env.VITEST === "true" || process.env.NODE_ENV === "test";
  const memoryServiceEnabled = underTestRunner ? (opts?.memoryEnabled ?? isMemoryEnabled()) : isMemoryEnabled();
  const WIDGET_AUTH_REQUIRED = process.env.WIDGET_AUTH_REQUIRED === "true";
  assertMemoryAuthCoupling(memoryServiceEnabled, WIDGET_AUTH_REQUIRED);
  // Same fail-fast placement, same reason: both inputs are pure env reads with no I/O, so a rejected boot
  // leaves no pool/DDL work behind. `PALUP_REQUIRE_DATABASE_URL` is the EXISTING marker the prod/staging
  // deploy sets (state-postgres/factory.ts) — reused as the "real deployment" signal rather than adding a
  // parallel env var that could drift from it. Resolved here (not lazily at the routes) so a bad registry
  // can never reach a request.
  const EMBED_KEYS = resolveEmbedKeys(process.env.WIDGET_EMBED_KEYS, process.env.PALUP_REQUIRE_DATABASE_URL === "true");

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
  // ── D1 — the merchant registry, and the resolver that is now the ONLY way the serving path decides
  // which merchant a request belongs to and whether it may still be served. See merchant-resolver.ts for
  // the precedence rule, what stayed on env, and why. HOISTED HERE (it used to be constructed ~300 lines
  // below, next to the C1 install gate) for one concrete reason: `createGroundingPort` needs
  // `shopDomainFor`, so the resolver must exist before it. Reuses the pool the runtime store already
  // opened — never a second `pg.Pool` (the same HIGH finding that made `createVectorStore` share
  // `runtimeResult.sql`). No durable registry ⇒ `undefined` ⇒ the resolver is pure env and every path below
  // behaves exactly as it did before D1, which is what keeps `pnpm backend`, the e2e suite and the eval
  // corpus unchanged.
  const merchantRegistry: MerchantRegistryPort | undefined =
    opts?.merchantRegistry ?? (runtimeResult.sql ? new PostgresMerchantRegistry(runtimeResult.sql) : undefined);
  // DDL BELONGS WITH CONSTRUCTION, NOT WITH A FEATURE FLAG. This used to live inside
  // `if (SHOPIFY_INSTALL_ENABLED)` and `if (SHOPIFY_WEBHOOKS_ENABLED)` — C1's and C2's gates — while the
  // registry above is constructed from `DATABASE_URL` alone and D1 made EVERY token mint read it. A
  // deployment with a database but no Shopify app credentials therefore served a table nobody had
  // created, and D1's (correct) fail-closed rule turned that into a 401 on every request. That is exactly
  // what took staging down: /health reported `merchants: registry+env` while POST /widget/token returned
  // 401 and the log said "registry lookup FAILED ... refusing to resolve". Two individually-correct halves,
  // jointly fatal.
  //
  // Mirrors `createRuntimeStore` / `createVectorStore`, which have always migrated at construction — and
  // whose tables consequently exist, which is also the evidence that the database role has CREATE and that
  // no grant was ever missing.
  //
  // Capability-checked rather than `instanceof`: several suites inject minimal registry doubles, and
  // "migrate whatever can be migrated" is the honest rule — a double without `migrate` is simply left
  // alone. Idempotent (`CREATE TABLE IF NOT EXISTS`), so running it on every boot is free.
  const migratable = merchantRegistry as { migrate?: () => Promise<void> } | undefined;
  if (typeof migratable?.migrate === "function") await migratable.migrate();
  // D2 — `MERCHANT_REGION` / `MERCHANT_GROUNDING_MODE`, hoisted here (they used to be parsed ~220 lines
  // below, next to `CONSENT_MODE`) because the resolver now needs them at construction. Both are pure env
  // reads with no I/O, so hoisting them changes nothing about boot ordering.
  //
  // THEIR RANK CHANGED, NOT THEIR PARSING. Since D2 these are the NAMED FALLBACK for a tenant the merchant
  // registry has no row for — exactly the rank `WIDGET_EMBED_KEYS` has held for identity since D1 — rather
  // than the residency EVERY merchant is served under. A registry merchant is served under their OWN row's
  // `region`; see merchant-resolver.ts's "THE SERVING CONFIG" for the full rule and for why a row with an
  // unusable region is REFUSED instead of inheriting these.
  const MERCHANT_REGION: MerchantRegion = (() => {
    const r = process.env.MERCHANT_REGION;
    return r === "us" || r === "eu" || r === "uk" || r === "other" ? r : "us";
  })();
  const MERCHANT_GROUNDING_MODE: NonNullable<Signals["groundingMode"]> = (() => {
    const g = process.env.MERCHANT_GROUNDING_MODE;
    return g === "off" || g === "general" || g === "full" ? g : "full";
  })();
  const merchants = createMerchantResolver({
    store,
    ...(merchantRegistry ? { registry: merchantRegistry } : {}),
    embedKeys: EMBED_KEYS,
    storeDomains: () => parseStoreDomains(),
    envRegion: MERCHANT_REGION,
    envGroundingMode: MERCHANT_GROUNDING_MODE,
  });
  /**
   * D2 — the merchant's region for the DATA-RIGHTS paths, which are deliberately NOT gated on servability
   * (D1: erasure and consent withdrawal must outlive the install). `/consent` still has to answer for a
   * revoked merchant, an unregistered tenant and an unreadable registry, and in all three there is no
   * merchant-declared jurisdiction to apply.
   *
   * Returns `undefined` in exactly those cases, which every consent consumer already treats as the
   * STRICTEST regime (`consentPermits`, ADR-0015 Inv 3) — never the process env value. Guessing `"us"` for
   * a merchant we could not resolve is the whole defect D2 exists to remove, and it would be worse on this
   * endpoint than on `/chat`: this one is what the manage panel renders back to the shopper.
   */
  const consentRegionFor = async (tenantId: string): Promise<MerchantRegion | undefined> => {
    const s = await merchants.servability(tenantId, "chat");
    return s.kind === "servable" ? s.config.region : undefined;
  };
  const grounding = createGroundingPort(store, secrets, { shopDomainFor: (t) => merchants.shopDomainFor(t) });
  // Hoisted ABOVE `createMemoryService` below (it used to be declared much later, alongside
  // `shopperIdentity`) so the memory service can be constructed with a real `hmacKey` from the start —
  // security-review remediation MEDIUM finding, PR #152: a `acct:` subject's audit `subjectRef` must be
  // a KEYED HMAC, not a bare hash (widget-backend/src/audit.ts's own `hashShopperRef` rule). A verified
  // shopper principal can only ever reach a memory surface after `/shopper/session` mints a token with
  // SHOPPER_TOKEN_SECRET, so that secret is guaranteed configured whenever an `acct:` subject exists;
  // AUDIT_HMAC_SECRET is an optional, separately-provisionable override (defense-in-depth key
  // separation) that needs nothing extra to provision today.
  const SHOPPER_TOKEN_SECRET = process.env.SHOPPER_TOKEN_SECRET;
  const AUDIT_HMAC_SECRET = process.env.AUDIT_HMAC_SECRET || SHOPPER_TOKEN_SECRET;
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
  // `underTestRunner` / `memoryServiceEnabled` are computed once, at the very top of this function
  // (before the fail-fast boot guard) — reused here unchanged.
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
        // MEDIUM finding (security-review remediation, PR #152) — keyed-HMAC key for every memory audit
        // subjectRef this service writes; see MemoryServiceDeps's own doc comment.
        hmacKey: AUDIT_HMAC_SECRET,
      })
    : undefined;
  const memoryPort = memoryService
    ? {
        recall: (ctx: { tenantId: string; anonId: string; region?: Signals["region"]; consent?: Signals["consent"] }) =>
          memoryService.recall({
            tenantId: ctx.tenantId,
            anonId: ctx.anonId,
            // B7 FIX (2026-08-05) — these were hardcoded to "unknown", which made the sliding-TTL
            // RENEWAL structurally unreachable on the /chat path: a subject with a real consent1="in"
            // on file never got their fact's expiry slid forward on return, because this wrapper never
            // told service.ts so (Inv 4's 2026-08-04 amendment was therefore inert here). That was a
            // documented, pre-existing gap, deferred at the time as needing its own reviewed change.
            //
            // The brain now threads THIS TURN's server-derived consent context through the recall port
            // (widget-brain types.ts `MemoryRecallPort`), so the real values arrive here. `?? "unknown"`
            // keeps the fail-closed default for any caller that does not supply them — identical to the
            // old behavior, rather than assuming consent when the context is missing.
            //
            // This only affects RETENTION RENEWAL and never what surfaces: brain.ts re-checks read-time
            // consent independently on whatever this returns (`consentedAtReadTime`), so a permissive
            // value here can never push an unconsented fact into the prompt.
            region: ctx.region,
            consent1: ctx.consent?.memoryOrdinary ?? "unknown",
            consent2: ctx.consent?.memorySpecial ?? "unknown",
          }),
      }
    : undefined;
  // ADR-0016 enactment — the subscription skip/pause self-serve posture flag. Default OFF ⇒ byte-
  // identical to today (skip/pause always human-routed); read here (not hardcoded) and threaded into
  // every brain exactly like every other posture flag (WIDGET_AUTH_REQUIRED/SHOPPER_AUTH below). The
  // brain/support.ts layer independently re-requires a server-VERIFIED shopper before ever auto-executing
  // — this flag alone can never grant autonomy to an anonymous shopper.
  const SUBSCRIPTION_SELFSERVE = process.env.SUBSCRIPTION_SELFSERVE === "true";
  // ─── WAVE 4 (E1–E4) POSTURE FLAGS ──────────────────────────────────────────────────────────────────
  // Read here, defaulted OFF, threaded into every brain exactly like SUBSCRIPTION_SELFSERVE above.
  //
  // WHY THESE ARE COMPOSED AT ALL. E1–E4 each shipped deliberately un-composed, on the reasoning that "a
  // flag alone cannot turn this on" (catalog-retriever.ts's own header). That bought inertness at the cost
  // of UNPROMOTABILITY: NN#2's pipeline is `gate → shadow(0%) → canary(1–5%) → human approve → promote`,
  // and shadow/canary put a FRACTION OF REAL TRAFFIC through the candidate — which cannot happen when the
  // composition root is structurally incapable of building a flag-on brain. There was no code path to
  // canary. The repo's own precedent settles the governance question the other way: SUBSCRIPTION_SELFSERVE
  // (ADR-0016) and SHOPPER_AUTH (ADR-0017) are equally behaviour-changing and equally governed, and both
  // are env-read right here. What keeps a posture flag safe is the eval gate plus a named human's
  // promotion — not the absence of a wire. The gate can now SEE E2 and E4 (packages/eval, #204); before
  // that it was green having executed neither, which is why this wiring waited for it.
  //
  // Turning any of these ON in a real environment remains a human promotion decision (HITL-POLICY §5).
  const CATALOG_RETRIEVAL = process.env.CATALOG_RETRIEVAL === "true";
  const CATALOG_RETRIEVAL_K = posInt("CATALOG_RETRIEVAL_K", DEFAULT_CATALOG_RETRIEVAL_K);
  const PRODUCT_CITATIONS = process.env.PRODUCT_CITATIONS === "true";
  const PRODUCT_CARDS = process.env.PRODUCT_CARDS === "true";
  const CART_LINE_ITEMS = process.env.CART_LINE_ITEMS === "true";
  // T1 phase 2 — SERVER_GUARD_SIGNALS: run the server-side language-agnostic guard classifier per turn and
  // thread its result into signals (the brain merges it most-conservative-wins with its keyword floor).
  // Same governed posture-flag discipline as the Wave 4 flags: env-read here, default OFF, and turning it
  // on in a real environment is a human promotion (HITL-POLICY §5) — it changes what the shopper agent
  // detects. OFF ⇒ the classifier never runs (zero spend) and the guardrail ladder is byte-identical.
  const SERVER_GUARD_SIGNALS = process.env.SERVER_GUARD_SIGNALS === "true";
  // A1b — PRODUCT_FACTS_HYDRATION: overlay the Tier-2 store's fresh price/availability onto the retrieved
  // subset before it renders. Same governed posture-flag discipline: env-read here, default OFF, turning it
  // on is a human promotion (HITL-POLICY §5) — it changes which PRICE the agent quotes (money/NN#1). OFF ⇒
  // the store is never constructed, getMany never runs, and the CATALOG block is byte-identical.
  const PRODUCT_FACTS_HYDRATION = process.env.PRODUCT_FACTS_HYDRATION === "true";
  // 3b — OUTGOING_OFFER_CHECK: run the language-agnostic semantic check on the outgoing reply (a backstop to
  // the deterministic keyword floor) per sales turn. Same governed posture-flag discipline: env-read here,
  // default OFF, turning it on is a human promotion (HITL §5) — it adds a per-turn model call (cost) and is
  // a money-guard behaviour change. OFF ⇒ the check never runs (zero spend) and reply-integrity is exactly
  // the keyword floor, byte-identical.
  const OUTGOING_OFFER_CHECK = process.env.OUTGOING_OFFER_CHECK === "true";
  // E3 attaches display fields to the ids E2 cited, so cards WITHOUT citations is inert rather than
  // broken (recommendation-telemetry.ts returns `{}` for a Decision with no cited products). Warn like
  // SUBSCRIPTION_SELFSERVE's own unmet-prerequisite check above — the degrade is safe, never a bypass.
  if (PRODUCT_CARDS && !PRODUCT_CITATIONS) {
    console.warn("[config] PRODUCT_CARDS=true has no effect without PRODUCT_CITATIONS=true (E3 attaches cards to the product ids E2 cites) — no cards will be served.");
  }
  // E1 — the query side of the catalog corpus, constructed ONLY when the flag is on, so a deployment that
  // never enables retrieval reads no manifest and spends nothing. Metered under its OWN agentType,
  // distinct from the turn's RUNTIME_AGENT_TYPE: this is per-shopper-turn EMBEDDING spend while the turn
  // itself is generation, and a cost review must be able to tell them apart (ADR-0013, and the explicit
  // requirement in catalog-retriever.ts's COST + AUDIT note that the composition root must do this).
  const catalogRetriever = CATALOG_RETRIEVAL
    ? createCatalogRetriever({
        store,
        vector: vectorPort,
        model: createMeteringModelPort(activeModelPort, telemetry, { agentType: CATALOG_RETRIEVAL_AGENT_TYPE }),
      })
    : undefined;
  // T1 phase 2 — the guard classifier's model port, metered under its OWN agentType so its per-turn
  // classification spend is distinguishable from generation/embedding (ADR-0013). Constructed ONLY when
  // SERVER_GUARD_SIGNALS is on, so a deployment that never enables it spends nothing.
  const guardClassifierModel = SERVER_GUARD_SIGNALS
    ? createMeteringModelPort(activeModelPort, telemetry, { agentType: GUARD_CLASSIFIER_AGENT_TYPE })
    : undefined;
  // A1b — the Tier-2 product-facts store, constructed ONLY when PRODUCT_FACTS_HYDRATION is on (a deployment
  // that never enables hydration builds nothing). Durable Postgres when a pool exists (same pool the runtime
  // store opened), else the in-memory reference adapter — mirroring the merchant-registry selection above.
  // Migrated at startup like the other Postgres state stores. No producer populates it yet (that is A3), so
  // even flag-on it hydrates from an empty store until ingestion lands — inert by construction today.
  const productFactsPort = PRODUCT_FACTS_HYDRATION
    ? runtimeResult.sql
      ? new PostgresProductFactsStore(runtimeResult.sql)
      : createInMemoryProductFactsStore()
    : undefined;
  if (productFactsPort instanceof PostgresProductFactsStore) await productFactsPort.migrate();
  // 3b — the outgoing-offer checker's model port, metered under its OWN agentType so its per-turn check
  // spend is distinguishable from generation/embedding/guard (ADR-0013). Constructed ONLY when
  // OUTGOING_OFFER_CHECK is on, so a deployment that never enables it spends nothing.
  const offerCheckModel = OUTGOING_OFFER_CHECK
    ? createMeteringModelPort(activeModelPort, telemetry, { agentType: OFFER_CHECK_AGENT_TYPE })
    : undefined;
  // THE COST OF WIRING THESE, MADE VISIBLE. Before this change, enabling Wave 4 required editing code;
  // now an env var suffices. That is a real reduction in friction and it is the honest trade for making
  // shadow/canary possible at all (HITL-POLICY §5). The compensating control is that an enabled flag can
  // never be SILENT: it is announced at boot, for the same reason D1's env fallback is (#169 happened
  // because a posture nobody could see was wrong for weeks). §5 still requires a recorded eval gate,
  // shadow, canary and a named human's approval before any of these is set in a real environment — this
  // line does not authorize it, it makes skipping it visible.
  const wave4On = Object.entries({ CATALOG_RETRIEVAL, PRODUCT_CITATIONS, PRODUCT_CARDS, CART_LINE_ITEMS, SERVER_GUARD_SIGNALS, PRODUCT_FACTS_HYDRATION, OUTGOING_OFFER_CHECK })
    .filter(([, v]) => v)
    .map(([k]) => k);
  if (wave4On.length > 0) {
    console.warn(
      `[config] WAVE 4 POSTURE FLAGS ARE ON: ${wave4On.join(", ")} — these change what the shopper agent ` +
        "sees and says. HITL-POLICY §5 requires a recorded eval gate, shadow, canary and a NAMED HUMAN'S " +
        "approval before this posture serves real traffic. If that did not happen, unset them.",
    );
  }
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
      b = createBrain(
        meteredModel, grounding, policy, commerce, "shopper-demo", memoryPort, SUBSCRIPTION_SELFSERVE,
        // Positions 8–10 — the disposition flags (ADR-0018). These have NO env read anywhere in the repo
        // and stay off. Passed EXPLICITLY at their defaults rather than left implicit: reaching Wave 4's
        // positions requires naming them, and a bare `undefined` here would be indistinguishable from a
        // wiring bug of the exact kind this call site just had. Wiring them is a separate decision under
        // their own ADR — not this change's to make.
        /* dispositionStyle */ false, /* dispositionBehavioral */ false, /* dispositionClassifier */ false,
        // Positions 11–16 — Wave 4. `catalogRetriever` is `undefined` unless CATALOG_RETRIEVAL is set, so
        // the retrieval rung has nothing to call and falls back to the full catalog exactly as before.
        catalogRetriever, CATALOG_RETRIEVAL, CATALOG_RETRIEVAL_K, PRODUCT_CITATIONS, PRODUCT_CARDS, CART_LINE_ITEMS,
        // Position 17 — T1 SERVER_GUARD_SIGNALS. The brain consults signals.serverSafetyClass/serverInjection
        // (populated per-turn below when this is on) alongside its keyword floor, most-conservative-wins.
        SERVER_GUARD_SIGNALS,
        // Positions 18–19 — A1b. `productFactsPort` is `undefined` unless PRODUCT_FACTS_HYDRATION is set, so
        // the hydrate step has nothing to call and the retrieved subset renders with its live-catalog price
        // exactly as today. Only ever consulted for the retrieved subset, never the whole catalog.
        productFactsPort, PRODUCT_FACTS_HYDRATION,
        // Positions 20–21 — 3b. `offerCheckModel` is `undefined` unless OUTGOING_OFFER_CHECK is set, so the
        // reply-integrity check is exactly the deterministic keyword floor and the decision is byte-identical.
        offerCheckModel, OUTGOING_OFFER_CHECK,
      );
      brains.set(key, b);
    }
    return b;
  };
  brainFor(RUNTIME_TENANT, DEFAULT_POLICY); // prewarm the default-tenant champion
  // Widget-identity config (read per boot so a test / deploy can configure it).
  const WIDGET_TOKEN_SECRET = process.env.WIDGET_TOKEN_SECRET;
  const WIDGET_TOKEN_TTL_SECONDS = posInt("WIDGET_TOKEN_TTL_SECONDS", 3_600);
  // `WIDGET_AUTH_REQUIRED` is computed once, at the very top of this function (before the fail-fast boot
  // guard) — reused here unchanged.
  // `EMBED_KEYS` is resolved once, at the very top of this function (alongside the other fail-fast boot
  // guards) — see `resolveEmbedKeys`. Since D1 NO ROUTE READS IT DIRECTLY: it is handed to
  // `createMerchantResolver` above as the named FALLBACK behind the merchant registry, and every embed-key
  // lookup goes through `merchants.resolveEmbedKey`.
  const widgetIdentity = createWidgetTokenIdentity(WIDGET_TOKEN_SECRET);
  // ADR-0019 — guest identity. A SEPARATE secret from the widget/shopper token secrets (R2-4): a
  // compromise of one token type must not forge another. Absent ⇒ `guestIdentity.verify` always yields
  // null and `POST /widget/guest` cannot mint, which is the correct inert state while the feature is
  // unprovisioned/off. TTL matches the ordinary retention window (sliding; the widget renews before expiry).
  const GUEST_TOKEN_SECRET = process.env.GUEST_TOKEN_SECRET;
  const GUEST_TOKEN_TTL_SECONDS = posInt("GUEST_TOKEN_TTL_SECONDS", 30 * 24 * 3_600); // 30d, matches ORDINARY_TTL
  const guestIdentity = createGuestTokenIdentity(GUEST_TOKEN_SECRET);
  // ADR-0019 Revision 2, Task 4 — THE ONE guest-subject derivation. The guest memory subject comes from a
  // VERIFIED guest token in the `x-guest-token` header, bound to THIS tenant (C1: always pass tenantId),
  // and NEVER from `body.anonId` / `signals.anonId` (invariant 4 — no fallback to a client-named id; that
  // fallback is exactly what failed the F1 attack test). Returns the validated `anonId` (C2: validateAnonId
  // even though the token minted it, so a forged-but-signed lowercase/`::` aid can never key a namespace)
  // or `undefined`. Every route (/chat, /consent, /forget) calls THIS, so they cannot disagree on whose
  // memory a request touches, and C13's derivation-drift risk cannot reach the guest side.
  const guestAnonIdFrom = async (req: { headers: Record<string, unknown> }, tenantId: string): Promise<string | undefined> => {
    const h = req.headers["x-guest-token"];
    const tok = typeof h === "string" ? h : Array.isArray(h) ? h[0] : undefined;
    if (!tok) return undefined;
    const claims = await guestIdentity.verify(tok, { tenantId });
    if (!claims) return undefined;
    const anonId = validateAnonId(claims.anonId);
    if (!anonId) return undefined;
    // ADR-0019 Task 5 / R2-7 (invariant 8): a REVOKED aid verifies as anonymous. Every memory-touching
    // route derives its guest subject through THIS helper, so consulting the revocation record here enforces
    // invariant 8 everywhere at once (a signed, non-expired token whose aid the shopper has since revoked
    // via forget-me yields no subject → no recall, no write). FAIL CLOSED: if the store read throws we cannot
    // confirm the credential is still live, so we treat it as revoked (return anonymous) rather than risk
    // honouring a revoked token — the same fail-closed bias the consent path uses (unknown ⇒ no memory). The
    // cost is that a runtime-state outage degrades all guest memory to anonymous, which is acceptable and
    // matches how the rest of the feature fails under store distress.
    try {
      if (await isGuestRevoked(store, { tenantId, anonId })) return undefined;
    } catch {
      return undefined;
    }
    return anonId;
  };
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
  // SHOPPER_TOKEN_SECRET itself is now declared earlier, alongside AUDIT_HMAC_SECRET (see that comment).
  const SHOPPER_TOKEN_TTL_SECONDS = posInt("SHOPPER_TOKEN_TTL_SECONDS", 3_600);
  const shopperIdentity = createShopperTokenIdentity(SHOPPER_TOKEN_SECRET);

  /**
   * Subject-scoped auth — resolve the SERVER-VERIFIED shopper id for a request, or `undefined`.
   *
   * The cross-visit-memory subject used to be a raw client-supplied `anonId` on every surface, and
   * `validateAnonId` only proves a string is well-FORMED, never that the caller owns it — so within one
   * tenant, possession of another shopper's `anonId` was enough to set their consent or DELETE their
   * memory. `/consent` and `/forget` below both call this helper directly.
   *
   * CORRECTED (this comment previously overclaimed "the single derivation all three memory surfaces use,
   * so they cannot drift"): `/chat` does NOT call this helper — it re-derives the equivalent check
   * inline (below, where `shopperPrincipal` is resolved) because it needs the full verified `Principal`
   * object for other purposes (the `shopperVerified` signal, `withRequestPrincipal`'s commerce-guard
   * binding), not just the id string this helper returns. The two derivations apply the EXACT SAME gates
   * (feature flag, `kind === "shopper"` + explicit `verified`, cross-shop tenant check) and are kept in
   * sync by inspection, not by sharing code — a genuine, if narrow, drift risk versus a true single
   * source of truth. Unifying them (having `/chat` derive its Principal through a shared helper that
   * also returns the resolved token id) is a reasonable follow-up, not done here to avoid touching the
   * already-tested recall path (subject-scoped-memory-auth.test.ts's "THE ATTACK (recall)") for a
   * documentation-only finding.
   *
   * Every gate here is load-bearing: the feature flag, a verified MERCHANT principal (the shopper token
   * is only meaningful inside a verified tenant session), `kind === "shopper"` AND the explicit
   * `verified` flag (an id-set-but-unverified principal must never authorize — the same trap
   * `deriveServingSignals` guards against), and the cross-shop check that the token's own tenant equals
   * THIS request's tenant (a token minted for some other verified tenant must not be replayable here).
   */
  // ADR-0019 task 6 (closes C13) — THE ONE shopper-principal resolution. Before this, `/chat` derived the
  // verified shopper inline while `/consent`/`/forget` used `verifiedShopperIdFor`; C13 recorded that as two
  // implementations of one security decision and a drift risk. Both now go through THIS: every gate in one
  // place — the feature flag, a verified MERCHANT principal (a shopper token is only meaningful inside a
  // verified tenant session), `kind === "shopper"` AND the explicit `verified` flag (an id-set-but-unverified
  // principal must never authorize), and the F1 cross-shop check that the token's embedded tenant equals THIS
  // request's tenant (a token minted for another verified tenant must not be replayable here). Returns the
  // verified shopper `Principal`, or `{kind:"anonymous"}` — never a half-trusted state. `/chat` needs the
  // full Principal (for signals.shopperId/shopperVerified and the identity audit); the two routes that only
  // need the id call the `verifiedShopperIdFor` wrapper below.
  const resolveVerifiedShopper = async (
    merchantPrincipal: Principal,
    tenantId: string,
    headerToken: unknown,
    bodyToken: unknown,
  ): Promise<Principal> => {
    if (!SHOPPER_AUTH_ENABLED || merchantPrincipal.kind !== "merchant") return { kind: "anonymous" };
    const token =
      typeof headerToken === "string" ? headerToken : typeof bodyToken === "string" ? bodyToken : undefined;
    const resolved = await shopperIdentity.authenticate(token);
    if (resolved.kind !== "shopper" || !resolved.verified) return { kind: "anonymous" };
    if (shopperIdTenant(resolved.shopperId) !== tenantId) return { kind: "anonymous" };
    return resolved;
  };
  /** The id-only projection of `resolveVerifiedShopper`, for `/consent` and `/forget`. */
  const verifiedShopperIdFor = async (
    merchantPrincipal: Principal,
    tenantId: string,
    headerToken: unknown,
    bodyToken: unknown,
  ): Promise<string | undefined> => {
    const p = await resolveVerifiedShopper(merchantPrincipal, tenantId, headerToken, bodyToken);
    return p.kind === "shopper" ? p.shopperId : undefined;
  };
  // AUDIT_HMAC_SECRET (T8 identity-resolution audit ref, F7 — never a bare hash) is now declared much
  // earlier, alongside SHOPPER_TOKEN_SECRET, so `createMemoryService` below can use it too.
  // T7 — server-derived trust-bearing signals. These govern behavior/residency/competitor-mode, so they
  // come from merchant/server config, never the shopper.
  //
  // D2 — THE MULTI-TENANCY THIS COMMENT USED TO PROMISE IS NOW HERE. `MERCHANT_REGION` /
  // `MERCHANT_GROUNDING_MODE` are parsed much earlier (next to the merchant resolver, which needs them)
  // and are now the NAMED FALLBACK for a tenant with no registry row, not the value every merchant is
  // served under: `merchants.servability(tenantId, …)` returns the tenant's OWN `config` from their
  // `pl_merchant` row, and that is what reaches `deriveServingSignals` below.
  //
  // `CONSENT_MODE` IS GONE AS A BOOT CONSTANT, and that is the substantive part of D2. It was derived once
  // from the process's region and returned on every `/chat` response, which meant one jurisdiction per
  // instance for a field that decides whether ordinary memory is opt-in or opt-out
  // (`consentPermits`, widget-brain/src/consent-rules.ts). It is now `consentModeFor(<this merchant's
  // region>)`, computed per response — and `consentModeFor(undefined)` on the paths that answer before a
  // merchant is resolved, which is the STRICTER regime by construction (ADR-0015 Inv 3).
  //
  // PR-11b's other client-facing field is unchanged: `memoryEnabled` still mirrors the SAME double-gated
  // `memoryServiceEnabled` computed above (false in real production — the double gate, flag.ts).
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

  // ── C1 — Shopify app install (OAuth authorization code grant → delegate access token) ──────────────
  //
  // WHAT THIS DOES AND DOES NOT DO. It records an install in `pl_merchant` (B1) and custodies the
  // merchant's delegate token (B2).
  //
  // UPDATED BY D1 — this paragraph used to end "It does NOT make the merchant servable", and that is no
  // longer true. Since D1, an installed merchant's IDENTITY is live: `/widget/token` mints for their registry
  // `embedKey` with no env change (merchant-resolver.ts), `/chat` re-checks their `status` every turn, and
  // grounding resolves their shop domain from their row. What is STILL not live, precisely:
  //   • their STOREFRONT TOKEN. Serving reads `shopify_storefront_token` from `SecretsPort`
  //     (merchant-store.ts) — NOT B2's encrypted delegate credential — so a self-installed merchant's
  //     shoppers get the FIXTURE catalog until an operator provisions that secret. That is D2.
  //   • (CLOSED BY D2 — `region`/`groundingMode` used to be listed here. An installed merchant is now
  //     SERVED with the residency recorded on their own row, so `SHOPIFY_INSTALL_REGION` is the value that
  //     actually governs their shoppers' consent regime, not just a column.)
  //   • the catalog-index and retention-sweep jobs still enumerate `SHOPIFY_STORES`, because
  //     `MerchantRegistryPort` has no enumeration operation (C3's finding, still open).
  //
  // FULLY-CONFIGURED-OR-ABSENT, the same posture as CAA_ENABLED: every precondition below is individually
  // load-bearing and a missing one means the routes are never registered (404), not that they half-work.
  //   • SHOPIFY_APP_CLIENT_ID          — the app's OAuth client id (not a secret; it ships in the URL).
  //   • SHOPIFY_INSTALL_REDIRECT_URI   — must ALSO be registered as an allowed redirect URL on the app.
  //   • SHOPIFY_INSTALL_REGION         — REQUIRED, no default. `NewMerchant.region` is required on purpose
  //     (merchant-registry-port.ts:89-91): the silent `"us"` fallback below is a residency decision made by
  //     an unset env var, and the legal review flagged exactly that. Shopify's callback carries no
  //     residency signal, so an operator declares it or the feature stays off.
  //   • the app client secret in the SecretsPort under the APP-scoped sentinel — read once here for the
  //     gate, and again per request inside the flow so a rotation needs no redeploy.
  //   • a durable MerchantRegistryPort — DATABASE_URL must be set. An in-memory registry is deliberately
  //     NOT accepted: it would forget every install on the next cold start while reporting success, which
  //     is the same class of failure `kill-switch.ts` refuses (a store nobody else can see).
  //   • credential custody — B2's `createMerchantCredentialStore` (#186), built over the SAME
  //     composition-root `secrets` and the SAME runtime store, so the delegate token is encrypted at rest
  //     under a per-(tenant, scope) key and its write is audited atomically inside B2's own transaction.
  //     It needs the per-tenant key `MEMORY_ENCRYPTION_KEY__merchant-cred` provisioned in `PALUP_SECRETS`
  //     for each installing merchant. That key CANNOT be checked at boot (it is per-tenant, and the tenant
  //     is unknown until a merchant installs), so a missing one surfaces at install time as a refusal:
  //     `CryptoPort.encrypt` throws, B2 writes nothing at all, and the callback returns 502 having created
  //     no row and no credential. Fail-closed, and the honest place for the failure — reported for
  //     docs/DEPLOY.md (contended, so not edited here).
  const SHOPIFY_APP_CLIENT_ID = process.env.SHOPIFY_APP_CLIENT_ID;
  const SHOPIFY_INSTALL_REDIRECT_URI = process.env.SHOPIFY_INSTALL_REDIRECT_URI;
  const SHOPIFY_INSTALL_REGION: MerchantRegion | undefined = (() => {
    const r = process.env.SHOPIFY_INSTALL_REGION;
    return r === "us" || r === "eu" || r === "uk" || r === "other" ? r : undefined; // no silent default
  })();
  // D2 — D1's `SHOPIFY_INSTALL_REGION !== MERCHANT_REGION` boot warning WAS REMOVED HERE, because the
  // defect it reported no longer exists and leaving it would be a false alarm about a correct config.
  //
  // D1's warning said: a merchant is RECORDED with `SHOPIFY_INSTALL_REGION` but SERVED with
  // `MERCHANT_REGION`, so keep them equal. Since D2 an installed merchant is served with the region on
  // their OWN row — which is the value `SHOPIFY_INSTALL_REGION` wrote — so the two agree by construction
  // and the vars now mean genuinely different things: `SHOPIFY_INSTALL_REGION` is the residency NEW
  // installs are recorded with, `MERCHANT_REGION` is the fallback for tenants with NO row (staging's
  // `demo`). A US-hosted deployment onboarding EU merchants SHOULD now set them differently. Keeping a
  // warning would train operators to "fix" a correct configuration by making it wrong.
  // What still enforces the residency rule: `SHOPIFY_INSTALL_REGION` remains REQUIRED with no default
  // (above), and a row whose region is unusable is REFUSED rather than served (merchant-resolver.ts).
  const SHOPIFY_INSTALL_SCOPES = process.env.SHOPIFY_INSTALL_SCOPES || INSTALL_SCOPES_DEFAULT;
  const SHOPIFY_DELEGATE_SCOPES = (process.env.SHOPIFY_DELEGATE_SCOPES ?? DELEGATE_SCOPES_DEFAULT.join(","))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  // Read at boot for the GATE only (an unprovisioned secret must make the feature absent, not 500 later).
  const shopifyAppSecretPresent = Boolean(await secrets.get(SHOPIFY_APP_SECRET_SCOPE, SHOPIFY_APP_CLIENT_SECRET_NAME));
  // `merchantRegistry` is now constructed MUCH EARLIER (alongside the D1 merchant resolver, which needs
  // it before `createGroundingPort`) — reused here unchanged.
  // B2's store satisfies `MerchantCredentialSink` STRUCTURALLY (`put(tenantId, token, {actor})`), so this is
  // an assignment with no adapter. `createAesGcmCrypto(secrets)` is the same CryptoPort construction
  // widget-memory uses; the `merchant-cred` key scope keeps a memory-key compromise from exposing merchant
  // credentials (crypto-port key separation).
  const merchantCredentials: MerchantCredentialSink | undefined =
    opts?.merchantCredentials ?? createMerchantCredentialStore(store, createAesGcmCrypto(secrets));
  const SHOPIFY_INSTALL_ENABLED = Boolean(
    SHOPIFY_APP_CLIENT_ID &&
      SHOPIFY_INSTALL_REDIRECT_URI &&
      SHOPIFY_INSTALL_REGION &&
      shopifyAppSecretPresent &&
      SHOPIFY_DELEGATE_SCOPES.length > 0 &&
      merchantRegistry &&
      merchantCredentials,
  );

  const app = Fastify({ logger: false });

  if (SHOPIFY_INSTALL_ENABLED) {
    // Idempotent DDL, exactly like the runtime/vector stores' own `migrate()` — one more table in the
    // existing database, never a new cloud resource. Only for the real Postgres adapter; an injected
    // registry (test seam) has no migration.
    registerShopifyInstallRoutes(app, {
      store,
      registry: merchantRegistry!,
      credentials: merchantCredentials!,
      clientSecret: () => secrets.get(SHOPIFY_APP_SECRET_SCOPE, SHOPIFY_APP_CLIENT_SECRET_NAME),
      fetchFn: opts?.installFetch ?? globalThis.fetch,
      clientId: SHOPIFY_APP_CLIENT_ID!,
      redirectUri: SHOPIFY_INSTALL_REDIRECT_URI!,
      requestedScopes: SHOPIFY_INSTALL_SCOPES,
      delegateScopes: SHOPIFY_DELEGATE_SCOPES,
      region: SHOPIFY_INSTALL_REGION!,
      // NN#4 — the SAME `matchedKill` the /chat path reads, so a halt at any of the three scopes
      // (global / tenant / agent) stops an install from beginning or completing.
      killCheck: async (tenantId) => (await matchedKill(store, { tenantId, agentType: RUNTIME_AGENT_TYPE })) !== null,
      // Same per-IP bucket and reserved mint tenant every other public route uses (/widget/token,
      // /shopper/session, the CAA routes) — one rate-limit mechanism, not a second one that could drift.
      checkRateLimit: (ipKey) => underLimit(store, { tenantId: "__mint__" }, `ip:${ipKey}`, RL_IP, RL_WINDOW),
      now: nowSec,
    });
  }

  // ── C2 — the three MANDATORY Shopify compliance webhooks + app/uninstalled ─────────────────────────
  //
  // A NARROWER GATE THAN C1's, deliberately. C1 needs a client id, a redirect URI and a declared
  // residency region because it CREATES merchants; C2 only ever acts on merchants that already exist, so
  // it needs exactly two things:
  //   • the app client secret in the SecretsPort — the SAME secret C1 reads, because Shopify signs
  //     webhook HMACs with the app's client secret (shopify-webhook-identity.ts [W1]). NO NEW ENV VAR and
  //     no new secret to provision.
  //   • a durable MerchantRegistryPort — there is no other way to resolve a shop domain to a tenant or to
  //     revoke one. An in-memory registry is not accepted for the same reason C1 refuses it: it would
  //     forget every revocation on the next cold start while reporting 200 to Shopify.
  // Sharing C1's gate instead would mean that letting the OAuth redirect URI lapse silently stopped
  // honouring GDPR erasure requests for merchants who had already installed — a compliance failure caused
  // by an unrelated config change. So these are separate gates on purpose.
  //
  // WHY THE ROUTES MUST 404 RATHER THAN 500 WHEN UNCONFIGURED. Shopify treats any non-2xx as a failure,
  // retries 8 times over 4 hours, and then DELETES a subscription configured through the Admin API. A
  // half-working endpoint that 500s is therefore worse than an absent one: it burns the retries either
  // way, but a 404 is unambiguous to whoever is debugging the app's configuration.
  const SHOPIFY_WEBHOOKS_ENABLED = Boolean(shopifyAppSecretPresent && merchantRegistry);
  if (SHOPIFY_WEBHOOKS_ENABLED) {
    // Idempotent DDL, and only when C1 has not already run it (an injected registry has no migration).
    registerShopifyWebhookRoutes(app, {
      store,
      registry: merchantRegistry!,
      // The SAME unconditionally-constructed vector port POST /forget erases through, for the same reason
      // it is unconditional there: a shopper's (or a regulator's) right to erase what may already be
      // stored does not depend on whether the memory feature is switched on right now.
      vector: vectorPort,
      clientSecret: () => secrets.get(SHOPIFY_APP_SECRET_SCOPE, SHOPIFY_APP_CLIENT_SECRET_NAME),
      // Same keyed-HMAC secret every other audit subjectRef uses (F7 — never a bare hash of a
      // low-entropy numeric customer id).
      auditHmacKey: AUDIT_HMAC_SECRET,
      // NN#4 — the SAME `matchedKill` the /chat, /forget and install paths read, so a halt at any of the
      // three scopes (global / tenant / agent) stops a DESTRUCTIVE erasure. It deliberately does NOT stop
      // `app/uninstalled` from making a merchant inert — see that handler's own note.
      killCheck: async (tenantId) => (await matchedKill(store, { tenantId, agentType: RUNTIME_AGENT_TYPE })) !== null,
      // Same per-IP bucket and reserved mint tenant every other public route uses — one rate-limit
      // mechanism, not a second one that could drift.
      checkRateLimit: (ipKey) => underLimit(store, { tenantId: "__mint__" }, `ip:${ipKey}`, RL_IP, RL_WINDOW),
      now: () => Date.now(),
    });
  }

  // `store`/`vector` surface which adapter is actually live (security review, MEDIUM — same rationale as
  // the [boot] log line above): "postgres" in every real deploy (DATABASE_URL set), "memory" only in
  // local/dev/test, "injected" only under a test that supplies its own store/vectorPort.
  // `merchants` (D1) surfaces WHERE tenancy is resolved from, for the same reason `store`/`vector` surface
  // which adapter is live: "registry+env" in a real deploy (a durable registry, with the named
  // `WIDGET_EMBED_KEYS` fallback still armed for merchants that have no row — e.g. staging's `demo`), "env"
  // in local/dev/e2e (no DATABASE_URL ⇒ no registry). It is the FLAG half of requirement 3: the fallback is
  // never silent, and an operator can confirm the posture without reading the deploy workflow. Non-secret —
  // it names a mode, never a key, a tenant or a domain.
  app.get("/health", async () => ({ ok: true, model: modelName, store: runtimeResult.kind, vector: vectorResult.kind, merchants: merchants.resolutionMode }));

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
    // D1 — THE CUTOVER POINT. The tenant now comes from the MERCHANT REGISTRY first and the
    // `WIDGET_EMBED_KEYS` env map only as a named, logged, audited fallback (merchant-resolver.ts holds the
    // whole precedence rule). Every one of the four non-`ok` outcomes ends in the SAME 401 with the SAME
    // body: a revoked merchant, an unknown key, a blank key and an unreadable registry must not be
    // distinguishable from outside, or this endpoint becomes an oracle for which merchants exist and which
    // were suspended (the same reason C1's callback has one uniform refusal — routes/shopify-install.ts:467).
    // The server-side log and the audit chain are where the distinction lives.
    const key = (req.query as { key?: string })?.key;
    const resolved = await merchants.resolveEmbedKey(key, "embed-key-mint");
    if (resolved.kind !== "ok" || !WIDGET_TOKEN_SECRET) {
      reply.code(401);
      return { error: "invalid or unconfigured embed key" };
    }
    return { token: mintWidgetToken(WIDGET_TOKEN_SECRET, resolved.tenantId, WIDGET_TOKEN_TTL_SECONDS), expiresInSeconds: WIDGET_TOKEN_TTL_SECONDS };
  });

  // ADR-0019 Revision 2, Task 3 — `POST /widget/guest`: MINT or RENEW the signed guest identity token.
  // Its OWN route (never the cacheable GET /widget/token — R2-6, F-6): a per-visitor secret must not share
  // a response with a per-tenant one. `Cache-Control: no-store` always. The token's tenant comes from the
  // VERIFIED widget token (never a client value — C1/R2-5); no valid widget token ⇒ 401. LAZY (R2-6/F-7):
  // mints only when the tenant's memory posture is live — off everywhere today, so it issues nothing,
  // keeping a durable identifier from being handed out pre-consent for a dormant feature. NO PER-SUBJECT
  // STORE WRITE (F-14/invariant 11): pure HMAC; the only store touch is the fail-open per-IP rate counter,
  // which is not per-subject. MINT vs RENEW (R2-3): a presented VALID own-tenant token is renewed (same
  // aid, new exp); anything else — absent, expired, wrong-tenant, forged — is a FRESH mint (a new guest),
  // never a renewal of a token this browser cannot prove.
  app.post("/widget/guest", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const xff = req.headers["x-forwarded-for"];
    const ipKey = clientIpKey(Array.isArray(xff) ? xff[0] : xff, req.ip);
    try {
      if (!(await underLimit(store, { tenantId: "__mint__" }, `ip:${ipKey}`, RL_IP, RL_WINDOW))) {
        reply.code(429);
        return { error: "rate limited" };
      }
    } catch {
      /* fail-open: minting is a pure HMAC, and the write path (/chat) is separately capped */
    }
    // Tenant comes from the verified widget token ONLY — a guest id must be bound to a verified tenant,
    // never the RUNTIME_TENANT fallback.
    const authHeader = req.headers["authorization"];
    const widgetToken = typeof authHeader === "string" && authHeader.startsWith("Bearer ") ? authHeader.slice(7) : undefined;
    const merchantPrincipal = await widgetIdentity.authenticate(widgetToken);
    if (merchantPrincipal.kind !== "merchant") {
      reply.code(401);
      return { error: "a valid widget token is required to mint a guest identity" };
    }
    const tenantId = merchantPrincipal.merchantId;
    // LAZY: no mint unless memory is live AND a guest secret is provisioned. Both are false today, so this
    // returns `{enabled:false}` and issues no identifier — the inert state R2-6 requires.
    if (!memoryServiceEnabled || !GUEST_TOKEN_SECRET) {
      return { enabled: false };
    }
    // RENEW if the caller presents a VALID own-tenant token (verify enforces signature+typ+tid+expiry);
    // otherwise MINT fresh. `verify(..,{tenantId})` rejects a foreign-tenant or expired token, so those
    // fall through to a fresh mint bound to THIS tenant (C3) rather than renewing something unprovable.
    const presented = (req.body as { guestToken?: unknown } | undefined)?.guestToken;
    if (typeof presented === "string" && presented) {
      const claims = await guestIdentity.verify(presented, { tenantId });
      // ADR-0019 Task 5 / R2-7 (IC-1): NEVER renew a REVOKED aid — renewing would resurrect a credential
      // the shopper invalidated via forget-me (a stolen copy would keep working forever by refreshing before
      // each expiry). A revoked (or unconfirmable) aid falls through to a FRESH mint: the browser gets a new,
      // empty anonymous identity instead of the revoked one. FAIL CLOSED on a store error — minting fresh is
      // always safe (it never hands back the revoked aid), so an outage degrades to "always mint", never
      // "renew a revoked token".
      let revoked = true;
      if (claims) {
        try {
          revoked = await isGuestRevoked(store, { tenantId, anonId: claims.anonId });
        } catch {
          revoked = true;
        }
      }
      if (claims && !revoked) {
        const renewed = renewGuestToken(GUEST_TOKEN_SECRET, presented, GUEST_TOKEN_TTL_SECONDS);
        if (renewed) return { anonId: renewed.anonId, guestToken: renewed.token, expiresInSeconds: GUEST_TOKEN_TTL_SECONDS };
      }
    }
    const minted = mintGuestToken(GUEST_TOKEN_SECRET, tenantId, GUEST_TOKEN_TTL_SECONDS);
    return { anonId: minted.anonId, guestToken: minted.token, expiresInSeconds: GUEST_TOKEN_TTL_SECONDS };
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
    // D1 — no shopper session is minted on a store that is no longer served. 404 (not 401): the feature is
    // absent for this merchant, exactly as it is when SHOPPER_AUTH is off, and the shopper learns nothing
    // about why. A widget token minted before the revocation is what makes this check necessary — it stays
    // cryptographically valid for up to WIDGET_TOKEN_TTL_SECONDS.
    if ((await merchants.servability(merchantPrincipal.merchantId, "shopper-session")).kind !== "servable") {
      reply.code(404);
      return { error: "not found" };
    }
    // shop-domain -> tenant reverse lookup, now through the resolver (registry first, `SHOPIFY_STORES` as
    // the named fallback). A ONE-ENTRY map on purpose: `verifyShopifyAppProxyShopper` only ever accepts a
    // `shop` that resolves to `expectedTenant` (shopify-shopper-identity.ts:132-133), so resolving just THIS
    // tenant's own host is behaviourally identical for the accept case and strictly narrower otherwise — no
    // other merchant's domain is even in the map to be matched. `resolveTenant` is sync by contract, so the
    // async lookup happens here, once, rather than pushing async into that verifier.
    const expectedDomain = await merchants.shopDomainFor(merchantPrincipal.merchantId);
    const reverseDomains: Record<string, string> = Object.create(null); // null-proto: no __proto__ pollution
    if (expectedDomain) reverseDomains[expectedDomain.toLowerCase()] = merchantPrincipal.merchantId;
    // Preserve repeated-key arrays (Shopify signs them comma-joined) so a legitimately-signed request
    // isn't rejected; non-string junk is dropped. Semantic fields are still single-value-guarded downstream.
    const params = normalizeAppProxyQuery(req.query as Record<string, unknown>);
    const principal = await verifyShopifyAppProxyShopper(params, {
      expectedTenant: merchantPrincipal.merchantId,
      // Lowercased on both sides: hosts are case-insensitive and the registry stores a canonical lowercase
      // form (postgres-merchant-registry.ts:220-222). Strictly bounded either way — the verifier still
      // requires the result to equal `expectedTenant`.
      resolveTenant: (shop) => {
        const host = shop.toLowerCase();
        return Object.hasOwn(reverseDomains, host) ? reverseDomains[host] : undefined;
      },
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
    // Authorization header, so accept the publishable embed key via ?key= (resolved through the merchant
    // resolver, exactly like /widget/token) OR a Bearer widget token (fetch callers). The embed key is publishable
    // and only NAMES the tenant — the OAuth state/PKCE + the shop's own auth protect the flow.
    // D1 — the `?key=` branch goes through the SAME resolver `/widget/token` uses (registry first, env as
    // the named fallback, revoked ⇒ refused), and the Bearer branch gets the per-request servability check,
    // so neither transport can start an OAuth flow for a merchant that is no longer served.
    const keyParam = (req.query as { key?: string })?.key;
    let tenant: string | undefined;
    if (typeof keyParam === "string" && keyParam) {
      const resolved = await merchants.resolveEmbedKey(keyParam, "customer-login");
      if (resolved.kind === "ok") tenant = resolved.tenantId;
      // A revoked/unknown/unreadable key deliberately does NOT fall through to the Bearer branch: falling
      // through would let a caller who presents a revoked key AND a stale token slip past the refusal.
      if (resolved.kind !== "ok") {
        reply.code(401);
        return { error: "unauthenticated" };
      }
    } else {
      const authHeader = req.headers["authorization"];
      const widgetToken = typeof authHeader === "string" && authHeader.startsWith("Bearer ") ? authHeader.slice(7) : undefined;
      const merchantPrincipal = await widgetIdentity.authenticate(widgetToken);
      if (merchantPrincipal.kind === "merchant") {
        if ((await merchants.servability(merchantPrincipal.merchantId, "customer-login")).kind !== "servable") {
          reply.code(401);
          return { error: "unauthenticated" };
        }
        tenant = merchantPrincipal.merchantId;
      }
    }
    if (!tenant) {
      reply.code(401);
      return { error: "unauthenticated" };
    }
    // Registry-first shop domain (`undefined` covers both "revoked" and "not configured" — both mean 404).
    const shopDomain = await merchants.shopDomainFor(tenant);
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
  // tenantId is derived the EXACT same server-trusted way `/chat` derives it — from the verified widget
  // token (falling back to RUNTIME_TENANT during the same rollout window /chat uses), NEVER a
  // client-supplied tenant.
  //
  // CORRECTED (this comment previously overclaimed): the `anonId` need only pass the SAME `validateAnonId`
  // charset/length bound `/chat`'s `signals.anonId` does — that proves the string is well-FORMED, never
  // that the caller HOLDS/owns it, so on its own this does NOT stop a caller from recording consent for
  // an arbitrary well-formed anonId belonging to someone else (the guest anonId remains the same
  // bearer-capability caveat as `/forget`'s own doc comment below). What actually stops that for a
  // SIGNED-IN shopper is subject-scoped auth just below (`verifiedShopperIdFor`/`memorySubjectId`): a
  // verified principal's account subject wins outright and any supplied anonId is ignored. `recordConsent`
  // (runtime-consent-store.ts) audits the write atomically inside its own transaction — no separate audit
  // call needed here.
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
      /** Mirrors /chat's dual-transport fallback for the x-shopper-token header (subject-scoped auth). */
      shopperToken?: string;
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

    // SUBJECT-SCOPED AUTH — a server-VERIFIED shopper's consent is recorded against `acct:<shopperId>`,
    // never against whatever `anonId` the caller typed; a supplied anonId is IGNORED (not rejected) for
    // such a shopper, exactly like ADR-0017's tenantId/shopperId precedence, because a signed-in
    // shopper's browser legitimately still holds its old guest id. An anonymous guest keeps the anonId
    // path unchanged. This is what stops someone holding another shopper's anonId from setting THEIR
    // consent.
    const verifiedShopperId = await verifiedShopperIdFor(principal, tenantId, req.headers["x-shopper-token"], body.shopperToken);
    // Task 4: guest subject from the VERIFIED x-guest-token, never body.anonId (invariant 4).
    const subject = memorySubjectId({ verifiedShopperId, rawAnonId: await guestAnonIdFrom(req, tenantId) });
    const isTriStateConsent = (v: unknown): v is Consent => v === "in" || v === "out" || v === "unknown";
    if (!subject || !isTriStateConsent(body.memoryOrdinary) || !isTriStateConsent(body.memorySpecial)) {
      reply.code(400);
      return { error: "invalid anonId or consent value" };
    }

    // `source: "shopper"` — an explicit choice the shopper made, as distinct from the server-derived
    // guest-merge write on /chat (Finding 2). Required, so no call site can silently misattribute.
    await recordConsent(store, { tenantId, anonId: subject, memoryOrdinary: body.memoryOrdinary, memorySpecial: body.memorySpecial, hmacKey: AUDIT_HMAC_SECRET, source: "shopper" });

    // BLOCK-A (governance review round 6) — DELIBERATELY NOT FIXED HERE. Recorded as checklist residual
    // C14; the real fix is B12's server-side guest->account link, which does not exist.
    //
    // The defect: the /chat merge is one-directional, so on an UNVERIFIED turn the subject is the guest
    // anonId, the acct: row is never consulted, and the US opt-out regime reads an unresolved "unknown"
    // as ALLOWED — an authenticated opt-out does not govern that same browser's signed-OUT turns (the
    // shopper token is sessionStorage, 1h TTL, so a new tab reverts them to guest). This PR created the
    // class: pre-PR the signed-in write landed on the guest row itself.
    //
    // Three successive attempts to fix it HERE were each rejected in review, and the pattern is the
    // point: governing a signed-OUT browser requires trusting a CLIENT-SUPPLIED anonId, which is exactly
    // what subject-scoped auth exists to stop.
    //   1. restrictive-only propagation -> made the ordinary signed-in toggle OFF->ON leave memory OFF
    //      while the panel rendered ON, because the manage panel posts only on change (round 7 BLOCK-1 /
    //      B-1); it also left destructive forget-me as the only escape the UI could express, re-creating
    //      the harmful advice round 5 removed.
    //   2. it also failed open silently with no repair path, so one transient error reopened the hole
    //      (B-2), and it only ever governed the single anonId presented in that one call (B-3).
    //   3. symmetric propagation removed the trap but broke this PR's founding property — "a supplied
    //      anonId is IGNORED for a verified shopper" — by writing to it, and dissolved the order
    //      semantics the reversal path documents.
    // Shipping the hole DISCLOSED beats shipping a fix that contradicts the control it is bolted onto.
    //
    // Answer with the EFFECTIVE state the values just recorded produce, so the widget's manage panel can
    // render what is true without re-implementing the region regime client-side. It must not: the panel
    // binding its checkbox to `consent === "in"` is exactly how it came to render "off" for the US
    // opt-out regime's ACTIVE "unknown" (see manage-panel-honesty.test.ts). Same function, same region
    // source as /chat's own `memoryActive` and the `remember()` gate.
    //
    // D2 — THAT SOURCE IS NOW THIS MERCHANT'S OWN REGION, not the process's. It has to be: `"unknown"` is
    // the ONE input whose meaning is regime-dependent (`consentPermits` — US reads it as allowed, every
    // other region as not), and it is precisely the value a shopper who never answered the prompt carries.
    // Reporting the process default here while /chat reported the merchant's would make the manage panel
    // and the turn that follows it disagree about the same shopper.
    //
    // THIS ENDPOINT IS NOT GATED ON SERVABILITY (D1: withdrawal must outlive the install), so it must
    // still answer for a revoked merchant, an unregistered tenant and an unreadable registry. In all three
    // there is no merchant-declared region to use, and `consentRegionFor` resolves to the STRICTEST
    // regime rather than guessing — the fail-closed direction for a consent answer.
    //
    // SCOPE: this is the state for the subject THIS call recorded against — `acct:<shopperId>` when
    // signed in, the guest anonId otherwise. It is not a promise about a later turn under a different
    // principal: once the shopper's token expires, their signed-OUT turns are governed by the guest
    // record alone (residual C14, accepted 2026-08-04), and /chat's own `memoryActive` on that turn
    // reports that lower state. The panel follows whichever came last, so it tracks the subject actually
    // being served rather than the last one the shopper authenticated as.
    return {
      ok: true,
      memoryActive: (({ mayWriteOrdinary, mayWriteSpecial }) => ({ ordinary: mayWriteOrdinary, special: mayWriteSpecial }))(
        decideMemoryWrite({
          region: await consentRegionFor(tenantId),
          consent1: body.memoryOrdinary,
          consent2: body.memorySpecial,
        }),
      ),
    };
  });

  // PR-11b (ADR-0015 Inv 5 — right-to-erasure) — the shopper-facing data-RIGHTS endpoint: erase THIS
  // subject's durable memory via `eraseSubject` (widget-memory/src/erasure.ts, reused unchanged). The
  // (tenantId, anonId) pair is derived the EXACT same server-trusted way `/consent` derives it — tenantId
  // from the verified widget token (falling back to RUNTIME_TENANT), anonId bound by the SAME
  // `validateAnonId` charset/length check.
  //
  // Security review (Finding 3 — MEDIUM, corrected: this previously overclaimed subject-scoped auth).
  // What the widget-token coupling actually enforces is TENANT scope, not subject scope: the token is
  // mintable by ANY caller who holds the tenant's PUBLIC embed key (server.ts's own /widget/token doc
  // comment — the key "is NOT a secret"), so this endpoint is reachable by any internet visitor for that
  // tenant, against ANY anonId they can obtain — `validateAnonId` only checks charset/length, it does not
  // bind the anonId to the caller. Within a tenant, the anonId functions as an UNGUESSABLE BEARER
  // CAPABILITY (128 bits of randomness — identity.ts `generateGuestId`), not a cryptographically-bound
  // subject credential: practical impact is bounded to a shopper whose anonId leaks (shared device,
  // storefront XSS), not to blind guessing.
  //
  // CORRECTED (subject-scoped auth, PR #152 — this paragraph previously said subject-bound authorization
  // was "NOT built here"; it now is, immediately below): when the caller presents a valid
  // `x-shopper-token`, `verifiedShopperIdFor`/`memorySubjectId` bind the subject to `acct:<shopperId>`
  // and the anonId above is ignored entirely — closing exactly the gap this paragraph used to describe.
  // This does NOT close the general case above: the token is never REQUIRED here, so an unauthenticated
  // caller (or one who simply omits the header) still falls back to the bearer-capability anonId path,
  // unchanged. See identity.ts `memorySubjectId`'s own doc comment and docs/MEMORY-GO-LIVE-CHECKLIST.md's
  // C1/C2 rows for the exact boundary. Guarded exactly like `/consent`: per-IP + per-tenant rate limit
  // (429) and the NN#4 operator kill switch (503).
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
    const body = (req.body ?? {}) as {
      anonId?: unknown;
      widgetToken?: string;
      /** Mirrors /chat's dual-transport fallback for the x-shopper-token header (subject-scoped auth). */
      shopperToken?: string;
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

    // SUBJECT-SCOPED AUTH — same derivation as /consent and /chat. This endpoint is DESTRUCTIVE, so it is
    // the one that most needed it: for a server-verified shopper the PRIMARY target is `acct:<shopperId>`,
    // derived server-side, and it is always erased.
    //
    // CORRECTED (2026-08-05, verified by reading this handler end to end): this comment previously
    // concluded "so a caller can only ever erase their OWN subject." That is FALSE as written, and it
    // contradicted this file's own code and comments ~30 lines apart in two ways:
    //   (i) the shopper token is never REQUIRED here — an unauthenticated caller (or one who simply omits
    //       the header) still reaches the guest path below with any well-formed anonId they hold. That is
    //       the accepted C1 bearer-capability residual the paragraph ABOVE this one already states plainly
    //       (named-owner decision, 2026-08-04, docs/MEMORY-GO-LIVE-CHECKLIST.md C1); and
    //  (ii) on a VERIFIED turn the N1 block below deliberately ALSO erases a co-presented anonId, which
    //       the server cannot distinguish from the caller's own — see its own comment for why that is a
    //       safe trade rather than a new capability.
    // What IS true and load-bearing, and is now pinned at the route level by
    // consent-forget-account-namespace-unreachable.test.ts: the client-supplied `anonId` can only ever
    // name a GUEST subject. `memorySubjectId` routes it through `validateAnonId`'s base32 charset
    // (widget-memory/src/identity.ts), which admits no `:` and no lowercase — so no `acct:<shopperId>` id
    // and no `::` namespace-injection string can pass. That boundary is what keeps C1's accepted exposure
    // at "a 128-bit CSPRNG guest id" instead of the ENUMERABLE account subject of every signed-in shopper.
    const verifiedShopperId = await verifiedShopperIdFor(principal, tenantId, req.headers["x-shopper-token"], body.shopperToken);
    // Task 4: guest subject from the VERIFIED x-guest-token, never body.anonId (invariant 4). Derived once
    // and reused for the guest-era erase below.
    const guestTokenAnonId = await guestAnonIdFrom(req, tenantId);
    const subject = memorySubjectId({ verifiedShopperId, rawAnonId: guestTokenAnonId });
    if (!subject) {
      reply.code(400);
      return { error: "no verified subject to forget" };
    }

    await eraseSubject({ vector: vectorPort, audit: store, hmacKey: AUDIT_HMAC_SECRET }, { tenantId, anonId: subject });
    // N1 fix (security review round 3, HIGH) — a verified shopper's GUEST-ERA facts previously sat in a
    // namespace this endpoint never touched: `subject` above is `acct:<shopperId>` for a signed-in
    // shopper and a supplied `anonId` was IGNORED entirely, so `/forget` erased the account namespace
    // only while the shipped widget's own `forgetMe()` still sends the shopper's just-superseded guest
    // anonId in the SAME request body (`prevAnonId`, index.html) — meaning real erasure silently stopped
    // short of what the UI promised ("Done — I've cleared what I remembered"). This is SAFE, not a
    // repeat of the C1 delete attack: the guest path a few lines above already lets an *unauthenticated*
    // caller erase ANY well-formed anonId they hold with no token at all, so erasing a caller-presented
    // anonId on a VERIFIED turn grants an attacker nothing they could not already get by omitting the
    // token entirely. Only fires when the presented `anonId` is (a) well-formed (`validateAnonId`) and
    // (b) actually a DIFFERENT namespace from the account subject (a guest calling /forget with no
    // shopper token already goes through the `subject` erase above and must not double-audit itself).
    if (verifiedShopperId && guestTokenAnonId && guestTokenAnonId !== subject) {
      // The guest-era namespace, named by the VERIFIED guest token (not a client string), erased on the
      // same signed-in /forget so the UI's "I've cleared what I remembered" is true across both subjects.
      await eraseSubject({ vector: vectorPort, audit: store, hmacKey: AUDIT_HMAC_SECRET }, { tenantId, anonId: guestTokenAnonId });
    }
    // ADR-0019 Task 5 / R2-7 (invariant 8): forget-me REVOKES the guest credential it just erased. Rotating
    // away from a token must actually invalidate it, not leave a working copy in a thief's hands — after this,
    // `guestAnonIdFrom` and the RENEW path both see the aid as revoked and yield anonymous / mint fresh. Keyed
    // on the VERIFIED guest aid ONLY (never body.anonId — that would be a C10 denial primitive — and never the
    // `acct:` subject, which is not a guest token). Written AFTER the erase: the erase is the load-bearing
    // data-rights guarantee; revocation is anti-theft hardening layered on top. Best-effort on a store error —
    // a failed revoke never un-erases, and a 500 here would falsely tell the shopper the erase failed.
    if (guestTokenAnonId) {
      try {
        await revokeGuest(store, { tenantId, anonId: guestTokenAnonId, hmacKey: AUDIT_HMAC_SECRET });
      } catch {
        /* best-effort: the erase above is the guarantee; the token expires on its own even if this write missed */
      }
    }
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

    // D2 — THE THREE EARLY RETURNS BELOW ANSWER BEFORE A MERCHANT IS RESOLVED, so they report
    // `consentModeFor(undefined)` — the STRICTEST regime — rather than this process's default.
    //
    // Why not the env value: `consentMode` is a statement about a MERCHANT's consent regime, and on these
    // paths there is no merchant to make it about (oversize and unauthenticated fire before the token is
    // read at all; the rate limiter fires after, but deliberately before the registry lookup, so that an
    // unauthenticated flood cannot spend unbounded registry reads — D1's placement, kept). Emitting
    // `opt_out` there would be the US default asserted over a merchant we have not identified, which is
    // the exact shape of the defect D2 removes from the served path. `consentPermits` itself treats an
    // unknown region as the stricter regime (ADR-0015 Inv 3); this is that rule, on the wire.
    //
    // Why not OMIT the field: PR-11b's contract is that these paths carry it
    // (chat-memory-state.test.ts), and an absent field would leave a client's cached value in place —
    // silently keeping a stale, possibly wrong regime rather than replacing it with a safe one.
    //
    // SCOPE OF THE PRACTICAL EFFECT, stated honestly: the shipped widget throws on any non-2xx before it
    // reads the body (`if (!r.ok) throw`, then `onChatMeta(d)` — widget/public/index.html), so it never
    // learns a consentMode from these three responses today. This is about not asserting a falsehood on a
    // public wire contract, not about a live defect in our own client.
    const UNRESOLVED_CONSENT_MODE = consentModeFor(undefined);

    // T5 — input bounds: reject oversized input before any work (bounds the model + the KV keys).
    if (message.length > MAX_MESSAGE_CHARS || sessionId.length > MAX_ID_CHARS || (idemKey && idemKey.length > MAX_ID_CHARS)) {
      reply.code(400);
      return { reply: "Sorry — that message is too long. Could you shorten it?", mode: "support", pitch: "none", escalate: false, flags: ["input_rejected"], memoryEnabled: memoryServiceEnabled, consentMode: UNRESOLVED_CONSENT_MODE };
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
      return { reply: "This assistant needs to be opened from the store page.", mode: "support", pitch: "none", escalate: false, flags: ["unauthenticated"], memoryEnabled: memoryServiceEnabled, consentMode: UNRESOLVED_CONSENT_MODE };
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
    // ADR-0019 task 6 (C13): the SAME resolver /consent and /forget use — no second inline implementation.
    const shopperPrincipal: Principal = await resolveVerifiedShopper(
      principal,
      tenantId,
      req.headers["x-shopper-token"],
      body.shopperToken,
    );

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
      return { reply: "You're sending messages a little too fast — give me a moment and try again.", mode: "support", pitch: "none", escalate: false, flags: ["rate_limited"], memoryEnabled: memoryServiceEnabled, consentMode: UNRESOLVED_CONSENT_MODE };
    }

    // ── D1 — REVOCATION, ENFORCED ON EVERY TURN. This is the property that did not exist before this PR.
    //
    // A widget token is a signed bearer credential with its own TTL (WIDGET_TOKEN_TTL_SECONDS, default 1h),
    // so gating only the MINT would leave an uninstalled merchant served for up to an hour after C2's
    // `app/uninstalled` webhook revoked them — and, before D1, forever, because nothing on this path read
    // `pl_merchant` at all. So the registry is re-checked here, per turn.
    //
    // A DENY-LIST, NOT AN ALLOWLIST (merchant-resolver.ts's header argues this at length): a tenant with NO
    // registry row keeps being served, because that is the `demo` tenant the eval corpus, the e2e suite and
    // the staging smoke gate run against, plus every hand-configured merchant. Only a row that says
    // NOT-`active` refuses.
    //
    // PLACED AFTER the rate limiters (so an unauthenticated flood cannot spend unbounded registry reads) and
    // BEFORE the try/catch below (so a registry fault surfaces as this explicit 403 rather than being
    // absorbed by the generic model-error handler, which returns 200). Fails CLOSED on a registry error —
    // see the resolver header for why, and for what that costs.
    // D2 — this ONE read now also yields the tenant's serving config (`region` + `groundingMode`), so
    // per-merchant residency costs no extra registry round trip on the hot path.
    const servable = await merchants.servability(tenantId, "chat");
    if (servable.kind !== "servable") {
      reply.code(403);
      return {
        // Shopper-facing copy: it says what is true (this assistant is not available here) and promises
        // nothing — no human, no export, no erasure (shopper-promise-guard.ts's claim classes).
        reply: "This shopping assistant isn't available on this store right now.",
        mode: "support",
        pitch: "none",
        escalate: false,
        // THREE DISTINGUISHABLE flags, because they are three different operator problems with three
        // different fixes: a deliberate revocation (`status --status active`), a registry we could not
        // read (a database fault), and — D2 — an active row whose residency we cannot determine
        // (`set --region …`). None is distinguishable to the shopper, whose reply text is identical.
        flags: [
          servable.kind === "revoked"
            ? "merchant_inactive"
            : servable.kind === "region-unset"
              ? "merchant_region_unset"
              : "merchant_unresolved",
        ],
        memoryEnabled: memoryServiceEnabled,
        // A merchant we refuse has no serving regime to report — the strictest, as above.
        consentMode: UNRESOLVED_CONSENT_MODE,
      };
    }
    // From here the merchant IS resolved and servable, so every remaining response reports THEIR regime.
    const servingConfig = servable.config;
    const CONSENT_MODE = consentModeFor(servingConfig.region);

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
      // §8a inv 14 basic-mode-at-cap — read alongside the kill check, from the SAME shared store, so a cap
      // set by the control plane (where spend is actually measured) propagates to every serving instance.
      // Deliberately a separate registry from `kill`: a kill halts and hands off, while at cap the shopper
      // must keep being served. See state-postgres/src/cost-cap-registry.ts.
      const costCap = await matchedCostCap(store, { tenantId });
      // PR-11a (ADR-0015 T12; ADR-0019 task 4) — look up this subject's server-recorded memory-consent
      // BEFORE deriving signals, keyed on `memorySubject` — the SAME server-derived subject
      // deriveServingSignals now uses (the verified x-guest-token's anonId or the shopper's acct: id, NOT
      // a client `signals.anonId`). No subject ⇒ nothing to key a
      // lookup on (mirrors the remember() "no subject key" guard below) ⇒ consentRecord stays undefined
      // ⇒ deriveServingSignals's own `ctx.consent?.… ?? "unknown"` fail-closed default applies.
      // Only reach the consent store when memory is actually live (memoryService constructed). While the
      // double gate is off, the looked-up value is consumed by NOBODY (its sole consumers — remember() and
      // the brain recall path — are gated on the same off memoryService/memoryPort), so the read is pure
      // overhead; skipping it keeps the inert /chat path byte-identical to pre-PR-11a (consentRecord stays
      // undefined ⇒ deriveServingSignals's own `ctx.consent?.… ?? "unknown"` default, i.e. the old hardcode).
      //
      // SUBJECT-SCOPED AUTH (ADR-0019 task 4): the memory subject is `acct:<shopperId>` for a
      // server-VERIFIED shopper, else the anonId of a VERIFIED `x-guest-token` (`guestAnonIdFrom`), and
      // nothing otherwise — a client `signals.anonId`/`body.anonId` is NEVER a subject (invariant 4).
      // Derived ONCE here and reused for the consent lookup, remember(), and the retention
      // sweep below, so all three can never disagree about whose memory this turn touches. Uses
      // `shopperPrincipal` (resolved above from the x-shopper-token, gated on `verified`) rather than
      // anything client-asserted.
      const verifiedShopperId =
        shopperPrincipal.kind === "shopper" && shopperPrincipal.verified ? shopperPrincipal.shopperId : undefined;
      // Task 4: the guest anonId is the VERIFIED x-guest-token claim, never `signals.anonId`.
      const guestAnonId = memoryService ? await guestAnonIdFrom(req, tenantId) : undefined;
      const memorySubject = memoryService
        ? memorySubjectId({ verifiedShopperId, rawAnonId: guestAnonId })
        : undefined;
      // BLOCK-1 fix (security-review remediation, PR #152) — restrictive-merge consent across the
      // guest/account subjects on sign-in (mergeAccountConsent, widget-memory/src/consent.ts — see its
      // own doc comment for the full rationale). Without this, the ACCOUNT subject's consent lookup
      // alone regressed a guest-recorded "out" the instant the shopper signed in: the new `acct:` key
      // has no record yet, degrades to the fail-closed default ("unknown"), and the US opt-out regime
      // reads "unknown" as ALLOWED. The guest record is consulted ONLY when the client ALSO supplied a
      // validated anonId this turn (its own browser-held guest id) — never an unvalidated string, and
      // never merged in for a guest turn (verifiedShopperId absent), where `memorySubject` already IS
      // that same validated anonId and no merge is needed.
      //
      // `validatedGuestAnonId` is hoisted to this outer scope so the restrictive-merge LOOKUP and N2's
      // write-through (both immediately below) resolve the same guest namespace — declared once, used
      // twice, mirroring `memorySubject` itself being derived once and reused (BLOCK-1 comment above).
      // NOTE (corrected twice): an earlier revision said "reused three ways", counting a retention-sweep
      // widening that was attempted and deliberately REVERTED; and it justified the revert as
      // "reintroducing the cross-subject access F1 closed", which security review adjudicated as the WRONG
      // reason — a sweep deletes only already-expired records (a strict subset of what the unauthenticated
      // /forget path already allows), returns nothing to the caller, and never reaches the model, so it
      // violates none of the property F1 protects. The revert stands on different grounds: attributability
      // (an implicit per-turn ttl_sweep against a namespace the caller merely NAMED is not legible to an
      // operator, unlike an erase.subject on a user-initiated /forget) and the fact that proactive
      // reclamation belongs in a scheduled/admin job keyed off SERVER-known subjects. See
      // docs/MEMORY-GO-LIVE-CHECKLIST.md B4. The sweep below still uses `memorySubject` only.
      let validatedGuestAnonId: string | undefined;
      let consentRecord: ConsentRecord | undefined;
      if (memorySubject) {
        const accountRecord = await lookupConsent(store, { tenantId, anonId: memorySubject });
        // Task 4: the guest side of the restrictive merge is the SAME verified-token anonId, consulted
        // only when a shopper is signed in (a guest turn's `memorySubject` already IS that anonId).
        validatedGuestAnonId = verifiedShopperId ? guestAnonId : undefined;
        const guestRecord = validatedGuestAnonId ? await lookupConsent(store, { tenantId, anonId: validatedGuestAnonId }) : undefined;
        const merged = validatedGuestAnonId ? mergeAccountConsent(accountRecord, guestRecord) : accountRecord;
        consentRecord = merged;

        // N2 fix (security review round 3, HIGH) — DURABLE write-through of the RESTRICTIVE ("out")
        // direction only. Without this, the merge above is READ-TIME ONLY: it corrects THIS turn's
        // decision but persists nothing, so an opt-out survives only for as long as the client keeps
        // echoing the exact guest anonId that recorded it — a new device, cleared storage, or the
        // widget's own `forgetMe()` (which mints a fresh anonId, index.html) all silently drop the
        // linkage and the opt-out along with it. Proven by execution (two independent reviews): 0 writes
        // with the echoed anonId, 1 write once it's gone.
        //
        // SAFE DIRECTION ONLY: this can only ever move a tier's durable value TOWARD "out", never adopt
        // an "in". `mergeConsentTier` (consent.ts) returns a value DIFFERENT from `accountRecord`'s own
        // for a tier if and only if the guest side is "out" and the account wasn't already "out" — a
        // guest "in" is never adopted by the merge itself, so there is no code path here that could ever
        // write a guest-sourced "in" onto the account (that would let anyone borrow a stranger's opt-in
        // merely by holding/guessing their anonId post sign-in). See consent-restrictive-merge.test.ts's
        // "guest 'in' is NEVER adopted" case, which this write-through must not (and does not) affect.
        //
        // IDEMPOTENT: the diff check means this only fires on the turn a NEW restriction is discovered —
        // once written, the next lookup's `accountRecord` already equals `merged`, so there is no diff
        // and no re-write on every subsequent turn.
        //
        // GATED: only reachable when `memorySubject` exists, i.e. `memoryService` is constructed (the
        // double gate is on) — this never runs while memory is off. `!kill` gives NN#4 parity: a halted
        // tenant/agent gets no write, durable or otherwise (regression-locked by the NN#4 test).
        // DELIBERATE DIFFERENCE (security review, round 3 — the earlier claim that this "mirrors every
        // other audited memory write on this path" was inaccurate): the other two writes below also carry
        // `!d.flags.includes("no_autonomous_action")`, this one does not, so it still fires on a
        // guardrail-halt turn (e.g. `giveaway_declined`, brain.ts). That is intentional and safe here
        // BECAUSE the write is strictly RESTRICTIVE — it can only ever persist an "out" (mergeConsentTier
        // never adopts a guest "in"), so letting it through on a halted turn protects the shopper rather
        // than acting on their behalf. Suppressing it would DELAY honoring an opt-out, which is the wrong
        // direction. The kill switch still overrides everything.
        // Inherits /chat's own per-session/IP/tenant rate limiting (`allowRequest`, checked earlier in
        // this handler) — this is a side effect of an already-rate-limited call, not a new endpoint, so
        // no separate budget is introduced here.
        //
        // RESIDUAL (documented, not fixed here — see docs/MEMORY-GO-LIVE-CHECKLIST.md C7): because "out"
        // always wins outright and is now durable, a stale guest "out" record can permanently override a
        // LATER authenticated `/consent` "in" for the same tiers, for as long as the client keeps
        // presenting that stale guest anonId — a strictly more privacy-conservative failure mode than
        // before (durable rather than merely per-turn), but not a fix for that separate, pre-existing gap.
        if (
          validatedGuestAnonId &&
          !kill &&
          (merged.memoryOrdinary !== accountRecord.memoryOrdinary || merged.memorySpecial !== accountRecord.memorySpecial)
        ) {
          try {
            await recordConsent(store, {
              tenantId,
              anonId: memorySubject,
              memoryOrdinary: merged.memoryOrdinary,
              memorySpecial: merged.memorySpecial,
              hmacKey: AUDIT_HMAC_SECRET,
              // Finding 2 — mark this as SERVER-derived, so the immutable log distinguishes a consent
              // change the shopper MADE from one the merge INFERRED, and carries a reversal path that is
              // actually achievable for this entry (the shopper-facing one is false here — see C7).
              source: "guest-merge",
            });
          } catch (e) {
            // PII-free: the error's CLASS only, never `.message` — a store/PG error can embed the KV key
            // (`acct:<shopperId>`). Matches retention.ts's codified rule and the sweep's own catch below.
            console.error(`[/chat] consent write-through error tenant=${tenantId} error=${e instanceof Error ? e.constructor.name : typeof e}`);
          }
        }
      }
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
      // T1 phase 2 — server-side guard classification for THIS turn, run BEFORE deriveServingSignals so the
      // result is server-authored and unspoofable. Runs only when SERVER_GUARD_SIGNALS is on (⇒
      // guardClassifierModel defined), never while halted, and never on an empty/proactive turn (no message
      // to classify). classifyGuardSignals never throws — a failure returns a degraded result (no signal ⇒
      // the brain falls back to its keyword floor).
      const guardSignals =
        guardClassifierModel && !kill && !costCap && message.trim() !== ""
          ? await classifyGuardSignals(guardClassifierModel, message, tenantId)
          : undefined;
      const signals: Signals = deriveServingSignals(body.signals, {
        tenantId,
        kill: Boolean(kill),
        atCap: Boolean(costCap),
        // T1 — server-authored guard signals (undefined ⇒ deriveServingSignals omits the keys, so the
        // flag-off path stays byte-identical). `safetyClass` is undefined when the classifier said "none".
        serverSafetyClass: guardSignals?.safetyClass,
        serverInjection: guardSignals?.injection,
        // broaden — the same classifier's whitelisted support intent (undefined when it said "general" /
        // was out-of-enum / it failed ⇒ key omitted ⇒ brain's keyword classifier decides, byte-identical).
        serverSupportIntent: guardSignals?.supportIntent,
        // E4 — THE SECOND GATE. `cartLineItemsEnabled` appears twice by design: here it decides whether a
        // client's `cartItems` is PARSED AT ALL (parsing untrusted input is its own attack surface), and in
        // `createBrain` above it decides whether the parsed value is CONSUMED. One env var must open both,
        // or the feature is half-on: parsed and ignored, or consumed and never supplied.
        cartLineItemsEnabled: CART_LINE_ITEMS,
        // D2 — THIS MERCHANT's residency and grounding posture (their `pl_merchant` row when they have
        // one, the named env fallback when they do not), never the process's. `signals.region` is what
        // `memoryConsentInputs` below feeds to `decideMemoryWrite`, so this line is the actual consent
        // gate moving, not just a label.
        region: servingConfig.region,
        groundingMode: servingConfig.groundingMode,
        // ADR-0017 — server-verified only (never body.signals.shopperId, which deriveServingSignals never
        // reads anyway): undefined when shopperPrincipal stayed anonymous (SHOPPER_AUTH off, no/invalid
        // token, or the F1 re-binding check above failed).
        shopperId: shopperPrincipal.kind === "shopper" ? shopperPrincipal.shopperId : undefined,
        shopperVerified: shopperPrincipal.kind === "shopper" ? shopperPrincipal.verified : undefined,
        consent: consentRecord,
        // The SAME subject the consent lookup above used — so recall, remember(), the sweep and the
        // consent gate all key off one namespace (security review F1/F2).
        memorySubject,
      });

      // The ONE consent input set for this turn. `remember()`'s gate below and the `memoryActive` the
      // client is told (response, further down) BOTH read from this object — they cannot disagree,
      // because there is only one of them. Deliberately not two parallel expressions: the panel
      // contradicting the write path is precisely the defect this exists to fix, and a duplicated
      // `?? "unknown"` is exactly how it would come back.
      const memoryConsentInputs = {
        region: signals.region,
        consent1: signals.consent?.memoryOrdinary ?? "unknown",
        consent2: signals.consent?.memorySpecial ?? "unknown",
      };

      // What the shopper's OWN recorded choice permits, in their region — the truth the widget's
      // "What I remember" panel must render instead of its localStorage echo of the last box they
      // ticked. Rendering `consent === "in"` client-side is WRONG in the default US region, where
      // `decideMemoryWrite`'s ordinary rule is the opt-out regime `!== "out"`: the tri-state "unknown"
      // means memory is ON while an unticked box reads as off, for every US shopper who never answered
      // the prompt. Same lookup, same merge, same function as the write gate (widget-memory/src/
      // consent.ts) — see manage-panel-honesty.test.ts, which asserts this field against the actual
      // upsert count on the same turn rather than against itself.
      //
      // SCOPE, precisely: this reports the CONSENT decision, not a promise about any individual turn.
      // The kill switch and a guardrail halt (`no_autonomous_action`) both still suppress the write
      // below without changing what the shopper consented to — an operator halt is not the shopper's
      // setting and must not silently flip their toggle. Pinned by the kill-switch case in that test.
      //
      // Absent (undefined) whenever memory is not live for this turn, which `JSON.stringify` (Fastify's
      // default serializer — no route schema here) drops from the wire entirely, keeping the response
      // byte-identical to before this change while the double gate (flag.ts) is off.
      const memoryCapability = memoryService && memorySubject ? decideMemoryWrite(memoryConsentInputs) : undefined;
      const memoryActive = memoryCapability
        ? { ordinary: memoryCapability.mayWriteOrdinary, special: memoryCapability.mayWriteSpecial }
        : undefined;

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
      //
      // `level` comes from the SERVING POLICY (canary's when bucketed, else the promoted champion's) and
      // is what makes the dial real. It used to be omitted, so `createSession` fell back to "balanced" and
      // INV-E's pitch budget was permanently 2 no matter what had been promoted — measured 2/2/2 across
      // cautious/balanced/confident. Because `Policy` carries only `styleDirective` + `proactivityDefault`
      // (ADR-0014), that inert dial was half of everything the self-improvement pipeline can produce: a
      // proactivity candidate showed no difference in shadow/canary, passed the gate looking safe, then
      // changed nothing on promotion.
      //
      // Server-derived on purpose. `proactivityLevel` is an autonomy lever, so `deriveServingSignals`
      // omits it from client input (signals.ts) and this is now the ONLY route by which it is set — a
      // shopper still cannot widen their own pitch budget.
      const session = await createSession(brainFor(tenantId, policy), {
        sessionId,
        store: sessions,
        autoPersist: false,
        level: policy.proactivityDefault,
      });
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

      // §6 INV-D — "Context continuity, offered not pushed": once the detour is genuinely over, offer to
      // resume the preserved browsing topic ONCE, as help rather than a re-pitch.
      //
      // THIS CALL IS THE FIX. `session.resumeOffer()` existed, was unit-tested, and had NO PRODUCTION
      // CALLER — so the offer INV-D specifies had never reached a shopper. Every gate stays inside
      // resumeOffer() (at most once; never while an issue is open, safety is latched, an escalation is
      // pending, or the mood is negative), so wiring it up loosens nothing; it only makes the existing
      // conservative logic reachable.
      //
      // MUST run AFTER send() — send() is what advances browsingContext and clears/records openIssues, so
      // asking before it would gate on the previous turn's state. And it must run BEFORE the tx below,
      // because resumeOffer() sets `resumeOffered = true` and that write has to be committed with the rest
      // of the session state, or a retry would offer again and break the once-only guarantee.
      const resumeOffer = session.resumeOffer();
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
      if (memoryService && memorySubject && !kill && !d.flags.includes("no_autonomous_action")) {
        try {
          await memoryService.remember(
            // `memoryConsentInputs` — the same object the client-facing `memoryActive` is derived from,
            // so what the shopper is TOLD and what is actually gated here are one decision, not two.
            { tenantId, anonId: memorySubject, ...memoryConsentInputs },
            { message, reply: d.reply },
          );
        } catch (e) {
          console.error(`[/chat] memory remember error:`, (e as Error).message);
        }
      }
      // ADR-0015 Inv 4 ("expiry is enforced, not aspirational") — opportunistic PER-SUBJECT retention
      // reclamation. `sweepExpired` (widget-memory/src/retention.ts) physically deletes what TTL-on-read
      // (service.ts recall) only ever HIDES; it had no production caller until now (that module's own
      // doc comment tracked the gap as a go-live item). With the ephemeral dev vector store a process
      // restart wiped everything anyway, so the gap was low-risk; the durable, portable VectorPort
      // adapter (state-postgres) removes that safety net, so an expired fact could otherwise sit in
      // durable storage indefinitely.
      //
      // NOT closed by this sweep (security review, Finding 4 — corrected from an earlier overclaim):
      // (a) the sweep's ONLY predicate is EXPIRY (retention.ts) — a consent-WITHDRAWN Art-9 fact that
      // has not yet expired is not touched here; it merely stops being renewed (service.ts recall) and
      // survives up to its remaining TTL (up to 30 more days). Symmetric erasure-first withdrawal
      // (ADR-0015 Inv 9) is NOT enforced by POST /consent today — `withdrawConsent1`/`withdrawConsent2`
      // (widget-memory/src/erasure.ts) have no production caller; that remains a go-live gap. (b) the
      // sweep is itself capped at retention.ts's SWEEP_QUERY_LIMIT (500) per call, so it cannot
      // GUARANTEE bringing a namespace back under erasure.ts's own enumeration cap — it only deletes
      // what expiry finds among the first 500 records it queries.
      //
      // Deliberately scoped to ONLY the subject already being served THIS turn (`memorySubject`) — never
      // an enumeration of every subject for the tenant (that would be an unbounded scan on the serving
      // path, the exact hazard retention.ts's own comment says a cron/admin-endpoint sweep would need to
      // solve separately). This is genuinely a narrower guarantee than a full periodic sweep: a subject
      // who never returns keeps their expired-but-undeleted fact until *someone* triggers a sweep for
      // them — TTL-on-read still means it is never served, so Inv 4's SERVING guarantee holds regardless;
      // only the RECLAMATION timing for abandoned subjects is deferred to a future scheduled job (tracked
      // in retention.ts). Fire-and-forget (mirrors the reqCount reclamation block below) so a slow/failing
      // vector call can never delay or break the shopper's reply — but "fail-open for the shopper" must
      // never mean "invisible to the operator" (security review, Finding 1 — HIGH): a swept failure that
      // reaches here (retention.ts's own audit-vs-delete failures are already logged internally; anything
      // ELSE that throws — e.g. the initial vector.query — lands here) is logged with a PII-free signal
      // (tenantId + error class only — never fact text or the raw anonId), never silently swallowed.
      // Kill-switch respectful (NN#4) — a halted tenant/agent gets no background action either, not even
      // benign cleanup. Gated on `memoryService` (this instance's live double gate, INCLUDING the PR-8
      // test seam, so this is provably exercised in tests without waiting on the ADR flip) so it never
      // runs when memory is off.
      //
      // NOT extended to `validatedGuestAnonId` (security review round 3, N1 — considered, reverted).
      // MECHANICALLY, widening this would fail `subject-scoped-memory-auth.test.ts`'s "THE ATTACK
      // (recall)", which asserts the victim namespace is never queried: `sweepExpired` opens with a
      // `vector.query` against whatever namespace the caller attached as `signals.anonId`.
      //
      // But the SECURITY characterization once written here — "reintroducing exactly the cross-subject
      // query that F1's fix closed" — was ADJUDICATED WRONG by security review and is retracted: a sweep
      // deletes only ALREADY-EXPIRED records (a strict subset of what the unauthenticated `/forget` path
      // already permits with no token at all), returns nothing to the caller, and never reaches the model,
      // so it violates none of the property F1 protects (no cross-subject fact text reaching the
      // prompt/reply). The revert stands on DIFFERENT grounds:
      //   (i)  ATTRIBUTABILITY — an `erase.subject` on a user-initiated `/forget` is legible to an
      //        operator; an implicit per-turn `ttl_sweep` against a namespace the caller merely NAMED is
      //        not; and
      //   (ii) proactive reclamation belongs in a scheduled/admin job keyed off SERVER-known subjects,
      //        exactly as retention.ts's own header already says.
      // (Note the mechanical test-failure above is what makes widening a deliberate decision rather than a
      // silent one — it is not itself the security argument.) See docs/MEMORY-GO-LIVE-CHECKLIST.md B4.
      if (memoryService && memorySubject && !kill && !d.flags.includes("no_autonomous_action")) {
        void sweepExpired({ vector: vectorPort, audit: store, hmacKey: AUDIT_HMAC_SECRET }, tenantId, [memorySubject]).catch((e) => {
          console.error(`[/chat] ttl_sweep error tenant=${tenantId} error=${e instanceof Error ? e.constructor.name : typeof e}`);
        });
      }
      // M3 — per-turn telemetry enrichment: the business dimensions (mode/pitch/servedBy/escalate) and
      // end-to-end turn latency the model-port decorator can't see. PII-free (no message/reply). Under
      // the server-derived tenant; fail-open like logTraffic.
      void telemetry
        .record(serving, { kind: "turn", agentType: RUNTIME_AGENT_TYPE, servedBy: policy.id, mode: d.mode, pitch: d.pitch, escalate: d.escalateToHuman, latencyMs: Date.now() - turnStart, ...recommendationTelemetryFields(d) })
        .catch(() => {});
      // T9 — logTraffic is the choke point that redacts message/reply and hashes sessionId at the
      // write boundary (see canary.ts), so no raw shopper PII lands in the shadow-grading log at rest.
      await logTraffic(store, tenantId, { servedBy: policy.id, sessionId, message, reply: d.reply, mode: d.mode, escalate: d.escalateToHuman, killScope: kill?.scope });
      // F11 (NN #5): commit the advanced session state AND its governance-audit record in ONE tx, so
      // the governed state (pitch budget / safety latch) can never advance without its audit on a
      // mid-turn store failure. Both live under the serving tenant. "session" matches session-store.ts.
      const auditEntry = buildAuditInput({ sessionId, messageLength: message.length, servedBy: policy.id, decision: d, killScope: kill?.scope });
      // RETURNED from the tx rather than assigned to an outer `let`: TypeScript does not model the
      // callback as having run, so it narrowed the outer variable to `null` and the anchor line below
      // then read `.seq`/`.hash`/`.at` off type `never` — three errors, and the compiler was right that
      // it could not prove the assignment happened. Returning the value makes the dependency explicit.
      const auditRec = await store.tx(serving, async (t) => {
        await t.put("session", sessionId, session.state, { ttlSeconds: SESSION_TTL_SECONDS });
        const rec = auditEntry ? await t.audit(auditEntry) : null;
        // ADR-0017 T8 — identity-resolution audit (PII-safe, F7 keyed HMAC): only for a turn where the
        // shopper resolved to a server-verified principal (no noise for the anonymous common case,
        // mirrors the governance-relevant-only policy above). AUDIT_HMAC_SECRET is guaranteed configured
        // whenever shopperPrincipal.kind==="shopper" is reachable (see its declaration above).
        if (shopperPrincipal.kind === "shopper" && AUDIT_HMAC_SECRET) {
          await t.audit(
            buildIdentityAuditInput({ shopperId: shopperPrincipal.shopperId, source: shopperPrincipal.source, tenantId, hmacKey: AUDIT_HMAC_SECRET }),
          );
        }
        return rec;
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
      // C1 — the tenant's shop domain, resolved ONLY when this turn actually carries cards, so the extra
      // lookup never runs on the (current, flag-off) card-less path. `shopDomainFor` returns undefined
      // unless grounding is enabled for the tenant, so a non-grounded tenant's cards get no cart link. The
      // wire layer turns it + each card's opaque variantId into a fail-safe cart permalink.
      const cartBase = d.recommendedProductCards?.length ? await merchants.shopDomainFor(tenantId) : undefined;
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
        memoryActive,
        // A SEPARATE field from `reply`, deliberately: INV-D says offered, not pushed, so the shopper's
        // actual answer is never diluted and the widget can render this as a distinct, ignorable
        // affordance. Omitted (not null, not "") when there is nothing to resume, so a truthiness check in
        // the widget cannot render an empty bubble. JSON.stringify drops it, keeping the wire response
        // byte-identical to before on every turn that has no offer.
        resumeOffer,
        // E3 — the cited products, and the display fields a widget renders as cards. Spread LAST and
        // contributing NO KEY unless the decision carried them, so the serialized body of every turn that
        // cites nothing (which is every turn today) is byte-identical to before this line existed —
        // pinned by chat-wire-flag-off.test.ts against a golden captured on the previous commit.
        //
        // These are what the agent CITED, which is weaker than what it recommended: the mechanism cannot
        // see a paraphrase, so it UNDER-REPORTS, and a client rendering these as "everything the
        // assistant suggested" will under-display. They are NOT a billing basis — see
        // recommendation-telemetry.ts.
        ...recommendationWireFields(d, cartBase),
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
