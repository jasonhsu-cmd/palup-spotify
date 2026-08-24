import Fastify from "fastify";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import {
  createBrain,
  createSession,
  DEFAULT_CATALOG_RETRIEVAL_K,
  TURN_EMBED_AGENT_TYPE,
  type Policy,
  type Signals,
  type Consent,
  type Relationship,
} from "@palup/widget-brain";
import { DEFAULT_POLICY, normalizeHistory, OFFER_CHECK_AGENT_TYPE } from "@palup/widget-brain";
import { createCatalogRetriever, CATALOG_RETRIEVAL_AGENT_TYPE } from "./catalog-retriever.js";
import { classifyGuardSignals, GUARD_CLASSIFIER_AGENT_TYPE } from "./guard-classifier.js";
import type { RuntimeStatePort, ModelPort, VectorPort, Principal, MerchantRegion, MerchantRegistryPort, QueuePort, Arm, CartLine, CatalogProductPort, StoreProfilePort } from "@palup/platform-ports";
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
  createInMemoryCatalogProductStore,
  createInMemoryQueue,
  createInMemoryStoreProfileStore,
} from "@palup/platform-ports";
import {
  createMemoryService,
  isMemoryEnabled,
  validateAnonId,
  memorySubjectId,
  eraseSubject,
  withdrawConsent1,
  withdrawConsent2,
  classifyFact,
  sweepExpired,
  mergeAccountConsent,
  decideMemoryWrite,
  ERASURE_TOMBSTONE_COLLECTION,
  tombstoneKey,
  mergeGuestIntoAccount,
} from "@palup/widget-memory";
import { createRuntimeStore, createVectorStore, matchedKill, matchedCostCap, catalogRetrievalEnabledFor, RUNTIME_AGENT_TYPE, recordConsent, lookupConsent, lookupHealthDisclosure, revokeGuest, isGuestRevoked, PostgresMerchantRegistry, PostgresProductFactsStore, PostgresCatalogProductStore, PostgresStoreProfileStore, createMerchantCredentialStore, createAdminTokenStore, accumulateArmTally, type Sql, type ConsentRecord, type AdminTokenStore } from "@palup/state-postgres";
import { ADMIN_SYNC_SCOPES } from "./shopify-webhook-identity.js";
import { createModelPort, createGroundingPort, createCommercePort, createLocalCatalogDecision } from "./model.js";
import { createLocalCatalogGroundingPort } from "./local-catalog-grounding.js";
import { AdminTokenReauthRequiredError } from "./admin-token-refresh.js";
import { runCatalogSyncScheduler, type CatalogSyncSchedulerDeps } from "./jobs/catalog-sync-scheduler.js";
import { createRuntimeSessionStore } from "./session-store.js";
import { deriveServingSignals, classifyDevice } from "./signals.js";
import { deriveLifecycle } from "./lifecycle.js";
import { registerEmbedRoutes, bundleLoader } from "./routes/embed.js";
import { resolveTheme } from "./widget-theme.js";
import { registerStorefrontCatalogRoutes, projectStorefrontCatalog, STOREFRONT_PAGE_LIMIT } from "./routes/storefront-catalog.js";
import { injectStorefrontFirstPage, inlineStorefrontScript } from "./storefront-ssr.js";
// E3 — both functions return `{}` unless the `Decision` already carries cited products, so they are inert
// for any turn E2 did not cite on. They are no longer inert BY CONSTRUCTION: this composition root now
// reads PRODUCT_CITATIONS/PRODUCT_CARDS and can produce such a Decision (see the Wave 4 flag block below).
// The flags still default OFF, so an environment that sets nothing behaves exactly as before.
// See recommendation-telemetry.ts for the not-a-billing-basis constraint that governs the telemetry half.
import { recommendationTelemetryFields, recommendationWireFields, suggestedChipsWireField } from "./recommendation-telemetry.js";
import { buildAuditInput, buildIdentityAuditInput, buildCaaGrantAuditInput, buildCaaRevokeAuditInput, buildCartCheckoutAuditInput, buildOpenerAuditInput } from "./audit.js";
import { createCartPermalinkAdapter } from "./cart-permalink-adapter.js";
import { allowRequest, clientIpKey, underLimit } from "./rate-limit.js";
import { assignCanary, logTraffic } from "./canary.js";
import { readActiveChampion } from "./champion.js";
import { HOLDOUT_PLAY, assignHoldoutArm, holdoutIdentity, holdoutPeriod, readHoldoutConfig, resolveControlPolicy } from "./holdout.js";
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
import { parseStoreDomains, parsePrimaryDomains, resolveStorefrontCredential } from "./merchant-store.js";
import type { StorefrontFetch } from "./shopify-grounding.js";
import { storefrontCatalogPageFetch, storefrontProductByHandleFetch, mapStorefrontToContext } from "./shopify-grounding.js";
import { createBrandNameResolver } from "./brand-cache.js";
import { createMerchantResolver, consentModeFor } from "./merchant-resolver.js";
import { SHOPIFY_APP_CLIENT_SECRET_NAME, SHOPIFY_APP_SECRET_SCOPE, DELEGATE_SCOPES_DEFAULT } from "./shopify-install-identity.js";
import {
  registerShopifyInstallRoutes,
  INSTALL_SCOPES_DEFAULT,
  type MerchantCredentialSink,
} from "./routes/shopify-install.js";
import { registerShopifyWebhookRoutes, WEBHOOK_ROUTES } from "./routes/shopify-webhooks.js";
import { subscribeCatalogReconcile, type ReconcileReason } from "./catalog-webhook-queue.js";
import { subscribeOrderAttribution } from "./order-attribution-queue.js";
import { mintOrderJoinToken } from "./order-join-token.js";
import { createReconcileCoalescer, CATALOG_RECONCILE_COALESCE_MS_DEFAULT } from "./catalog-reconcile-coalescer.js";
import { createPubSubQueue, type PubSubClientLike } from "./pubsub-queue.js";
import { registerPubSubPushRoute, type OidcVerifier } from "./routes/pubsub-push.js";
import { reconcileByReason, runCatalogIndex, shopifyCatalogByIdSource, shopifyCatalogSource } from "./jobs/catalog-index.js";
import { makeMultiTenantCatalogProductAdminSource } from "./jobs/catalog-backfill.js";
import { createChannelHealth } from "./channel-health.js";
import { registerMemoryWritePushRoute } from "./routes/pubsub-push-memory.js";
import { dispatchMemoryWrite } from "./memory-write-dispatch.js";

// Run-time agent identity for the operator Kill Switch. Single-tenant demo for now; when real
// multi-tenancy lands, thread the AUTHENTICATED tenant (from the widget embed key, never the shopper)
// through here and into the brain's tenantId. RUNTIME_AGENT_TYPE ("shopper") is imported from
// @palup/state-postgres so the serving path and the evolution PROMOTION path check the SAME agent-type
// against the kill registry (NN #4) — a single source of truth, no drift.
const RUNTIME_TENANT = "demo";

// Reserved, NON-real-tenant SecretsPort id for the OPT-IN merchant-cred shared base key (self-serve
// install). A real tenant is a lowercased myshopify shop subdomain, which can never start with an
// underscore, so `__shared__` can never collide with one. Only ever passed to `createAesGcmCrypto` as
// `sharedKeyTenantId` when `MERCHANT_CRED_SHARED_KEY_ENABLED=true` — the shared base still derives a
// DISTINCT per-tenant AES key (deriveKey mixes tenantId into HKDF), so cross-tenant isolation holds.
const MERCHANT_CRED_SHARED_KEY_TENANT = "__shared__";

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
// A1b/D2 — the serve-time staleness ceiling default (S3 §D): the money safety net so a hydrated Tier-2
// fact older than this is never quoted. Exported (named, not a magic number) so a silent revert of this
// value — e.g. back to the pre-S3 1h default, which would let a stale price be quoted for up to an hour —
// is caught by a test rather than only by reading the diff.
export const PRODUCT_FACTS_MAX_AGE_MS_DEFAULT = 900_000;
// Input bounds (T5) — reject oversized inputs before any work.
const MAX_MESSAGE_CHARS = posInt("MAX_MESSAGE_CHARS", 4_000);
const MAX_ID_CHARS = posInt("MAX_ID_CHARS", 200); // sessionId / idempotencyKey
// Rate limits (T6) — fixed-window, env-tunable; token-bucket-ish caps to stop denial-of-wallet.
const RL_SESSION = posInt("RL_SESSION_PER_MIN", 30); // ~1 turn / 2s per conversation
const RL_IP = posInt("RL_IP_PER_MIN", 60);
// MEMORY-GO-LIVE-CHECKLIST.md §E4 — the memory-write Pub/Sub push route needs its OWN limit, dedicated
// from `RL_IP`: pushes arrive from shared Google source IP ranges, so sharing the 60/min public-traffic
// limit risks a 429 → Pub/Sub retry → dead-letter for a route with no other caller to compete with.
// SCALE CEILING (does not scale, by construction — do not raise this to "fix" a future capacity problem):
// because every Pub/Sub push egresses from ONE shared Google source IP, this per-IP fixed-window limiter
// is really a GLOBAL AGGREGATE bucket — one counter shared across every tenant and every Cloud Run
// instance, not a per-caller cap. It cannot scale to the target of millions of merchants / hundreds of
// millions of customers (peak memory writes are estimated in the thousands/sec). At real scale this
// per-IP limit must be REMOVED entirely for this route — it is OIDC-gated (internal, not public), so the
// real controls are the OIDC gate itself, the per-tenant `RL_TENANT` ceiling, Cloud Run autoscaling, and
// the durable queue's own retry/DLQ, not a global IP bucket. 6000/min is only an interim runaway-loop
// backstop for early/low volume, not a sized capacity limit.
const RL_PUBSUB_PUSH = posInt("RL_PUBSUB_PUSH_PER_MIN", 6000);
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
// Custom-domain CSP support — a generic bare-hostname shape (dot-separated labels, alnum + internal
// hyphens, at least one dot), used as the LAST read-side guard on a custom domain immediately before it
// is interpolated into `Content-Security-Policy` (server.ts's `frameAncestors`). Deliberately more
// permissive than the myshopify-specific regex below (a custom domain is any merchant's own host, not a
// `*.myshopify.com` one) but still rejects anything with a scheme, path, port, space, or the like — the
// same class `normalizePrimaryDomain` (@palup/platform-ports) already rejects at write/read time; this is
// the belt-and-suspenders re-check at the actual interpolation point.
const HOSTNAME_SHAPE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i;

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
// MEMORY-GO-LIVE-CHECKLIST.md §E2 — the memory-write push route's consume-side idempotency dedup: once a
// message's deterministic `id` (memory-write-queue.ts) has been successfully `remember`-ed, a redelivery
// is ack + dropped rather than re-running the distiller call. TTL must exceed the queue's own message
// lifetime (infra/terraform/pubsub-memory.tf's `message_retention_duration`, 1h) with headroom — 48h,
// matching the §E1 erasure tombstone's TTL.
const MEMORY_DEDUP_COLLECTION = "mem:dedup";
const MEMORY_DEDUP_TTL_SECONDS = 172_800; // 48h
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
// WS3 — the sample storefront pages + assets (home / product / cart), read once at boot exactly like
// widgetHtml (no build pipeline; served verbatim by explicit routes below).
const STOREFRONT_DIR = join(here, "..", "..", "widget", "public", "storefront");
const storefrontHome = readFileSync(join(STOREFRONT_DIR, "home.html"), "utf8");
const storefrontProduct = readFileSync(join(STOREFRONT_DIR, "product.html"), "utf8");
const storefrontCart = readFileSync(join(STOREFRONT_DIR, "cart.html"), "utf8");
const storefrontCss = readFileSync(join(STOREFRONT_DIR, "app.css"), "utf8");
const storefrontJs = readFileSync(join(STOREFRONT_DIR, "app.js"), "utf8");
const storefrontFavicon = readFileSync(join(STOREFRONT_DIR, "favicon.svg"), "utf8");

const { port: modelPort, name: modelName } = createModelPort();
// ADR-0017 T7 / Wave-1 E — every commerce call goes through the ADR-0016 fail-closed guard.
// `commerceIsLive` is a capability marker from the composition root (model.ts): false for
// MockCommerceAdapter (a tested no-op), true for the live CAA adapter, at which point every read/write
// below automatically requires a verified shopper principal (bound per-request via withRequestPrincipal
// in the /chat handler). MOVED INSIDE `buildServer` (it used to be constructed here, at module scope):
// the live adapter needs `grantStore` (needs `store`/`secrets`) and the registry-first shop-domain
// resolver (`merchants.shopDomainFor`), neither of which exists until inside `buildServer` — see the
// composition site right after `grantStore` is built, below.

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
   * Task 13 test seam (mirrors `merchantCredentials`): the Admin-token custody store `createGroundingPort`
   * never reads (it is sync-plane-only), but `registerShopifyInstallRoutes`/`registerShopifyWebhookRoutes`
   * do. A missing override ⇒ the composition root builds its own `createAdminTokenStore(store,
   * adminCredCrypto())` — ALWAYS (unified-cutover-cleanup, 2026-08-24: the `ADMIN_TOKEN_CUSTODY_ENABLED`
   * flag that used to gate this is gone; the Admin offline token is the sole Shopify credential now).
   */
  adminTokens?: AdminTokenStore;
  /**
   * Task 8/13 test seam (mirrors `merchantCredentials`/`adminTokens`): the durable `catalog_product` store.
   * A missing override ⇒ the composition root builds its own (`PostgresCatalogProductStore` when a pool
   * exists, else the in-memory reference adapter) — UNCONDITIONALLY, since this ONE instance is shared
   * across grounding (Task 8), the delta-reconcile write path (Task 13, always on) and the shop/redact +
   * app/uninstalled teardown paths (Task 9/13, unconditional — see their own notes at the call sites).
   */
  catalogProduct?: CatalogProductPort;
  /**
   * Test seam (mirrors `catalogProduct`): the durable `store_profile` (brand+policy) store. A missing
   * override ⇒ the composition root builds its own — a real `PostgresStoreProfileStore` when a pool
   * exists, else the in-memory reference adapter — ALWAYS (unified-cutover-cleanup, 2026-08-24: the
   * `CATALOG_UNIFIED` flag that used to gate this is gone; serving is 100% local unconditionally).
   */
  storeProfile?: StoreProfilePort;
  /**
   * Test/composition seams for the catalog-sync scheduler's `backfill`/`index`
   * (catalog-sync-scheduler.ts's `CatalogSyncSchedulerDeps`). The scheduler itself has no live cron/HTTP
   * trigger anywhere in this codebase yet (see that file's own "NOT WIRED INTO ANY LIVE CRON/SERVER HERE"
   * banner) — standing one up, plus the real Admin-token-refresh-backed backfill composition it needs in
   * production, is Task 9's "remaining composition wiring" (the plan's own words). Whenever a real
   * `merchantRegistry` exists, `catalogSyncSchedulerDeps` (exposed on the returned `app`,
   * below) is built with the REAL `listActive`-backed `merchantRegistry` (Task 5) wired in, so that
   * enumeration capability is exercised and regression-locked ahead of Task 9 rather than left to drift.
   * Absent overrides ⇒ `backfill` throws a clearly-named "not yet composed" error if ever invoked in
   * production (there is no live caller today), and `index` uses the ALREADY-real `reconcileDeps`
   * composition (unchanged from what webhook reconcile already uses).
   */
  catalogSyncBackfill?: CatalogSyncSchedulerDeps["backfill"];
  catalogSyncIndex?: CatalogSyncSchedulerDeps["index"];
  /** D2 test seam (mirrors `caaFetch`/`installFetch`): the Storefront API fetch `createGroundingPort`'s
   * Shopify adapter uses when read-back resolves a `live` credential. There is otherwise no way to inject
   * a fake Storefront fetch into `buildServer`. Prod uses the live Storefront call (`storefrontFetch()`,
   * `shopify-grounding.ts`'s default). */
  shopifyFetch?: StorefrontFetch;
  /**
   * PR-8 test seam — mirrors `createMemoryService`'s own `enabled` override (service.ts), and is
   * subject to the EXACT SAME safeguard: honored ONLY under a real test runner (VITEST=true /
   * NODE_ENV=test). Lets a test force the memory service to actually be constructed + live so the
   * /chat -> remember()/recall() wiring can be exercised ahead of the MEMORY_ADR_ACCEPTED flip. In
   * production (no test runner) this is IGNORED — isMemoryEnabled() (the hardcoded double gate) is
   * authoritative regardless, so no caller can flip memory on via config/injection alone (NN#1).
   */
  memoryEnabled?: boolean;
  /**
   * #126 W1.5 test seam — mirrors `opts.memoryEnabled`'s EXACT safeguard: honored ONLY under a real test
   * runner (VITEST=true / NODE_ENV=test). Lets a test prove the /chat call site hands off through
   * `dispatchMemoryWrite` (memory-write-dispatch.ts) instead of calling `remember()` inline, without a real
   * Pub/Sub topic. In production (no test runner) this is IGNORED — the MEMORY_PUBSUB_* trio below is the
   * only thing that can produce a real queue, so no caller can flip the write path via injection alone.
   */
  memoryWriteQueue?: QueuePort;
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
  // semantic-memory-v1 T9 — the dark-ship flag for T4 (embed)/T5 (write-time dedup), threaded through
  // HERE for a later PR3's recall-side use (harmless while it stays false: `memoryServiceEnabled` false
  // means `memoryService` below is never even constructed, and passing `false` explicitly when it IS
  // constructed is byte-identical to createMemoryService's own env-read default — see
  // MemoryServiceDeps.semanticRecall's doc comment). Default OFF; not part of the ADR-0015 double gate.
  const semanticRecallEnabled = process.env.MEMORY_SEMANTIC_RECALL === "true";
  const WIDGET_AUTH_REQUIRED = process.env.WIDGET_AUTH_REQUIRED === "true";
  assertMemoryAuthCoupling(memoryServiceEnabled, WIDGET_AUTH_REQUIRED);
  // D2 — serving reads the delegate token an OAuth install already custodied (B2's
  // `createMerchantCredentialStore`) instead of only the hand-provisioned `SecretsPort` token. Read once
  // here, pure env, no I/O — mirrors every other posture flag's placement. The read HANDLE this gates is
  // built further down (once `store`/`secrets` exist), right before `createGroundingPort`.
  const MERCHANT_CRED_READBACK_ENABLED = process.env.MERCHANT_CRED_READBACK_ENABLED === "true";
  if (MERCHANT_CRED_READBACK_ENABLED)
    console.warn("[boot] MERCHANT_CRED_READBACK_ENABLED=true — serving reads custodied delegate tokens (D2 read-back).");
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
  // OPT-IN shared base key for merchant-credential custody (self-serve install). Default OFF (ships dark).
  // When ON, the AES-GCM adapter derives a brand-new merchant's merchant-cred key from a single shared base
  // secret (held under the reserved `MERCHANT_CRED_SHARED_KEY_TENANT` id) instead of failing custody because
  // no per-tenant key was pre-provisioned. Cross-tenant isolation is preserved BY CONSTRUCTION — deriveKey
  // mixes tenantId into HKDF, so each tenant still gets a DISTINCT AES key. Scoped to the merchant-cred
  // crypto ONLY; widget-memory's crypto (service.ts) is untouched and stays per-tenant/fail-closed.
  const MERCHANT_CRED_SHARED_KEY_ENABLED = process.env.MERCHANT_CRED_SHARED_KEY_ENABLED === "true";
  if (MERCHANT_CRED_SHARED_KEY_ENABLED)
    console.warn(
      "[boot] MERCHANT_CRED_SHARED_KEY_ENABLED=true — merchant-cred custody derives brand-new merchants' keys " +
        "from a SHARED base key (per-tenant keys still derived DISTINCTLY via HKDF/tenantId). Blast radius on a " +
        "base-key compromise is ALL tenants served by the shared base in this scope — provision it high-entropy.",
    );
  // DRY: both merchant-cred crypto call sites build the SAME adapter — per-tenant/fail-closed when the flag
  // is off (byte-for-byte today's construction), shared-base-enabled when on. Nothing else changes.
  const merchantCredCrypto = () =>
    MERCHANT_CRED_SHARED_KEY_ENABLED
      ? createAesGcmCrypto(secrets, { sharedKeyTenantId: MERCHANT_CRED_SHARED_KEY_TENANT })
      : createAesGcmCrypto(secrets);
  // Task 13 (ADR-0022 F2) — a NAMED, DISTINCT crypto factory for Admin-token custody, mirroring
  // `merchantCredCrypto` immediately above. The distinct-scope property (F2's whole point: a compromise or
  // rotation of the merchant-cred key must never expose or perturb the Admin-cred key, and vice versa) is
  // enforced INSIDE `admin-token-store.ts` itself, which always calls `crypto.encrypt`/`decrypt` with
  // `ADMIN_CRED_KEY_SCOPE` ("admin-cred") — a DIFFERENT scope from `MERCHANT_CRED_KEY_SCOPE`
  // ("merchant-cred") `merchant-credential-store.ts` always passes. `keyScopeSecretName` (crypto-port.ts)
  // turns that into a genuinely different provisioned secret name per scope
  // (`MEMORY_ENCRYPTION_KEY__admin-cred` vs. `MEMORY_ENCRYPTION_KEY__merchant-cred`), so this can safely be
  // the SAME kind of generic `createAesGcmCrypto(secrets)` adapter `merchantCredCrypto()` builds — no
  // separate `CryptoPort` implementation is needed, and no `sharedKeyTenantId` option is threaded here:
  // MERCHANT_CRED_SHARED_KEY_ENABLED is a self-serve-install friction reducer scoped explicitly to
  // merchant-cred custody (its own doc comment above), not a decision this task extends to Admin-token
  // custody without a separate directive. An unprovisioned admin-cred key therefore fails closed exactly
  // like an unprovisioned merchant-cred key would — see the non-fatal custody-failure handling this task
  // added to `routes/shopify-install.ts` for what happens when that throw is hit at install time.
  const adminCredCrypto = () => createAesGcmCrypto(secrets);
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
    // Custom-domain CSP support — the named `SHOPIFY_PRIMARY_DOMAINS` fallback, same rank `SHOPIFY_STORES`
    // holds for the shop domain itself. Parsed once at boot, like `EMBED_KEYS` (env does not change during
    // a process's life; unlike `storeDomains`, nothing else needs to re-read it per call).
    primaryDomains: parsePrimaryDomains(),
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
  // D2 read handle: a full `MerchantCredentialStore` over the SAME store+crypto install writes through.
  // Deliberately NOT `merchantCredentials` (constructed further below, typed put-only `MerchantCredentialSink`)
  // and NOT `opts.merchantCredentials` (a test double that may implement only `put`) — this composition
  // root needs its OWN read-capable handle, built here (before `createGroundingPort`, and before
  // `merchantCredentials` itself exists) because grounding needs it now. Only constructed when the flag is
  // on, so an unconfigured/off deployment never even attempts a read. Kept in scope for Task 4's `/chat`
  // pre-flight, which reuses this SAME handle rather than building a second one.
  const credReadHandle = MERCHANT_CRED_READBACK_ENABLED
    ? createMerchantCredentialStore(store, merchantCredCrypto())
    : undefined;
  // Task 8 (durable-catalog-sync, §3/§13.4) — LOCAL CATALOG SERVING, the durability invariant: a
  // backfilled tenant's catalog PRODUCTS are served from `CatalogProductPort`/`ProductFactsPort` with no
  // Shopify call, instead of the Storefront API. Constructed here (not lazily) because `createGroundingPort`
  // needs both ports at construction time — mirrors `productFactsPort`'s own construction further below,
  // which this is intentionally a SEPARATE instance from (same reasoning `reconcileFactsStore` already
  // documents: this composition root already builds more than one `ProductFactsPort` handle over the same
  // underlying table/map, and that has never been a correctness issue since every op is scoped by
  // (tenantId, productId)).
  //
  // unified-cutover-cleanup (2026-08-24) — the credential-enrollment-unification cutover (ADR-0023 D1,
  // "serving is 100% local") is now the ONLY behavior: the `CATALOG_UNIFIED` / `CATALOG_LOCAL_SERVING` /
  // `CATALOG_BACKFILL_ENABLED` / `ADMIN_TOKEN_CUSTODY_ENABLED` flags that used to gate it are gone (owner
  // directive: stop building behind flags; rollback is git-revert). Local serving is FORCED on for every
  // backfilled tenant; brand+policy always read the local `store_profile` store; the Shopify install flow
  // never mints/custodies a Storefront delegate token — the Admin offline token is the sole credential; the
  // catalog-sync scheduler composition is always wired with the real `listActive`-backed registry when one
  // exists; and the write-plane (delta-reconcile into `catalog_product`) is always on.
  const localCatalogProduct = opts?.catalogProduct ?? (runtimeResult.sql ? new PostgresCatalogProductStore(runtimeResult.sql) : createInMemoryCatalogProductStore());
  if (localCatalogProduct instanceof PostgresCatalogProductStore) await localCatalogProduct.migrate();
  const localProductFacts = runtimeResult.sql ? new PostgresProductFactsStore(runtimeResult.sql) : createInMemoryProductFactsStore();
  if (localProductFacts instanceof PostgresProductFactsStore) await localProductFacts.migrate();
  // The durable `store_profile` (brand+policy) handle, mirroring `localProductFacts` immediately above: a
  // real `PostgresStoreProfileStore` when a pool exists, else the in-memory reference adapter, migrated at
  // construction like every sibling store. ONE instance, shared into BOTH `createGroundingPort`'s
  // `storeProfile` opt AND `localCatalogHydration`'s `storeProfile` below — never two independently-
  // constructed (and potentially drifting) stores over the same table.
  const catalogStoreProfile: StoreProfilePort = opts?.storeProfile ?? (runtimeResult.sql ? new PostgresStoreProfileStore(runtimeResult.sql) : createInMemoryStoreProfileStore());
  if (catalogStoreProfile instanceof PostgresStoreProfileStore) await catalogStoreProfile.migrate();
  // Task 8b (durable-catalog-sync, spec §4.1) — the SAME memoized per-tenant "is this tenant backfilled"
  // decision Task 8 already built, constructed ONCE here so it can be shared between the grounding router
  // below and the catalog retriever's local-hydration seam further down — never a second, independently
  // memoized (and potentially drifting) backfilled-tenant check.
  const hasLocalCatalog = createLocalCatalogDecision(localCatalogProduct);
  const grounding = createGroundingPort(store, secrets, {
    catalogProduct: localCatalogProduct,
    productFacts: localProductFacts,
    storeProfile: catalogStoreProfile,
    hasLocalCatalog,
  });
  // Pillar 5 (auto-brand) — resolve the merchant's real Shopify shop NAME (via the light `getShell`), cached
  // on the RuntimeStatePort: at most ONE bounded fetch per tenant per TTL, fail-closed to the neutral default,
  // and NEVER a per-request fetch (the hot launcher-colour path stays fetch-free). Threaded into the
  // /embed/panel header only, so no brand name is hardcoded per tenant (`widget-theme.ts` holds colour only).
  const brandNameFor = createBrandNameResolver({
    store,
    fetchShopName: async (t) => (await grounding.getShell(t)).brandName,
  });
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
  // ADR-0017 — shopper identity, default OFF ⇒ byte-identical to today (every shopper stays anonymous).
  // F4 (startup precondition): SHOPPER_AUTH is only ever HONORED when WIDGET_AUTH_REQUIRED is ALSO on —
  // it needs a VERIFIED widget tenant to cross-check the shopper's tenant against (F1); under the
  // unauthenticated RUNTIME_TENANT fallback that check would be vacuous. Misconfiguration (flag on,
  // precondition unmet) degrades to "shoppers are anonymous", never to an unchecked cross-tenant bypass.
  //
  // HOISTED HERE (Wave-1 E): this used to be declared much later, alongside `shopperIdentity`. Moved up
  // because the commerce-port composition below (also new to Wave-1 E) needs `SHOPPER_AUTH_ENABLED` to
  // compute `CAA_ENABLED`, and that composition must run before `brainFor` is DEFINED (it closes over
  // `commerce`) — in particular before `brainFor`'s own eager prewarm call further down. Nothing between
  // the old and new position reads `SHOPPER_AUTH_ENABLED` before this point.
  const SHOPPER_AUTH_FLAG = process.env.SHOPPER_AUTH === "true";
  if (SHOPPER_AUTH_FLAG && !WIDGET_AUTH_REQUIRED) {
    console.warn("[config] SHOPPER_AUTH=true requires WIDGET_AUTH_REQUIRED=true (ADR-0017 F4) — shoppers will be treated as anonymous until both are set.");
  }
  const SHOPPER_AUTH_ENABLED = SHOPPER_AUTH_FLAG && WIDGET_AUTH_REQUIRED;
  // ADR-0018 — Customer Account API OAuth (shopper sign-in that yields a token to read their own orders/
  // subscriptions). Gated by the SAME SHOPPER_AUTH_ENABLED posture (so it's inert exactly when App-Proxy
  // identity is) PLUS a configured redirect_uri PLUS a shopper-token secret to mint. Per-shop client creds
  // (per-shop client model, ADR-0018 spike) come from the tenant-scoped SecretsPort. When off ⇒ 404 (inert).
  //
  // HOISTED HERE too (Wave-1 E), for the same reason as `SHOPPER_AUTH_ENABLED` above: the commerce-port
  // composition needs `CAA_ENABLED` + `grantStore` + `caaFetch` before `brainFor` is defined.
  const CAA_REDIRECT_URI = process.env.CAA_REDIRECT_URI;
  const CAA_SCOPE = process.env.CAA_SCOPE || "openid email customer-account-api:full";
  const CAA_ENABLED = SHOPPER_AUTH_ENABLED && typeof CAA_REDIRECT_URI === "string" && CAA_REDIRECT_URI.length > 0 && typeof SHOPPER_TOKEN_SECRET === "string" && SHOPPER_TOKEN_SECRET.length > 0;
  const caaFetch = opts?.caaFetch ?? globalThis.fetch;
  const grantStore = createCustomerGrantStore(store, secrets);
  // Wave-1 E (revenue-flywheel) — wire the LIVE CAA commerce READ adapter behind the exact same
  // `CAA_ENABLED` posture as the OAuth routes below. Default (no SHOPPER_AUTH / no CAA config) ⇒
  // `createCommercePort()`'s `caaEnabled:false` branch returns the mock unchanged — ships dark, pinned by
  // commerce-fixture-marker.test.ts (calls `createCommercePort()` with NO ARGS) and
  // commerce-port-caa-wiring.test.ts (explicit off case). `guardCommercePort`'s ADR-0016 fail-closed
  // check auto-activates the moment `commerceIsLive` is true — unchanged from the pre-Wave-1-E wiring.
  const { port: rawCommerce, isLive: commerceIsLive } = createCommercePort({
    grants: grantStore,
    shopDomainForTenant: (t) => merchants.shopDomainFor(t),
    caaEnabled: CAA_ENABLED,
    fetchFn: caaFetch,
  });
  const commerce = guardCommercePort(rawCommerce, commerceIsLive);
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
        // T9 — see this file's own `semanticRecallEnabled` doc comment. Explicit rather than left to
        // service.ts's own env-read default, so this composition root stays the single source of truth
        // for every posture flag it threads (matches how every other flag here is passed explicitly).
        semanticRecall: semanticRecallEnabled,
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
        recall: (ctx: {
          tenantId: string;
          anonId: string;
          region?: Signals["region"];
          consent?: Signals["consent"];
          // semantic-memory-v1, PR3, T8 — the brain's shared turn-embedding, forwarded straight through
          // to the memory service's own `recall(ctx, opts)` second argument. Absent ⇒ T7's own list-all
          // fallback (byte-identical to before this PR).
          queryVector?: number[];
          pin?: { model: string; dimension: number };
        }) =>
          memoryService.recall(
            {
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
            },
            ctx.queryVector !== undefined || ctx.pin !== undefined ? { queryVector: ctx.queryVector, pin: ctx.pin } : undefined,
          ),
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
  // S4 §B — the process-global CATALOG_RETRIEVAL env flag is RETIRED (was here). Enablement is now a
  // PER-TENANT, per-turn decision resolved from the two-gate registry (catalogRetrievalEnabledFor,
  // below in the /chat handler) — see catalog-retrieval-enablement.ts. `CATALOG_RETRIEVAL_K` is still a
  // deploy-time knob (how many candidates to ask for), unrelated to whether retrieval runs at all.
  const CATALOG_RETRIEVAL_K = posInt("CATALOG_RETRIEVAL_K", DEFAULT_CATALOG_RETRIEVAL_K);
  const PRODUCT_CITATIONS = process.env.PRODUCT_CITATIONS === "true";
  const PRODUCT_CARDS = process.env.PRODUCT_CARDS === "true";
  const CART_LINE_ITEMS = process.env.CART_LINE_ITEMS === "true";
  // Pillar 2a — IN_CHAT_CHECKOUT: wires the INERT CartPort + Shopify checkout-permalink adapter
  // (platform-ports/src/cart-port.ts, cart-permalink-adapter.ts) to `POST /cart/checkout-url`, gated
  // the SAME inert-by-absence way ORDER_ATTRIBUTION_WEBHOOKS gates /checkout/join-token below: off ⇒
  // the route does not exist (404), never a half-working 403/501. Also adds `checkoutEnabled: true` to
  // the /chat wire (spread-conditional, so a flag-off turn stays byte-identical — chat-wire-flag-off
  // golden). Default OFF ⇒ no behavior change until a human promotion flips it (HITL-POLICY §5). NOT a
  // completion claim: the adapter is a pure string builder (no fetch, no Shopify SDK, no add-to-cart
  // I/O, no purchase) — it only ever hands the shopper a checkout LINK they still open and complete on
  // Shopify themselves (see the shopper-promise-guard's new completed-action cart/checkout patterns).
  const IN_CHAT_CHECKOUT = process.env.IN_CHAT_CHECKOUT === "true";
  // WS6 — the first-touch greeting posture flag (§5 run-time agent-behaviour change; default OFF ⇒ the
  // greeting trigger is inert and the brain is byte-identical). Threaded into every brain like every flag.
  const GREETING_PROACTIVE = process.env.GREETING_PROACTIVE === "true";
  // T1 phase 2 — SERVER_GUARD_SIGNALS: run the server-side language-agnostic guard classifier per turn and
  // thread its result into signals (the brain merges it most-conservative-wins with its keyword floor).
  // Same governed posture-flag discipline as the Wave 4 flags: env-read here, default OFF, and turning it
  // on in a real environment is a human promotion (HITL-POLICY §5) — it changes what the shopper agent
  // detects. OFF ⇒ the classifier never runs (zero spend) and the guardrail ladder is byte-identical.
  const SERVER_GUARD_SIGNALS = process.env.SERVER_GUARD_SIGNALS === "true";
  // WS-A (2026-08-21, owner-authorized staging enablement) — ADR-0018 disposition axes (createBrain
  // positions 8-10). Consumers already exist in widget-brain/brain.ts (persona-style directive/B2B
  // escalation, behavioral quieting, and the classifyPersonaStyle model call respectively); this is the
  // env-read half that was previously entirely missing (the three were hardcoded `false` literals below
  // with no `process.env` read anywhere in the repo). Same governed posture-flag discipline as every flag
  // above: default OFF here, announced at boot via `wave4On`, and it is a human promotion to enable in a
  // real environment (HITL-POLICY §5) — for staging, that human promotion is this owner-authorized change
  // (see the deploy-staging.yml default and the updated comment at the createBrain call site below).
  const DISPOSITION_STYLE = process.env.DISPOSITION_STYLE === "true";
  const DISPOSITION_BEHAVIORAL = process.env.DISPOSITION_BEHAVIORAL === "true";
  const DISPOSITION_CLASSIFIER = process.env.DISPOSITION_CLASSIFIER === "true";
  // A1b — PRODUCT_FACTS_HYDRATION: overlay the Tier-2 store's fresh price/availability onto the retrieved
  // subset before it renders. Same governed posture-flag discipline: env-read here, default OFF, turning it
  // on is a human promotion (HITL-POLICY §5) — it changes which PRICE the agent quotes (money/NN#1). OFF ⇒
  // the store is never constructed, getMany never runs, and the CATALOG block is byte-identical.
  const PRODUCT_FACTS_HYDRATION = process.env.PRODUCT_FACTS_HYDRATION === "true";
  // A1b/D2 — hard staleness ceiling (ms) for hydrated Tier-2 facts. Default 15 MIN (S3 §D): a fact older than
  // this (or with no updatedAt) is NOT quoted — the agent offers to confirm rather than quote a stale number
  // (money/NN#1 fail-honest). This is the money safety net, independent of webhook/scheduler reliability.
  // Only takes effect on the flag-gated hydration path.
  const PRODUCT_FACTS_MAX_AGE_MS = posInt("PRODUCT_FACTS_MAX_AGE_MS", PRODUCT_FACTS_MAX_AGE_MS_DEFAULT);
  // Pillar 1b (ADR-0020) — PRICE_REQUIRES_LIVE_CHANNEL: on the hydration path, also require the merchant's
  // freshness CHANNEL (webhook/poll producer) to be provably live before a fact is quoted as confirmed — a
  // recent fact row alone only proves it was WRITTEN recently, not that the pipe keeping it fresh is still
  // alive. Same governed posture-flag discipline as every flag above: env-read here, default OFF, turning it
  // on is a human promotion (HITL-POLICY §5) — it can only WITHHOLD a price (never invent one), but
  // withholding is still a shopper-visible behaviour change (money/NN#1). OFF ⇒ channelHealthFor is never
  // read by createBrain and the CATALOG block is byte-identical.
  const PRICE_REQUIRES_LIVE_CHANNEL = process.env.PRICE_REQUIRES_LIVE_CHANNEL === "true";
  // WS-C (2026-08-21, owner-authorized staging enablement) — AUTONOMOUS_MONEY_PITCHES: widen two of
  // `selectPitch`'s existing confident-path branches to the money-gated `upsell`/`subscription` pitch
  // kinds (brain.ts). `promo` is NEVER reachable, in any flag state — no branch anywhere returns it. Same
  // governed posture-flag discipline as every flag above: env-read here, default OFF, announced at boot
  // via `wave4On`, and this is a `createBrain` GUARDRAIL argument (never a `Policy` field — see brain.ts's
  // param comment) so a self-improvement candidate cannot flip the money boundary itself. Turning this on
  // outside this owner-authorized staging default is a human promotion (HITL-POLICY §5, NN#1 money
  // boundary) — the deploy-staging.yml default is the staging-only enablement; production stays OFF.
  const AUTONOMOUS_MONEY_PITCHES = process.env.AUTONOMOUS_MONEY_PITCHES === "true";
  // Pillar 1 (serve-time read-through) — PRODUCT_FACTS_READ_THROUGH: when the serve path is about to quote a
  // SKU whose Tier-2 fact is stale or missing, trigger a TARGETED on-demand refresh of just those ids BEFORE
  // quoting — instead of only hedging (priceConfirmed:false) — so the price can be CONFIRMED this turn.
  // Bounded to the retrieved top-K (never a catalog crawl); the brain enforces its own timeout and falls back
  // to the existing hedge on any failure/timeout, so this can only ever get a price confirmed SOONER, never
  // invent one. Same governed posture-flag discipline as every flag above: env-read here, default OFF,
  // turning it on is a human promotion (HITL-POLICY §5) — it changes whether/when a price is confirmed
  // (money/NN#1). OFF ⇒ `refreshFacts` is never passed to the brain and the hydration path is byte-identical.
  const PRODUCT_FACTS_READ_THROUGH = process.env.PRODUCT_FACTS_READ_THROUGH === "true";
  // Pillar 3 (opener) — PROACTIVE_OPENER: upgrade the first-touch greeting to a fit-first opener (code-owned
  // quick-reply chips today; a best-fit card in a follow-on). Default OFF ⇒ the plain greeting is
  // byte-identical. A new shopper-reaching proactive surface + agent-behaviour change ⇒ eval gate → shadow →
  // canary → named-human approval (HITL §5). Only takes effect alongside GREETING_PROACTIVE (it's a greeting upgrade).
  const PROACTIVE_OPENER = process.env.PROACTIVE_OPENER === "true";
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
  // S4 §B — the retriever is constructed UNCONDITIONALLY (the env gate is retired). It reads no manifest
  // and spends nothing until a turn actually retrieves, which only happens when the per-tenant registry
  // enables it (resolved per-request below). Metered under its OWN agentType, distinct from the turn's
  // RUNTIME_AGENT_TYPE: this is per-shopper-turn EMBEDDING spend while the turn itself is generation, and
  // a cost review must be able to tell them apart (ADR-0013, and the explicit requirement in
  // catalog-retriever.ts's COST + AUDIT note that the composition root must do this).
  // Task 8b — the local-hydration dep for a backfilled tenant: the SAME `hasLocalCatalog` decision the
  // grounding router above shares, plus a DEDICATED local `GroundingPort.getProductsByIds` so this hot path
  // can never make a Shopify call. Built from the same `localCatalogProduct`/`localProductFacts`/
  // `catalogStoreProfile` instances the router above already uses — never a second, independently-
  // constructed set of stores. Constructed unconditionally: local serving is always on.
  const localCatalogHydration = {
    hasLocalCatalog,
    getProductsByIds: createLocalCatalogGroundingPort({
      catalogProduct: localCatalogProduct,
      productFacts: localProductFacts,
      storeProfile: catalogStoreProfile,
    }).getProductsByIds,
  };
  const catalogRetriever = createCatalogRetriever({
    store,
    vector: vectorPort,
    model: createMeteringModelPort(activeModelPort, telemetry, { agentType: CATALOG_RETRIEVAL_AGENT_TYPE }),
    localHydration: localCatalogHydration,
  });
  // semantic-memory-v1, PR3, T8 — the brain's SHARED turn-embedder, constructed UNCONDITIONALLY (mirrors
  // `catalogRetriever`'s own model wrapper immediately above) and metered under its OWN agentType
  // (TURN_EMBED_AGENT_TYPE) — distinct from CATALOG_RETRIEVAL_AGENT_TYPE, so a cost review can tell "one
  // shared turn embed, reused by both memory recall and catalog retrieval" apart from "the catalog
  // retriever fell back to its own internal embed" (a turn that supplies a matching precomputed vector to
  // `retrieve()` never spends under CATALOG_RETRIEVAL_AGENT_TYPE at all). Spends nothing until the brain's
  // own decide()-time gating (`memory && anonId`, or catalog retrieval enabled) actually calls embed on a
  // clean-sales-path turn — see brain.ts's own doc comment on the `turnEmbedder` constructor parameter.
  const turnEmbedder = createMeteringModelPort(activeModelPort, telemetry, { agentType: TURN_EMBED_AGENT_TYPE });
  // Pillar 1b (ADR-0020) — the per-tenant freshness-channel liveness reader, constructed UNCONDITIONALLY
  // (cheap: it only wraps `store`, like catalogRetriever/turnEmbedder above). `recordProducerOk` is wired
  // into the webhook/pubsub reconcile deps below REGARDLESS of PRICE_REQUIRES_LIVE_CHANNEL — recording a
  // producer run is harmless and cheap; only the SERVE-side consult (createBrain's `channelHealthFor`) is
  // gated on the flag, so an operator can observe channel health before ever gating price on it.
  const channelHealth = createChannelHealth({ store });
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
  // Task 13 (ADR-0022 F2/F6/F7) — Admin-token custody, now ALWAYS built (unified-cutover-cleanup,
  // 2026-08-24: the Admin offline token is the SOLE Shopify credential — the install flow below never
  // mints/custodies a Storefront delegate token). Built over the SAME `store` + the distinct
  // `adminCredCrypto()` scope (F2, see that function's own comment). A production admin-scope OAuth
  // REQUEST is a separate, not-yet-built step (Task 12's own note, and shopify-install.ts's comment at the
  // `deps.adminTokens.put` call site) — this only controls whether custody of whatever Admin token the
  // existing install grant already produced is ATTEMPTED; the least-privilege scopes a real production
  // request should use are `ADMIN_SYNC_SCOPES` (read_products, read_inventory —
  // shopify-webhook-identity.ts, Task 12/F3), referenced here so the two stay visibly linked rather than
  // drifting apart.
  //
  // MOVED HERE (final-review fix, whole-branch review 2026-08-23) from just above the C1 install block:
  // this construction has no dependency on anything install-specific (`store` and `adminCredCrypto()` are
  // both available from function start), and `reconcileDeps` below needs `adminTokens` to build the
  // paired `catalogProductAdminSource` seam without a forward reference. `registerShopifyInstallRoutes`'s
  // own use of `adminTokens` (further down, unchanged) still reads the SAME variable, just declared here now.
  const adminTokens: AdminTokenStore | undefined = opts?.adminTokens ?? createAdminTokenStore(store, adminCredCrypto());
  // Structural guard (mirrors the paired `catalogProduct`/`catalogProductAdminSource` refusal further
  // below): under the unified cutover the Admin offline token is the SOLE credential, and the install flow
  // never mints/custodies a Storefront delegate token — so a construction that somehow failed to produce an
  // `adminTokens` handle would strand every new install with NO credential at all (neither delegate nor
  // Admin). Refuse to boot rather than silently accept installs nobody can ever serve. `createAdminTokenStore`
  // never actually returns a falsy value, so this should be unreachable in practice; it stays as a
  // defensive, named-failure guard rather than an unchecked assumption.
  if (!adminTokens) {
    throw new Error(
      "adminTokens could not be constructed — refusing to boot. The Admin offline token is the SOLE Shopify " +
        "credential (ADR-0023 D1); the install flow no longer mints or custodies a Storefront delegate token, " +
        "so without Admin-token custody a newly installed merchant would have no credential at all.",
    );
  }
  // Pillar 1 (serve-time read-through) — `reconcileDeps` built UNCONDITIONALLY (moved out of the
  // CATALOG_WEBHOOKS/pubsub-push block below, which still builds nothing else early) so `refreshFacts`
  // (below) can be wired into `brainFor` regardless of whether the webhook/pubsub worker is enabled. Cheap
  // and side-effect-free to construct: `shopifyCatalogSource`/`shopifyCatalogByIdSource` are pure closures
  // over `secrets` (no I/O until actually called), and the facts-store migrate mirrors the same idempotent
  // migration `productFactsPort` already runs above. The block at CATALOG_WEBHOOKS below now reuses this
  // same object instead of building its own — no behavior change there beyond this object now existing
  // earlier.
  const reconcileFactsStore = runtimeResult.sql ? new PostgresProductFactsStore(runtimeResult.sql) : createInMemoryProductFactsStore();
  if (reconcileFactsStore instanceof PostgresProductFactsStore) await reconcileFactsStore.migrate();
  const reconcileDeps = {
    store,
    vector: vectorPort,
    model: createMeteringModelPort(activeModelPort, telemetry, { agentType: "catalog-index" }),
    catalog: shopifyCatalogSource(secrets),
    catalogById: shopifyCatalogByIdSource(secrets),
    productFacts: reconcileFactsStore,
    // Task 13 (durable-catalog-sync, §4.2/F8) — the durable `catalog_product` write path (Tasks 6/7's
    // `indexOneTenant`/`reconcileProducts` blocks, which are already no-ops unless this field is present).
    // ALWAYS wired now (unified-cutover-cleanup, 2026-08-24 — the write plane is always on). Reuses the
    // SAME `localCatalogProduct` instance Task 8 already built for grounding — never a second store over
    // the same table — so a write through this path and a read through grounding always see the same rows.
    catalogProduct: localCatalogProduct,
    // Final-review fix (whole-branch review, 2026-08-23) — the PAIRED clobber-fix field (Task 6/7's
    // `CatalogIndexDeps.catalogProductAdminSource`) that Task 13 left unwired above. STRUCTURALLY paired
    // with `catalogProduct`: the boot-time guard just below refuses to start if that pairing did not
    // actually succeed, so the write-plane can never again be half-wired the way it was before this fix.
    // Built from `makeMultiTenantCatalogProductAdminSource` (catalog-backfill.ts) over the SAME
    // `adminTokens` store `registerShopifyInstallRoutes` below already writes into (F2/F6/F7) — a tenant
    // whose admin token this resolves is exactly a tenant that could have a rich Bulk-Ops backfill row to
    // protect. `adminTokens` is now always constructed above, so this is effectively unconditional too —
    // see the guard below for the (now-defensive) case where it somehow is not.
    catalogProductAdminSource: adminTokens ? makeMultiTenantCatalogProductAdminSource(adminTokens, parseStoreDomains()) : undefined,
    // Pillar 1b — a successful money-fact upsert here is a live producer run; record it for channel-health
    // regardless of PRICE_REQUIRES_LIVE_CHANNEL (see channelHealth's own construction comment above).
    onProducerOk: (t: string) => channelHealth.recordProducerOk(t),
  };
  // Final-review fix (whole-branch review, 2026-08-23) — THE STRUCTURAL GUARD that makes the pairing above
  // impossible to silently break: refuse to boot if the rich delta WRITE plane (`catalogProduct`) is wired
  // while its paired admin-shape READ source (`catalogProductAdminSource`) is not. Both are unconditional
  // now (unified-cutover-cleanup), so this should be unreachable in practice; it stays as a defensive,
  // named-failure guard — every delta write falling back to the thin projection forever, nulling any rich
  // row a real Bulk-Ops backfill had written, is exactly the Task 6/7 clobber this exists to prevent.
  if (reconcileDeps.catalogProduct && !reconcileDeps.catalogProductAdminSource) {
    throw new Error(
      "the durable catalog_product delta write-plane is wired, but catalogProductAdminSource could not be " +
        "constructed (no admin-token store) — refusing to boot. Writing thin delta records while a rich " +
        "Bulk-Ops backfill row could exist would silently clobber it on the very next product webhook " +
        "(the Task 6/7 clobber).",
    );
  }
  // Pillar 1 (serve-time read-through) — the PORT-CLEAN callback wired into the brain (createBrain position
  // 28): a vendor-neutral `(tenantId, productIds) => Promise<void>` that re-fetches just the named SKUs
  // through the SAME targeted reconcile the catalog webhook path uses (reconcileByReason → reconcileProducts:
  // by-id fetch, re-embed only what changed, upsert fresh Tier-2 facts). That reconcile IS audited (a
  // `catalog.index` row committed in the same tx as the fact write — §3.5 holds), but it does NOT yet record
  // the read-through ORIGIN: the `reason: "read-through"` passed below reaches reconcileByReason and is then
  // DISCARDED by reconcileProducts, so a shopper-triggered refresh is currently indistinguishable in the log
  // from a scheduled poll. Recording that origin (for abuse-monitoring) — together with cross-turn coalescing
  // / a per-tenant read-through cap — is a NAMED PRECONDITION for promoting PRODUCT_FACTS_READ_THROUGH past
  // shadow (§5), not a blocker for merging this flag-off code.
  // The brain gates purely on `refreshFacts !== undefined`, so it is provided ONLY when the
  // flag is on — `reconcileDeps` itself is always constructible (see above), so there is no additional
  // partial-availability case to gate on here. No Shopify (or other vendor) type crosses into widget-brain:
  // the callback's own signature is the only thing the brain ever sees.
  const refreshFacts = PRODUCT_FACTS_READ_THROUGH
    ? (tenantId: string, productIds: string[]) => reconcileByReason(reconcileDeps, tenantId, { productIds, reason: "read-through" })
    : undefined;
  // THE COST OF WIRING THESE, MADE VISIBLE. Before this change, enabling Wave 4 required editing code;
  // now an env var suffices. That is a real reduction in friction and it is the honest trade for making
  // shadow/canary possible at all (HITL-POLICY §5). The compensating control is that an enabled flag can
  // never be SILENT: it is announced at boot, for the same reason D1's env fallback is (#169 happened
  // because a posture nobody could see was wrong for weeks). §5 still requires a recorded eval gate,
  // shadow, canary and a named human's approval before any of these is set in a real environment — this
  // line does not authorize it, it makes skipping it visible.
  const wave4On = Object.entries({ PRODUCT_CITATIONS, PRODUCT_CARDS, CART_LINE_ITEMS, SERVER_GUARD_SIGNALS, PRODUCT_FACTS_HYDRATION, OUTGOING_OFFER_CHECK, GREETING_PROACTIVE, PRICE_REQUIRES_LIVE_CHANNEL, PROACTIVE_OPENER, PRODUCT_FACTS_READ_THROUGH, DISPOSITION_STYLE, DISPOSITION_BEHAVIORAL, DISPOSITION_CLASSIFIER, AUTONOMOUS_MONEY_PITCHES })
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
        // Positions 8–10 — the disposition flags (ADR-0018). WS-A (2026-08-21, owner-authorized staging
        // enablement) wires them to their env reads above, superseding the prior "these have NO env read
        // and stay off" posture: DISPOSITION_STYLE gates the persona-style directive + B2B-role escalation,
        // DISPOSITION_BEHAVIORAL gates rage/pitch-declined quieting, and DISPOSITION_CLASSIFIER gates the
        // classifyPersonaStyle model call (only reachable when DISPOSITION_STYLE is also on — see brain.ts).
        // Same governed posture-flag discipline as every other Wave 4 flag: default OFF, announced at boot
        // via `wave4On` above, and turning any of these on in a real environment outside this owner-
        // authorized staging default is still a human promotion (HITL-POLICY §5).
        /* dispositionStyle */ DISPOSITION_STYLE, /* dispositionBehavioral */ DISPOSITION_BEHAVIORAL, /* dispositionClassifier */ DISPOSITION_CLASSIFIER,
        // Positions 11–16 — Wave 4. `catalogRetriever` is now built unconditionally (S4 §B); position 12
        // (`catalogRetrievalEnabled`) is the constructor DEFAULT only — it is always `false` here because
        // enablement is now a PER-TURN, per-tenant signal (`signals.catalogRetrievalEnabled`, resolved
        // per-request below from the two-gate registry) that the brain reads at decide()-time, not a
        // construction-time boolean baked into this cached brain.
        catalogRetriever, /* catalogRetrievalEnabled */ false, CATALOG_RETRIEVAL_K, PRODUCT_CITATIONS, PRODUCT_CARDS, CART_LINE_ITEMS,
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
        // Position 22 — A1b/D2 staleness ceiling. Only consulted on the hydration path (flag-gated above);
        // a fact past this age renders `priceConfirmed:false` and the agent offers to confirm the price.
        PRODUCT_FACTS_MAX_AGE_MS,
        // Position 23 — semantic-memory-v1, PR3, T8. The shared turn-embedder, metered under
        // TURN_EMBED_AGENT_TYPE (constructed unconditionally above). Consulted by the brain at
        // decide()-time only on the clean sales path, and only when a consumer would actually use it.
        turnEmbedder,
        // Position 24 — WS6 GREETING_PROACTIVE. Default OFF ⇒ the greeting trigger is inert; when ON the
        // greeting rung returns pitch:"none" and never calls selectPitch (no money pitch, no budget spend).
        GREETING_PROACTIVE,
        // Position 25 — Pillar 1b (ADR-0020). The per-tenant freshness-channel liveness reader (constructed
        // unconditionally above). Only ever CONSULTED when PRICE_REQUIRES_LIVE_CHANNEL (position 26) is on
        // AND the hydration path is otherwise active (PRODUCT_FACTS_HYDRATION + a retrieved subset).
        (t: string) => channelHealth.isHealthy(t),
        // Position 26 — PRICE_REQUIRES_LIVE_CHANNEL. Default OFF ⇒ channelHealthFor above is never invoked
        // and the CATALOG/cards block is byte-identical.
        PRICE_REQUIRES_LIVE_CHANNEL,
        // Position 27 — Pillar 3 PROACTIVE_OPENER. Default OFF ⇒ the greeting rung uses the plain
        // GREETING_PROMPT and mints no chips ⇒ the greeting Decision + /chat wire are byte-identical.
        PROACTIVE_OPENER,
        // Position 28 — Pillar 1 (serve-time read-through). `refreshFacts` is `undefined` unless
        // PRODUCT_FACTS_READ_THROUGH is set, so the hydration step's stale/missing-id refresh never fires and
        // the CATALOG block's hedge (priceConfirmed:false) is byte-identical to today.
        refreshFacts,
        // Position 29 — WS-C AUTONOMOUS_MONEY_PITCHES. Default OFF ⇒ selectPitch is byte-identical to
        // today (money-boundary test pins this exhaustively); ON ⇒ two existing confident-path branches
        // widen to upsell/subscription, and `promo` still has no reachable branch either way (brain.ts).
        AUTONOMOUS_MONEY_PITCHES,
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
  // `SHOPPER_AUTH_FLAG`/`SHOPPER_AUTH_ENABLED` are now declared much earlier, alongside `AUDIT_HMAC_SECRET`
  // (Wave-1 E hoist — see that comment for why).
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
  // `CAA_REDIRECT_URI`/`CAA_SCOPE`/`CAA_ENABLED`/`caaFetch`/`grantStore` are now declared much earlier,
  // alongside `AUDIT_HMAC_SECRET` (Wave-1 E hoist — the live commerce-port composition there needs them).
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
  // an assignment with no adapter. `merchantCredCrypto()` is the same CryptoPort construction widget-memory
  // uses (per-tenant/fail-closed by default), optionally shared-base-enabled behind
  // MERCHANT_CRED_SHARED_KEY_ENABLED; the `merchant-cred` key scope keeps a memory-key compromise from
  // exposing merchant credentials (crypto-port key separation).
  const merchantCredentials: MerchantCredentialSink | undefined =
    opts?.merchantCredentials ?? createMerchantCredentialStore(store, merchantCredCrypto());
  // Task 13 (ADR-0022 F2/F6/F7) — Admin-token custody (`ADMIN_TOKEN_CUSTODY_ENABLED` / `adminTokens`) is
  // now constructed EARLIER (final-review fix, see the `reconcileDeps` block below), so the
  // `catalogProductAdminSource` seam paired with `reconcileDeps.catalogProduct` can read it without a
  // forward reference. Both names are declared above and reused verbatim here — see that construction
  // site's own comment for the full ADR-0022 F2/F6/F7 rationale.
  // HOISTED above the C1 install block (their defining comment blocks stay in the C2 section below) so the
  // install flow can build its shop-specific webhook subscription list. Under `use_legacy_install_flow`
  // declarative `[webhooks]` are forbidden, so webhooks are subscribed via the Admin API DURING install;
  // the CATALOG topics register ONLY when CATALOG_WEBHOOKS is on, because their handler routes 404 while it
  // is off (Shopify auto-deletes a subscription after 8 failed deliveries).
  const SHOPIFY_WEBHOOKS_ENABLED = Boolean(shopifyAppSecretPresent && merchantRegistry);
  const CATALOG_WEBHOOKS = SHOPIFY_WEBHOOKS_ENABLED && process.env.CATALOG_WEBHOOKS === "true";
  // W2-C — order-attribution ingestion (orders/create, orders/updated, refunds/create). Gated the SAME
  // way CATALOG_WEBHOOKS is, and independently of it (a separate queue/topic — see routes/shopify-
  // webhooks.ts's `orderQueue` doc). Flipping this true does NOT by itself grant `read_orders` or
  // subscribe the topics on Shopify's side — see the W2-C header note in routes/shopify-webhooks.ts for
  // why these routes receive no live traffic regardless of this flag until an OWNER completes both of
  // those separately-gated steps. Registering the (inert without a real subscription) route early is
  // the same "carries no extra exposure" reasoning P4 already applies to the catalog push route.
  const ORDER_ATTRIBUTION_WEBHOOKS = SHOPIFY_WEBHOOKS_ENABLED && process.env.ORDER_ATTRIBUTION_WEBHOOKS === "true";
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
    // Shop-specific webhook subscriptions to register during install (legacy flow forbids declarative
    // `[webhooks]`). The topic→uri list comes from OPERATOR CONFIG ONLY — the redirect URI's own origin
    // plus the exported `WEBHOOK_ROUTES` paths — never the shop domain or the request, so a hostile `shop`
    // can never point Shopify's push at an attacker URL (SSRF defence). APP_UNINSTALLED is always
    // registered; the catalog topics are added ONLY when CATALOG_WEBHOOKS is on, because their handler
    // routes only register then (subscribing to them while off would point Shopify at 404s, which it
    // auto-deletes after 8 failed deliveries). Registration is best-effort/non-fatal in the flow, and each
    // topic also needs its resource read scope on the parent token (see docs/DEPLOY.md / the report note on
    // SHOPIFY_INSTALL_SCOPES) — a topic whose scope was not granted simply fails its tally.
    const webhookOrigin = new URL(SHOPIFY_INSTALL_REDIRECT_URI!).origin;
    const webhookSubscriptions: Array<{ topic: string; uri: string }> = [
      { topic: "APP_UNINSTALLED", uri: webhookOrigin + WEBHOOK_ROUTES.appUninstalled },
    ];
    if (CATALOG_WEBHOOKS) {
      webhookSubscriptions.push(
        { topic: "PRODUCTS_CREATE", uri: webhookOrigin + WEBHOOK_ROUTES.productsCreate },
        { topic: "PRODUCTS_UPDATE", uri: webhookOrigin + WEBHOOK_ROUTES.productsUpdate },
        { topic: "PRODUCTS_DELETE", uri: webhookOrigin + WEBHOOK_ROUTES.productsDelete },
        { topic: "INVENTORY_LEVELS_UPDATE", uri: webhookOrigin + WEBHOOK_ROUTES.inventoryLevelsUpdate },
      );
    }
    // W3-3 — order-attribution ingestion (ADR-0007 / the revenue flywheel's incrementality signal). Added
    // to the SAME per-shop, Admin-API subscription call CATALOG_WEBHOOKS's topics use just above — never
    // to shopify.app.toml's declarative `[webhooks]` (untouched; see order-attribution-scope-pinning.test.ts).
    // Topic enum names follow the SAME REST-topic→SCREAMING_SNAKE_CASE convention the four lines above
    // already use ("orders/create" → "ORDERS_CREATE", mirroring "products/create" → "PRODUCTS_CREATE").
    // Confirmed against shopify.dev's WebhookSubscriptionTopic enum (retrieved 2026-08-19): ORDERS_CREATE,
    // ORDERS_UPDATED, REFUNDS_CREATE are the exact enum members. As a belt-and-suspenders, a `userErrors`
    // failure from Shopify would surface as a `failed` tally (registerWebhookSubscriptions never throws on
    // one), never a silent success, so even a future spelling drift fails LOUD, not quiet. Registering these three topics needs the
    // PARENT token to hold `read_orders` (ORDER_ATTRIBUTION_ADMIN_SCOPE, shopify-webhook-identity.ts) — that
    // scope is requested (if at all) via the operator-controlled `SHOPIFY_INSTALL_SCOPES` env var for THIS
    // deployment only, never via shopify.app.toml, and its grant additionally requires Shopify's
    // protected-customer-data review to complete before any live delivery is meaningful (routes/shopify-
    // webhooks.ts's W2-C header). Subscribing with the scope ungranted simply fails its own tally, exactly
    // like an under-scoped catalog topic does today.
    if (ORDER_ATTRIBUTION_WEBHOOKS) {
      webhookSubscriptions.push(
        { topic: "ORDERS_CREATE", uri: webhookOrigin + WEBHOOK_ROUTES.ordersCreate },
        { topic: "ORDERS_UPDATED", uri: webhookOrigin + WEBHOOK_ROUTES.ordersUpdated },
        { topic: "REFUNDS_CREATE", uri: webhookOrigin + WEBHOOK_ROUTES.refundsCreate },
      );
    }
    // Idempotent DDL, exactly like the runtime/vector stores' own `migrate()` — one more table in the
    // existing database, never a new cloud resource. Only for the real Postgres adapter; an injected
    // registry (test seam) has no migration.
    registerShopifyInstallRoutes(app, {
      store,
      registry: merchantRegistry!,
      credentials: merchantCredentials!,
      // Task 13 — put-only (structurally, `AdminTokenStore` satisfies `Pick<AdminTokenStore,"put">`).
      // ALWAYS constructed (unified-cutover-cleanup, 2026-08-24): the Admin token is now the SOLE install
      // credential, so custody is unconditional — the old ADMIN_TOKEN_CUSTODY_ENABLED gate is gone.
      adminTokens,
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
      webhookSubscriptions,
      // ADR-0023 D1 — unified-cutover-cleanup (2026-08-24): the Admin-only credential-and-enrollment
      // cutover is now the ONLY behavior — Task 2 deleted the `catalogUnified` flag from
      // `ShopifyInstallDeps` entirely (there is no other behavior left to gate). The install flow never
      // mints/custodies a Storefront delegate token; the boot guard above already refused to start unless
      // `adminTokens` is wired, so the Admin token is guaranteed to be the sole credential custodied here.
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
  //
  // NOTE — `SHOPIFY_WEBHOOKS_ENABLED` and `CATALOG_WEBHOOKS` are declared ABOVE the C1 install block (the
  // install flow reads CATALOG_WEBHOOKS to decide which webhook topics to subscribe Shopify to). A3
  // (ADR-0020 D4): CATALOG_WEBHOOKS ON ⇒ the catalog webhook routes register and enqueue a reconcile per
  // delivery; a worker re-fetches that tenant's current catalog via runCatalogIndex (never trusting the
  // payload) and refreshes the Tier-2 facts. OFF ⇒ the catalog routes 404 and no queue/worker is built —
  // byte-identical to before. The scheduled poll job (PRODUCT_FACTS_POLL) remains the missed-event
  // backstop, so webhooks are an optimisation, never the only freshness path.
  // P4 — Pub/Sub push settings. The CONSUME side (the OIDC push route) is gated on these THREE ALONE, NOT on
  // CATALOG_WEBHOOKS: the route's OIDC verify is the sole control on an internet-reachable,
  // --allow-unauthenticated endpoint, and decoupling it lets an operator smoke-verify that gate in staging
  // (and, in the window before `shopify app deploy` subscribes topics, prod) BEFORE the webhook producer is
  // turned on (go-live P4). CATALOG_WEBHOOKS gates only the PUBLISH side (the webhook routes that enqueue).
  const PUBSUB_TOPIC = process.env.PUBSUB_CATALOG_TOPIC?.trim();
  const PUBSUB_PUSH_SERVICE_ACCOUNT = process.env.PUBSUB_PUSH_SERVICE_ACCOUNT?.trim();
  const PUBSUB_PUSH_AUDIENCE = process.env.PUBSUB_PUSH_AUDIENCE?.trim();
  const pubsubPushConfigured = Boolean(PUBSUB_TOPIC && PUBSUB_PUSH_SERVICE_ACCOUNT && PUBSUB_PUSH_AUDIENCE);
  let catalogQueue: QueuePort | undefined;

  // The reconcile-by-re-fetch worker (the SAME path the poll job runs, with its own metered model + a durable
  // facts store when a pool exists) is shared by the consume (push route) and the in-memory publish path, so
  // build it when EITHER is active. `reconcileDeps` itself is now built UNCONDITIONALLY, above (Pillar 1
  // serve-time read-through) — reused here rather than rebuilt, so a deployment with CATALOG_WEBHOOKS/pubsub
  // push both off still gets exactly the worker/routes it got before (nothing), while one with either on
  // gets the SAME reconcileDeps the read-through callback would already be using.
  if (CATALOG_WEBHOOKS || pubsubPushConfigured) {
    // S3 §C — `reconcileByReason` (catalog-index.ts) owns the routing: named product ids ⇒ the TARGETED
    // reconcile (fetch+embed+upsert+ledger for just those SKUs, S3·T5); a bare "inventory" tick is a NO-OP
    // — inventory freshness is covered by the hourly poll backstop (PRODUCT_FACTS_POLL) + the serve-time
    // ceiling, not a proactive crawl (spec decision, S3 §C); "full"/absent (the backstop path, or an
    // inventory message with no by-id target) runs the existing whole-catalog `runCatalogIndex`. Kept as a
    // named export (not inlined here) so the routing decision is unit-testable on its own.
    const reconcile = (tenantId: string, o?: { productIds?: string[]; reason?: ReconcileReason }) => reconcileByReason(reconcileDeps, tenantId, o);

    // CONSUME side — the durable OIDC-verified push route. Registered whenever Pub/Sub push is configured,
    // INDEPENDENT of CATALOG_WEBHOOKS (the P4 decoupling). With CATALOG_WEBHOOKS off nothing publishes, so the
    // route is inert except for a deliberately-authorized push (e.g. the go-live smoke) — but it is still
    // fully OIDC-gated and fail-closed at every step, so registering it early carries no extra exposure.
    if (pubsubPushConfigured) {
      // Dynamic import so the GCP SDK loads ONLY when Pub/Sub push is configured (never on the flag-off build).
      const { OAuth2Client } = await import("google-auth-library");
      const oauth = new OAuth2Client();
      const verify: OidcVerifier = async (token) => {
        // verifyIdToken checks the Google SIGNATURE, the AUDIENCE, the ISSUER (accounts.google.com) and
        // expiry; a bad token throws (⇒ route sees null). We additionally require email_verified — defence
        // in depth on the sole control of an internet-reachable endpoint (the service runs
        // --allow-unauthenticated for /chat, so Cloud Run IAM does NOT gate this route; the route's own
        // OIDC check is it). The route then enforces email === the expected push SA.
        const ticket = await oauth.verifyIdToken({ idToken: token, audience: PUBSUB_PUSH_AUDIENCE! });
        const p = ticket.getPayload();
        return p?.email && p.email_verified === true ? { email: p.email } : null;
      };
      registerPubSubPushRoute(app, {
        verify,
        expectedServiceAccount: PUBSUB_PUSH_SERVICE_ACCOUNT!,
        reconcile,
        // §E4 dedicated Pub/Sub limiter (NOT the shared 60/min RL_IP public-traffic bucket): every push
        // egresses from ONE shared Google source IP, so a bulk product edit/delete fans out far more than
        // 60 reconciles/min into a single counter → 429 → retry → dead-letter → the delete-prune never runs
        // and deleted SKUs linger in vp_ann. Its own `pubsub-catalog:` key namespace keeps this window
        // isolated from the memory push route's `pubsub-mem:` window and from public `ip:` traffic (they
        // key the same fixed-window store). Mirrors the memory push route below; see the RL_PUBSUB_PUSH
        // comment at its definition for the scale-ceiling caveat.
        checkRateLimit: (ip) => underLimit(store, { tenantId: "__mint__" }, `pubsub-catalog:${ip}`, RL_PUBSUB_PUSH, RL_WINDOW),
      });
      console.warn(
        "[config] Pub/Sub OIDC push route registered (consume side) — its OIDC verify (signature + audience + " +
          "expected SA + email_verified) is the SOLE control on this internet-reachable route. Registration is " +
          "INDEPENDENT of CATALOG_WEBHOOKS so the gate can be smoke-verified before the producer is enabled (P4). " +
          "Enabling ingestion does not itself serve the facts — PRODUCT_FACTS_HYDRATION is a separate money/NN#1 " +
          "promotion (HITL §5).",
      );
    }

    // PUBLISH side — only when the webhook producer is on. It enqueues a reconcile per delivery: the durable
    // path publishes to Pub/Sub (consumed by the route above), the fallback runs the in-memory queue inline.
    if (CATALOG_WEBHOOKS) {
      if (pubsubPushConfigured) {
        const { PubSub } = await import("@google-cloud/pubsub");
        catalogQueue = createPubSubQueue({
          client: new PubSub() as unknown as PubSubClientLike,
          topicName: () => PUBSUB_TOPIC!,
        });
      } else {
        // S3 §C (T6) — the in-memory path is the SYNCHRONOUS one (a webhook blocks on its reconcile), so a
        // bulk edit firing N webhooks would otherwise fan out to N sequential re-indexes. Route it through
        // the per-tenant coalescer: N deliveries in one CATALOG_RECONCILE_COALESCE_MS window collapse into
        // ONE reconcile with the merged/deduped id set (see catalog-reconcile-coalescer.ts for the
        // full-subsumes-targeted and over-cap-spills-to-full rules). The durable Pub/Sub push route above is
        // NOT wrapped — it reconciles per delivery already targeted (S3·T5); cross-delivery coalescing there
        // is an operational/S4 concern.
        const COALESCE_MS = posInt("CATALOG_RECONCILE_COALESCE_MS", CATALOG_RECONCILE_COALESCE_MS_DEFAULT);
        const coalescer = createReconcileCoalescer((tenantId, o) => reconcile(tenantId, o), { windowMs: COALESCE_MS });
        catalogQueue = createInMemoryQueue({});
        subscribeCatalogReconcile(catalogQueue, async (tenantId, o) => {
          coalescer.enqueue(tenantId, { ...(o?.productIds ? { productIds: o.productIds } : {}), reason: o?.reason ?? "full" });
        });
        // FIX 4 (final review, #5) — drain any still-pending coalesce window on shutdown, so a deploy/restart
        // landing mid-window does not silently lose the targeted ids it was about to reconcile. The
        // per-window timer is `unref()`d (catalog-reconcile-coalescer.ts) so it never holds the process
        // open by itself; this hook is the actual drain path on a graceful `app.close()`.
        app.addHook("onClose", async () => {
          await coalescer.flush();
        });
        console.warn(
          "[config] CATALOG_WEBHOOKS is ON with the IN-MEMORY queue (dev/staging only): deliveries COALESCE per " +
            `tenant over ${COALESCE_MS}ms then reconcile once. Set PUBSUB_CATALOG_TOPIC + PUBSUB_PUSH_SERVICE_ACCOUNT + ` +
            "PUBSUB_PUSH_AUDIENCE for the durable async path before any real deployment.",
        );
      }
    }
  }

  // W2-C — order-attribution ingestion: enqueue-then-200 on the webhook route, `subscribeOrderAttribution`
  // (order-attribution-queue.ts) as the worker, OFF the webhook's own request/response cycle. IN-MEMORY
  // ONLY in this increment (mirrors CATALOG_WEBHOOKS's own in-memory fallback, "SYNCHRONOUS… a webhook
  // blocks on its reconcile" — same trade-off, same honesty about it): a durable Pub/Sub transport
  // (mirroring PUBSUB_CATALOG_TOPIC / MEMORY_PUBSUB_TOPIC's env trio + OIDC push route) is a deliberate,
  // named follow-up, not built here — nothing in the explicit scope of this increment requires it, and
  // this path is unreachable in real deployments anyway until read_orders + a live topic subscription
  // exist (see the W2-C header note in routes/shopify-webhooks.ts).
  let orderQueue: QueuePort | undefined;
  if (ORDER_ATTRIBUTION_WEBHOOKS) {
    orderQueue = createInMemoryQueue({});
    subscribeOrderAttribution(orderQueue, store);
    console.warn(
      "[config] ORDER_ATTRIBUTION_WEBHOOKS is ON with the IN-MEMORY queue (dev/staging only): each " +
        "verified orders/create, orders/updated or refunds/create delivery resolves + tallies synchronously " +
        "within the same request. No durable Pub/Sub transport is wired yet — a follow-up, mirroring the " +
        "catalog/memory push-route pattern, is required before any real deployment. This flag alone grants " +
        "no Shopify scope and subscribes no topic — read_orders + a real webhook subscription are separate, " +
        "owner-gated steps (routes/shopify-webhooks.ts's W2-C header).",
    );
  }

  // #126 W1.5 — the durable async memory-write queue + its OIDC-verified push route, mirroring the P4
  // catalog Pub/Sub pattern immediately above but scoped to memory writes and gated on its OWN env trio
  // (INDEPENDENT of PUBSUB_CATALOG_TOPIC/CATALOG_WEBHOOKS — an operator can turn on the durable catalog
  // path without touching memory, and vice versa). Ships dark: absent env ⇒ `memoryWriteQueue` stays
  // undefined ⇒ `dispatchMemoryWrite` at the /chat call site below runs the SAME inline `remember()` as
  // today (server-sync-memory-write.test.ts pins this). No governance flag is touched here — memory's own
  // ADR-0015 double gate (`memoryServiceEnabled`) is reused unchanged as an ADDITIONAL precondition: a queue
  // for a feature that is itself off would register a route with nothing legitimate to write.
  const MEMORY_PUBSUB_TOPIC = process.env.MEMORY_PUBSUB_TOPIC?.trim();
  const MEMORY_PUBSUB_PUSH_SERVICE_ACCOUNT = process.env.MEMORY_PUBSUB_PUSH_SERVICE_ACCOUNT?.trim();
  const MEMORY_PUBSUB_PUSH_AUDIENCE = process.env.MEMORY_PUBSUB_PUSH_AUDIENCE?.trim();
  const memoryPushConfigured = Boolean(MEMORY_PUBSUB_TOPIC && MEMORY_PUBSUB_PUSH_SERVICE_ACCOUNT && MEMORY_PUBSUB_PUSH_AUDIENCE);

  // CONSUME side — registered only when memory is actually live AND the push env is fully configured.
  if (memoryServiceEnabled && memoryPushConfigured) {
    // Dynamic import so the GCP SDK loads ONLY when memory push is configured (mirrors the catalog route
    // above — portability, ADR-0001/NN#3: no provider SDK import outside this gated branch).
    const { OAuth2Client } = await import("google-auth-library");
    const memoryOauth = new OAuth2Client();
    const memoryVerify: OidcVerifier = async (token) => {
      // Same verifyIdToken pattern as the catalog route's verifier, but a DIFFERENT audience — each push
      // route has its own dedicated OIDC audience, so the two verifiers are never interchangeable.
      const ticket = await memoryOauth.verifyIdToken({ idToken: token, audience: MEMORY_PUBSUB_PUSH_AUDIENCE! });
      const p = ticket.getPayload();
      return p?.email && p.email_verified === true ? { email: p.email } : null;
    };
    registerMemoryWritePushRoute(app, {
      verify: memoryVerify,
      expectedServiceAccount: MEMORY_PUBSUB_PUSH_SERVICE_ACCOUNT!,
      remember: (ctx, turn) => memoryService!.remember(ctx, turn),
      // §E4 (security-review MED-2) — a DEDICATED limit AND a dedicated COUNTER KEY. `underLimit` keys the
      // fixed-window counter by (tenantId, key) only — the limit value is just the threshold, NOT part of
      // the key — so reusing `ip:${ip}` would share ONE counter with the catalog push route and all public
      // `ip:` traffic (both arrive from shared Google source IPs), starving this route and defeating the
      // isolation E4 requires. The `pubsub-mem:` namespace gives this route its own window. NOTE: pushes
      // share a Google source IP, so this is effectively ONE global aggregate bucket (RL_PUBSUB_PUSH/min
      // across all tenants + instances) — size RL_PUBSUB_PUSH_PER_MIN against peak aggregate turn volume
      // before enabling the queue (it fails toward the DLQ, i.e. silent memory loss, not over-admission).
      checkRateLimit: (ip) => underLimit(store, { tenantId: "__mint__" }, `pubsub-mem:${ip}`, RL_PUBSUB_PUSH, RL_WINDOW),
      // §E1 — erasure tombstone: subject-level, covers both the main and floor namespaces (a class-specific
      // withdrawal conservatively also drops any in-flight write for the whole subject — erasure.ts).
      wasErasedAfter: async (tenantId, anonId, publishedAtMs) => {
        const t = await store.get<{ erasedAtMs: number }>({ tenantId }, ERASURE_TOMBSTONE_COLLECTION, tombstoneKey(anonId));
        return !!t && publishedAtMs <= t.erasedAtMs;
      },
      // §E2 — consume-side idempotency dedup, keyed off the message's deterministic id.
      alreadyProcessed: async (tenantId, id) => (await store.get({ tenantId }, MEMORY_DEDUP_COLLECTION, id)) !== null,
      markProcessed: async (tenantId, id) => {
        await store.put({ tenantId }, MEMORY_DEDUP_COLLECTION, id, { done: true }, { ttlSeconds: MEMORY_DEDUP_TTL_SECONDS });
      },
    });
    console.warn(
      "[config] memory-write Pub/Sub OIDC push route registered (consume side) — its OIDC verify (signature + " +
        "audience + expected SA + email_verified) is the SOLE control on this internet-reachable route, mirroring " +
        "the catalog push route's gate. Registration requires memoryServiceEnabled (ADR-0015 double gate) — " +
        "MEMORY_ADR_ACCEPTED being hardcoded false keeps this absent in real production regardless of env.",
    );
  }

  // PUBLISH side — the QueuePort `dispatchMemoryWrite` (memory-write-dispatch.ts) hands writes off to at
  // the /chat call site, instead of calling `remember()` inline. `opts.memoryWriteQueue` is the test seam
  // (honored ONLY under a real test runner, mirroring `opts.memoryEnabled` exactly); real construction below
  // is the ONLY thing that can produce a live queue in production.
  let memoryWriteQueue: QueuePort | undefined = underTestRunner ? opts?.memoryWriteQueue : undefined;
  if (!memoryWriteQueue && memoryServiceEnabled && memoryPushConfigured) {
    const { PubSub } = await import("@google-cloud/pubsub");
    memoryWriteQueue = createPubSubQueue({
      client: new PubSub() as unknown as PubSubClientLike,
      topicName: () => MEMORY_PUBSUB_TOPIC!,
    });
  }

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
      // A3 — present ONLY when CATALOG_WEBHOOKS is on, so the catalog routes register only then (else 404).
      queue: catalogQueue,
      // W2-C — present ONLY when ORDER_ATTRIBUTION_WEBHOOKS is on, so the order-attribution routes
      // register only then (else 404) — the same inert-by-absence pattern as `queue` above.
      orderQueue,
      // Task 9/13 (ADR-0022 F1/F2) — delete-only (structurally, `AdminTokenStore` satisfies
      // `Pick<AdminTokenStore,"delete">`). ALWAYS constructed now (unified-cutover-cleanup, 2026-08-24) —
      // the Admin token is the sole credential; the old ADMIN_TOKEN_CUSTODY_ENABLED gate is gone. Task 9's
      // shop/redact + app/uninstalled handler still hard-deletes it on teardown.
      adminTokens,
      // Task 9/13 — UNCONDITIONAL, unlike `adminTokens`/`catalogProduct`'s write-plane gating elsewhere in
      // this file: `localCatalogProduct` (Task 8) is always constructed regardless of flags, and a
      // shop/redact hard-delete or an app/uninstalled tombstone is a COMPLIANCE action, not a
      // serving/write-plane feature — it must not depend on whether CATALOG_LOCAL_SERVING or
      // CATALOG_BACKFILL_ENABLED happen to be on today. An empty store makes both calls harmless no-ops;
      // wiring it always means no stale row can ever survive a merchant's erasure request just because a
      // flag was off at the time the row was written (e.g. by a manual backfill CLI run) or is off now.
      catalogProduct: localCatalogProduct,
    });
  }

  // W3-3 — the mint endpoint the (out-of-scope here) widget-side checkout handoff will call, to turn
  // THIS shopper's already-assigned holdout arm (W2-B's `assignHoldoutArm`, on /chat) into the opaque,
  // PII-free join token an `orders/create` webhook (`handleOrderWebhook` above) later resolves back to
  // an arm. Registered ONLY when ORDER_ATTRIBUTION_WEBHOOKS is on — the SAME inert-by-absence gate the
  // order webhook routes use just above, so an operator flips one flag for both halves of this feature.
  // With it off this route 404s, byte-identical to before this endpoint existed.
  //
  // `mintOrderJoinToken` (order-join-token.ts) is the SECOND, PER-TENANT dark gate, and it is the one
  // that actually decides whether anything is minted: it returns `null` — never a guessed token — when
  // the holdout is off for this tenant, or when this identity has no recorded assignment for the
  // current period (a shopper who never reached /chat this period, so /chat's own `assignHoldoutArm`
  // never bucketed them). So a merchant with the holdout off gets 204 from every call, and a merchant
  // with it on still gets 204 for any shopper who has not chatted yet this period — never a fabricated
  // arm just because checkout asked for one.
  if (ORDER_ATTRIBUTION_WEBHOOKS) {
    app.post("/checkout/join-token", async (req, reply) => {
      // Same per-IP rate-limit posture as /consent — a public, audit-writing mint endpoint — fail-open
      // on the limiter itself so a broken limiter cannot block a shopper's checkout.
      const xff = req.headers["x-forwarded-for"];
      const ipKey = clientIpKey(Array.isArray(xff) ? xff[0] : xff, req.ip);
      try {
        if (!(await underLimit(store, { tenantId: "__mint__" }, `ip:${ipKey}`, RL_IP, RL_WINDOW))) {
          reply.code(429);
          return { error: "rate limited" };
        }
      } catch {
        /* fail-open, mirrors /consent */
      }

      const body = (req.body ?? {}) as { sessionId?: unknown; widgetToken?: string; shopperToken?: string };
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

      // Per-tenant ceiling — backstop against a distributed-IP flood inside one tenant, mirrors /consent.
      try {
        if (!(await underLimit(store, { tenantId }, "checkout-join-token", RL_TENANT, RL_WINDOW))) {
          reply.code(429);
          return { error: "rate limited" };
        }
      } catch {
        /* fail-open, as above */
      }

      // NN#4 — the same operator kill switch every other governed write in this file honours. UNLIKE
      // W2-B's arm ASSIGNMENT on /chat (deliberately fail-open there — it sits on the shopper's hot
      // reply path), this endpoint is off /chat's critical path entirely: it is called at checkout
      // handoff, after the shopper already has their reply, so refusing it while halted costs nothing
      // but one unattributed order, never a broken chat turn or a broken checkout (Shopify's own
      // checkout proceeds regardless of whether this call succeeds).
      if (await matchedKill(store, { tenantId, agentType: RUNTIME_AGENT_TYPE })) {
        reply.code(503);
        return { error: "paused" };
      }

      // The SAME identity /chat's own holdout assignment is keyed on: the server-VERIFIED shopperId when
      // one is presented, else the (hashed, inside holdoutIdentity) sessionId — never a client-claimed
      // shopperId. A missing/blank sessionId falls back to "anon", mirroring /chat's own default.
      const sessionId = typeof body.sessionId === "string" && body.sessionId ? body.sessionId : "anon";
      const verifiedShopperId = await verifiedShopperIdFor(principal, tenantId, req.headers["x-shopper-token"], body.shopperToken);
      const token = await mintOrderJoinToken(store, tenantId, holdoutIdentity({ verifiedShopperId, sessionId }), holdoutPeriod());
      if (!token) {
        // Nothing to mint (holdout off for this tenant, or no assignment yet this period) — 204, never a
        // distinguishable error: the widget's checkout handoff simply attaches no note_attribute.
        reply.code(204);
        return null;
      }
      // PII-free by construction: `token` is `mintOrderJoinToken`'s own `randomBytes(24)` opaque value,
      // carrying no shopper identity (see that file's header for why). This is the ENTIRE response body.
      return { ok: true, joinToken: token };
    });
  }

  // Pillar 2a — POST /cart/checkout-url: turns recommended lines into a Shopify checkout permalink
  // (CartPort + cart-permalink-adapter.ts, previously wired to nothing). Registered ONLY when
  // IN_CHAT_CHECKOUT is on — inert-by-absence, byte-identical (404) to before this route existed while
  // off. Mirrors /checkout/join-token's own prologue: per-IP rate limit (fail-open), widget Bearer→
  // tenant, per-tenant rate limit (fail-open), kill switch. Makes NO completion claim: this only ever
  // returns a checkout LINK the shopper opens and completes on Shopify themselves — no cart is created
  // server-side and no purchase is made (see the shopper-promise-guard's cart/checkout patterns).
  if (IN_CHAT_CHECKOUT) {
    app.post("/cart/checkout-url", async (req, reply) => {
      // Same per-IP rate-limit posture as /checkout/join-token — fail-open on the limiter itself so a
      // broken limiter cannot block a shopper's checkout.
      const xff = req.headers["x-forwarded-for"];
      const ipKey = clientIpKey(Array.isArray(xff) ? xff[0] : xff, req.ip);
      try {
        if (!(await underLimit(store, { tenantId: "__mint__" }, `ip:${ipKey}`, RL_IP, RL_WINDOW))) {
          reply.code(429);
          return { error: "rate limited" };
        }
      } catch {
        /* fail-open, mirrors /consent and /checkout/join-token */
      }

      const body = (req.body ?? {}) as {
        items?: unknown;
        widgetToken?: string;
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

      // Per-tenant ceiling — backstop against a distributed-IP flood inside one tenant, mirrors
      // /checkout/join-token's own "checkout-join-token" bucket.
      try {
        if (!(await underLimit(store, { tenantId }, "cart-checkout-url", RL_TENANT, RL_WINDOW))) {
          reply.code(429);
          return { error: "rate limited" };
        }
      } catch {
        /* fail-open, as above */
      }

      // NN#4 — the same operator kill switch every other governed write in this file honours.
      if (await matchedKill(store, { tenantId, agentType: RUNTIME_AGENT_TYPE })) {
        reply.code(503);
        return { error: "paused" };
      }

      const rawItems = Array.isArray(body.items) ? body.items : undefined;
      if (!rawItems || rawItems.length === 0) {
        reply.code(400);
        return { error: "no valid items" };
      }
      // Hard cap BEFORE resolving lines — a caller cannot force an unbounded permalink build.
      const capped = rawItems.slice(0, 50);
      const lines: CartLine[] = [];
      for (const raw of capped) {
        const item = raw as { variantId?: unknown; quantity?: unknown };
        if (typeof item.variantId !== "string" || !item.variantId.trim()) continue; // dropped, never guessed
        const quantity =
          typeof item.quantity === "number" && Number.isInteger(item.quantity) && item.quantity >= 1
            ? item.quantity
            : 1;
        lines.push({ variantId: item.variantId.trim(), quantity });
      }
      if (lines.length === 0) {
        reply.code(400);
        return { error: "no valid items" };
      }

      const shopDomain = await merchants.shopDomainFor(tenantId);
      if (!shopDomain) {
        reply.code(400);
        return { error: "checkout unavailable" };
      }

      const checkout = await createCartPermalinkAdapter(shopDomain).createCheckout(lines);
      if (!checkout) {
        // Every candidate line failed to resolve to a real Shopify variant (adapter-level refusal,
        // distinct from — but reported identically to — the route's own pre-check above).
        reply.code(400);
        return { error: "no valid items" };
      }

      // NN#5 — audit the build. PII/URL-safe: only the LINE COUNT is recorded, never a variantId or the
      // built checkoutUrl. `actor` is the server-VERIFIED shopper id when one resolved, else "shopper"
      // for the (today, common) anonymous case. Fail-safe like `auditOnce` (merchant-resolver.ts): a
      // broken audit chain must not break a shopper's checkout, but the failure is never silent either.
      const verifiedShopperId = await verifiedShopperIdFor(principal, tenantId, req.headers["x-shopper-token"], body.shopperToken);
      try {
        await store.audit({ tenantId }, buildCartCheckoutAuditInput({ actor: verifiedShopperId ?? "shopper", lineCount: lines.length }));
      } catch {
        console.error(`[cart-checkout-url] could not record audit for tenant "${tenantId}"; the checkout link is still returned.`);
      }

      return { checkoutUrl: checkout.checkoutUrl };
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

  // WS2 — public storefront catalog read endpoint. Renders the SAME live catalog the assistant is grounded
  // on (getContext → the 30-min cache; no new fetch path), so the sample storefront's grid/PDP/cart and the
  // widget finally agree. Injected deps mirror routes/embed.ts. Rate-limited per-IP (fail-open, like the
  // /widget/token mint) AND per-tenant (fail-CLOSED cost backstop — security-review MEDIUM: the per-IP
  // limiter is XFF-spoofable, so the unspoofable per-tenant ceiling is what stops a cold-fetch stampede on
  // a merchant's private Shopify token). Uniform 404 for every non-ok tenant (no existence oracle).
  // WS-storefront — the paginated grid reader (a browsable subset + cursor). Resolves the tenant's creds the
  // SAME way grounding does, then fetches ONE page — never the whole-catalog ceiling — so the storefront
  // renders even the >1000-SKU stores where the assistant's getContext fails closed to empty. A non-live
  // tenant (dev/fixtures) falls back to the grounding port's own catalog, bounded to one page.
  //
  // HOISTED ABOVE `GET /` (Workstream B SSR): the `/` route below server-renders the first catalog page
  // into the static shell, and reuses these SAME `StorefrontCatalogDeps` functions — never a second
  // catalog-fetch path — so this block (and the `resolveTenant`/`shopDomainFor` closures, pulled out to
  // named consts so `/` can call them directly) must be constructed before `GET /` is registered.
  const storefrontPageFetch = storefrontCatalogPageFetch();
  const getCatalogPage = async (tenantId: string, first: number, after?: string) => {
    const outcome = await resolveStorefrontCredential(tenantId, {
      secrets,
      credRead: credReadHandle ? (t) => credReadHandle.read(t) : undefined,
      readbackEnabled: MERCHANT_CRED_READBACK_ENABLED,
      shopDomainFor: (t) => merchants.shopDomainFor(t),
    });
    if (outcome.status === "live") {
      const data = await storefrontPageFetch(outcome.creds, first, after);
      const ctx = mapStorefrontToContext(tenantId, data);
      const pi = data.products?.pageInfo;
      return { context: ctx, nextCursor: pi?.hasNextPage && pi?.endCursor ? pi.endCursor : undefined };
    }
    if (outcome.status === "refuse") throw new Error("storefront credential unreadable");
    const ctx = await grounding.getContext(tenantId);
    return { context: { ...ctx, products: ctx.products.slice(0, first) }, nextCursor: undefined };
  };
  // WS-storefront — resolve ONE product by handle for a direct PDP hit. Live path: a single Storefront
  // `product(handle:)` call (never the whole-catalog ceiling). Non-live (dev/fixtures): find it in the
  // grounding port's own catalog by handle/id. `null` when it resolves to nothing → the route's 404.
  const productByHandleFetch = storefrontProductByHandleFetch();
  const getProductByHandle = async (tenantId: string, handle: string) => {
    const outcome = await resolveStorefrontCredential(tenantId, {
      secrets,
      credRead: credReadHandle ? (t) => credReadHandle.read(t) : undefined,
      readbackEnabled: MERCHANT_CRED_READBACK_ENABLED,
      shopDomainFor: (t) => merchants.shopDomainFor(t),
    });
    if (outcome.status === "live") {
      const data = await productByHandleFetch(outcome.creds, handle);
      const ctx = mapStorefrontToContext(tenantId, data);
      return ctx.products.length ? { context: ctx } : null;
    }
    if (outcome.status === "refuse") throw new Error("storefront credential unreadable");
    const ctx = await grounding.getContext(tenantId);
    const p = ctx.products.find((x) => x.handle === handle || x.id === handle);
    return p ? { context: { ...ctx, products: [p] } } : null;
  };
  // Pulled out to named consts (rather than inlined in the `registerStorefrontCatalogRoutes` call below,
  // as before) so `GET /`'s SSR handler can call the identical resolver/domain-lookup functions.
  const storefrontResolveTenant = async (shop: string | undefined) => {
    const r = await merchants.tenantForShopDomain(shop ?? "");
    return { ok: r.kind === "ok", tenantId: r.kind === "ok" ? r.tenantId : undefined };
  };
  const storefrontShopDomainFor = (tenantId: string) => merchants.shopDomainFor(tenantId);
  // Dedicated counter key ("storefront-catalog") so it never shares the /chat per-tenant bucket.
  // Fail-CLOSED: a store error denies rather than silently disabling the cost ceiling. Pulled out to a
  // named const (like `storefrontResolveTenant`/`storefrontShopDomainFor` above) so `GET /`'s SSR path
  // reuses the IDENTICAL per-tenant denial-of-wallet backstop `/storefront/catalog` uses — never a second,
  // divergent limiter, and never an unthrottled live-Shopify-fetch path on the highest-traffic route.
  const storefrontAllowTenant = async (tenantId: string) => {
    try {
      return await underLimit(store, { tenantId }, "storefront-catalog", RL_TENANT, RL_WINDOW);
    } catch {
      return false;
    }
  };
  registerStorefrontCatalogRoutes(app, {
    resolveTenant: storefrontResolveTenant,
    getCatalogPage,
    getProductByHandle,
    shopDomainFor: storefrontShopDomainFor,
    allowIp: (ipKey) => underLimit(store, { tenantId: "__mint__" }, `ip:${ipKey}`, RL_IP, RL_WINDOW),
    allowTenant: storefrontAllowTenant,
    ipKeyFor: (req) => {
      const xff = req.headers["x-forwarded-for"];
      return clientIpKey(Array.isArray(xff) ? xff[0] : xff, req.ip);
    },
  });

  // Workstream B — the default storefront tenant `GET /` server-renders for: the single configured
  // `SHOPIFY_STORES` shop domain (there is no `?shop=` on `/`), matching the domain `app.js` itself
  // defaults its `SHOP` constant to when a page carries no `data-shop` (home.html's loader snippet
  // always sets `data-shop`, so this is the same store in practice). No live store configured → this
  // falls back to the same fixture-store domain `app.js` hardcodes, and `storefrontResolveTenant` above
  // then just as honestly fails to resolve it (dev/local/test posture — never a hard dependency).
  // TODO: assumes a single configured store — `Object.values(...)[0]` is order-ambiguous (object key
  // iteration order, not a declared "primary" store) the moment a second entry is added to `SHOPIFY_STORES`.
  const DEFAULT_STOREFRONT_SHOP = Object.values(parseStoreDomains())[0] ?? "palup-skincare-jason.myshopify.com";

  // WS3 — the sample storefront replaces the old inlined widget demo at the root. The widget is now embedded
  // via the REAL loader (each storefront page carries the /embed/loader.js snippet → shadow-DOM launcher +
  // /embed/panel iframe). The standalone widget harness moves to /widget (test/dev only; the panel HTML is
  // also served at /embed/panel). `/storefront/catalog` (WS2) is registered separately above.
  //
  // Workstream B (SSR first page) — server-render the first catalog page into the static shell so the
  // grid + footer are at final height on first paint (kills the CLS/LCP/`{brand}` FOUC the UX review
  // flagged). Reuses the SAME `StorefrontCatalogDeps` functions `/storefront/catalog` uses — no second
  // catalog-fetch path, AND the SAME per-tenant `storefrontAllowTenant` denial-of-wallet backstop, since
  // `/` is the highest-traffic UNAUTHENTICATED route (bots/crawlers/refreshes) and would otherwise be an
  // uncached, unthrottled way to trigger a live Shopify GraphQL call at each cache-TTL boundary. Cached
  // response either way (`cache-control`, same as `/storefront/catalog`) so a CDN/browser absorbs most of
  // that traffic before it ever reaches this handler. GRACEFUL DEGRADATION IS MANDATORY: any failure
  // (default tenant unresolved, the per-tenant limiter denying/throwing, the catalog fetch throwing)
  // falls through to serving the raw, unmodified `storefrontHome` string, still a 200 — SSR is an
  // enhancement here, never a hard dependency for the storefront to render at all, and `/` must never 429
  // (the client-side fetch fallback + its own `/storefront/catalog` limiter handle that case).
  app.get("/", async (_req, reply) => {
    reply.header("cache-control", "public, max-age=300, stale-while-revalidate=600");
    try {
      const resolved = await storefrontResolveTenant(DEFAULT_STOREFRONT_SHOP);
      if (resolved.ok && resolved.tenantId && (await storefrontAllowTenant(resolved.tenantId))) {
        const page = await getCatalogPage(resolved.tenantId, STOREFRONT_PAGE_LIMIT);
        const shopDomain = await storefrontShopDomainFor(resolved.tenantId).catch(() => undefined);
        const wire = projectStorefrontCatalog(page.context, shopDomain, page.nextCursor);
        const ssrHtml = injectStorefrontFirstPage(storefrontHome, wire);
        // Workstream B / Task 3 CLS fix: inline app.js's hydration script (see inlineStorefrontScript's
        // doc comment) so the grid renders from `#palup-ssr` before first paint — no external-script
        // fetch + task-boundary gap for Chromium to paint the still-empty grid through. Same file
        // content either way; only this SSR-success response delivers it inline instead of deferred.
        //
        // CSP DEPENDENCY: this relies on `/` carrying NO Content-Security-Policy `script-src` that would
        // block inline scripts (none is set today — this route sets no CSP header at all). If a strict
        // CSP is ever added in front of the storefront (edge/proxy/CDN, or a future header here), this
        // inline `<script>` gets blocked outright and the empty-grid CLS this exists to prevent comes
        // straight back, silently — a blocked inline script is not a 4xx/5xx, so nothing here would
        // notice. The real guard is the e2e's `data-ready="1"` assertions on the grid (they fail if
        // hydration didn't run), NOT the `script[src="/storefront/app.js"]` `toHaveCount(0)` check, which
        // stays green either way (that assertion only proves the tag isn't external, not that the inline
        // script executed).
        reply.type("text/html").send(inlineStorefrontScript(ssrHtml, storefrontJs));
        return;
      }
    } catch {
      /* fall through to the static shell — SSR is an enhancement, never a hard dependency. */
    }
    reply.type("text/html").send(storefrontHome);
  });
  app.get("/product/:handle", async (_req, reply) => {
    reply.type("text/html").send(storefrontProduct);
  });
  app.get("/cart", async (_req, reply) => {
    reply.type("text/html").send(storefrontCart);
  });
  app.get("/storefront/app.css", async (_req, reply) => {
    reply
      .header("content-type", "text/css; charset=utf-8")
      .header("cache-control", "public, max-age=300")
      .send(storefrontCss);
  });
  app.get("/storefront/app.js", async (_req, reply) => {
    reply
      .header("content-type", "application/javascript; charset=utf-8")
      .header("cache-control", "public, max-age=300")
      .send(storefrontJs);
  });
  app.get("/storefront/favicon.svg", async (_req, reply) => {
    reply
      .header("content-type", "image/svg+xml; charset=utf-8")
      .header("cache-control", "public, max-age=300")
      .send(storefrontFavicon);
  });
  app.get("/widget", async (_req, reply) => {
    reply.type("text/html").send(widgetHtml);
  });

  // Task 3 — the theme app extension's <script src> target: a boot-time esbuild bundle of the
  // vanilla-DOM launcher (loader-entry.ts → loader-core.ts) served as a self-executing IIFE, plus the
  // panel iframe route the loader points at. `frameAncestors` is v1: the resolved shop's own
  // myshopify domain (+ a permissive https fallback) — the panel route's CSP is exercised by a later
  // task's test; this task only serves /embed/loader.js.
  const loaderJs = await bundleLoader();
  registerEmbedRoutes(app, {
    loaderJs,
    panelHtml: widgetHtml,
    frameAncestors: async (shop) => {
      const isMyshopify = Boolean(shop && /^[a-z0-9.-]+\.myshopify\.com$/i.test(shop));
      // Security-review F1: a missing/malformed `?shop=` can never resolve a tenant anyway (the mint
      // 401s). `*.myshopify.com` breadth (F2) is unchanged — a documented follow-up, not this change's job.
      // WS5 — `'self'` lets a page on THE PANEL'S OWN ORIGIN frame it: the PalUp-hosted sample storefront
      // (served from this same backend origin) embeds the panel via the loader, and without `'self'` its
      // same-origin iframe would be CSP-refused. `'self'` widens nothing toward the merchant — it is only
      // the panel's own origin — so cross-origin framing stays restricted to the shop's own domain(s).
      let allow = isMyshopify ? `'self' https://${shop} https://*.myshopify.com` : "'self'";
      if (isMyshopify) {
        // Custom-domain CSP support. Reached ONLY via this SERVER-side registry/env lookup keyed by the
        // already-accepted, myshopify-shaped `shop` — NEVER a second, client-supplied query parameter
        // (there isn't one: `registerEmbedRoutes` reads only `?shop=` — routes/embed.ts). `shop` is typed
        // `string` here (not `unknown`), and TypeScript's own literal-type narrowing already proves it
        // matched the myshopify regex above, so `HOSTNAME_SHAPE` below is guarding the RETURNED custom
        // domain, not this one.
        const custom = await merchants.primaryDomainForShop(shop);
        // Read-side validation AGAIN, immediately before the value is interpolated into the CSP header —
        // defense in depth against ANYTHING upstream (a hand-edited pl_merchant row, a malformed
        // SHOPIFY_PRIMARY_DOMAINS entry) that slipped past every earlier guard. `custom` is already
        // normalized (trim + lowercase) by the resolver, so this is a shape check, not a re-parse.
        if (custom && HOSTNAME_SHAPE.test(custom)) allow += ` https://${custom}`;
      }
      // TEST-ONLY (task 7 embed e2e) — verified by executing the round trip in a real browser: Chromium
      // enforces frame-ancestors for real, and the e2e harness's own host page is served by THIS SAME
      // backend process over plain HTTP at 127.0.0.1 — an origin no real Shopify storefront is ever
      // served from, so it can never satisfy `allow` above (which is exactly the point of `allow` — it
      // must stay tight to the shop's own domain, and now its custom domain). Appending this origin to
      // the allow-list is gated on PALUP_E2E_FIXTURES, the SAME flag that registers the only route this
      // origin is used for (`/embed-host`, above) — grep-verified nowhere else in the repo, so it is
      // never true in staging, prod, or the shared widget/a11y e2e process. MUST stay the LAST thing
      // appended (task 7's own seam), so it never precedes a later, real allow-list entry.
      if (process.env.PALUP_E2E_FIXTURES === "true" && process.env.PORT) {
        return `${allow} http://127.0.0.1:${process.env.PORT}`;
      }
      return allow;
    },
    // WS10 — resolve the merchant brand theme by shop (server-side, contrast-safe). A shop that doesn't
    // resolve gets the default indigo theme. Pure map lookup, so safe per panel/theme request.
    resolveThemeFor: async (shop) => {
      const r = shop ? await merchants.tenantForShopDomain(shop) : ({ kind: "unknown" } as const);
      return resolveTheme(r.kind === "ok" ? r.tenantId : "");
    },
    // Pillar 5 (auto-brand) — the panel header's brand name, resolved from the merchant's real shop name and
    // cached. Only /embed/panel calls this (never the launcher-colour endpoint). Fail-closed → undefined.
    brandNameForShop: async (shop) => {
      if (!shop) return undefined;
      const r = await merchants.tenantForShopDomain(shop);
      return r.kind === "ok" ? await brandNameFor(r.tenantId) : undefined;
    },
  });

  // Task 7 (embed e2e) — TEST-ONLY host-page fixture, never present in production or in any other
  // deployment. Gated on a dedicated flag (never NODE_ENV/VITEST, which other suites in this process
  // could set for unrelated reasons) so this route exists ONLY when e2e/playwright.embed.config.ts's own
  // isolated webServer explicitly opts in — the shared widget/a11y e2e backend never sets it, so those
  // suites see zero change here.
  if (process.env.PALUP_E2E_FIXTURES === "true") {
    // Intentionally unguarded: fail LOUD at boot. A mis-flagged prod image sets this env var but
    // ships no `e2e/` dir, and should crash the process, not silently skip and serve no fixtures.
    const embedHostHtml = readFileSync(join(here, "..", "..", "..", "e2e", "fixtures", "embed-host.html"), "utf8");
    app.get("/embed-host", async (_req, reply) => {
      reply.type("text/html").send(embedHostHtml);
    });
  }

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
    const q = req.query as { key?: string; shop?: string };
    const resolved = q.shop
      ? await merchants.tenantForShopDomain(q.shop)
      : await merchants.resolveEmbedKey(q.key, "embed-key-mint");
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

    // Memory-safety follow-up to #332 — "treat turning off the consent toggle as Forget me", PER TIER
    // (ADR-0015 "Withdrawal is symmetric" + Inv 9: Consent 1 and Consent 2 are independent, so toggling
    // one tier OFF must erase ONLY that tier's facts, never the other). `withdrawConsent1`/`withdrawConsent2`
    // (widget-memory/src/erasure.ts) each write the §E1 erasure tombstone FIRST, before deleting anything —
    // so an in-flight async memory-write-queue message for this subject can never resurrect the
    // just-withdrawn fact after this call returns. A throw here must FAIL the request (mirrors /forget's
    // own `eraseSubject` call below, which is likewise uncaught): the shopper opted OUT, so a swallowed
    // error would silently leave their data in place. A client retry is safe — both withdraw functions are
    // idempotent (re-deleting an already-empty tier is a no-op that still tombstones + audits), exactly
    // like recordConsent's own idempotent overwrite above.
    if (body.memoryOrdinary === "out") {
      await withdrawConsent1({ vector: vectorPort, audit: store, hmacKey: AUDIT_HMAC_SECRET }, { tenantId, anonId: subject });
    }
    if (body.memorySpecial === "out") {
      await withdrawConsent2({ vector: vectorPort, audit: store, hmacKey: AUDIT_HMAC_SECRET }, { tenantId, anonId: subject });
    }

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
    //   (i) the shopper token is never REQUIRED here — a caller who omits it still reaches the guest path
    //       below. POST-ADR-0019 (tasks 1–9 shipped 2026-08-17) that path derives the guest subject from a
    //       server-issued, SIGNED `x-guest-token` (`guestAnonIdFrom`), NOT from a client-supplied anonId,
    //       so a caller can no longer name "any well-formed anonId they hold"; the C1 residual narrows to a
    //       caller who has STOLEN the victim's signed guest token from their browser — the device-access
    //       threat C1 already accepts (named-owner decision, 2026-08-04, docs/MEMORY-GO-LIVE-CHECKLIST.md C1); and
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
    // repeat of the C1 delete attack: post-ADR-0019 the guest-era namespace erased here is named by the
    // VERIFIED `x-guest-token` (`guestTokenAnonId`), not a client-supplied string, so it can only erase a
    // namespace the caller already proved control of — granting an attacker nothing beyond the
    // device-access threat C1 accepts. Only fires when the guest-token anonId is (a) well-formed and
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

  // Task 10 (ADR-0015 Tier 2 / ADR-0019 R2-1, R2-2, Q19(c)) — the production caller of
  // `mergeGuestIntoAccount` (widget-memory/src/merge.ts), reached by the widget ONCE per CAA sign-in
  // handoff (best-effort, never on every /chat turn — merge.ts's own doc comment is explicit that an
  // every-turn caller is exactly what this must NOT be, since every call — including a no-op — writes an
  // audit row). Guarded exactly like `/consent` and `/forget`: per-IP + per-tenant rate limit (429), the
  // NN#4 operator kill switch (503), and registered only while memory is actually live
  // (`memoryServiceEnabled`) — unlike `/forget`, a carry-over of nothing has no data-rights argument for
  // staying reachable while the feature is off, so this one 404s like every other memory-gated route.
  //
  // SUBJECT DERIVATION IS THE WHOLE POINT: the account subject comes ONLY from a server-VERIFIED shopper
  // token (`verifiedShopperIdFor`) — no verified shopper, no merge, 401 (there is no account to merge
  // INTO otherwise). The guest subject comes ONLY from a server-VERIFIED, SIGNED `x-guest-token`
  // (`guestAnonIdFrom`) — NEVER `body.anonId` — exactly like `/consent`/`/forget`'s own invariant 4. A
  // request that supplies only a `body.anonId` (no valid guest token) names no guest subject at all, so
  // it degrades to "nothing to merge" (`{merged:0}`), never to trusting the client's string.
  app.post("/memory/merge", async (req, reply) => {
    if (!memoryServiceEnabled) {
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
      /* fail-open: mirrors /consent and /forget */
    }
    const body = (req.body ?? {}) as {
      anonId?: unknown; // NEVER trusted as the guest subject — see the route's own doc comment above.
      widgetToken?: string;
      /** Mirrors /chat's/consent's dual-transport fallback for the x-shopper-token header. */
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
    try {
      if (!(await underLimit(store, { tenantId }, "memory-merge", RL_TENANT, RL_WINDOW))) {
        reply.code(429);
        return { error: "rate limited" };
      }
    } catch {
      /* fail-open, as above */
    }
    // NN#4 — the operator kill switch outranks everything: a merge is a governed, audited memory write
    // (mergeGuestIntoAccount's own `recordMerge`), so the halt must be able to stop it too.
    if (await matchedKill(store, { tenantId, agentType: RUNTIME_AGENT_TYPE })) {
      reply.code(503);
      return { error: "paused" };
    }

    // The account identity ONLY from a verified shopper token — a merge with no signed-in shopper has no
    // account to merge INTO, so this is a hard 401, not a fall-through to some other subject.
    const verifiedShopperId = await verifiedShopperIdFor(principal, tenantId, req.headers["x-shopper-token"], body.shopperToken);
    if (!verifiedShopperId) {
      reply.code(401);
      return { error: "a verified shopper is required to merge guest memory into an account" };
    }
    // The guest identity ONLY from a verified, signed x-guest-token — NEVER body.anonId (invariant 4,
    // same helper /consent and /forget already use). Absent/invalid ⇒ nothing to merge, not an error.
    const guestAnonId = await guestAnonIdFrom(req, tenantId);
    if (!guestAnonId) {
      return { merged: 0 };
    }

    const accountSubject = memorySubjectId({ verifiedShopperId });
    const [accountConsent, guestConsent] = await Promise.all([
      lookupConsent(store, { tenantId, anonId: accountSubject! }),
      lookupConsent(store, { tenantId, anonId: guestAnonId }),
    ]);
    // WS-D — Q19(c) is now SERVER-RECORDED, not client-asserted. `healthDisclosed` reads a disclosure event
    // written (by the future R2-1 carry-over prompt, still legal-gated CARRY_OVER_PROMPT_ENABLED) via
    // recordHealthDisclosure, keyed by (tenant, accountSubject, guestAnonId) — like the two consent legs.
    // Until a production writer exists, this is fail-closed false, so special-category rows do not carry.
    // A forged body.healthDisclosed can no longer promote Art-9 facts (MED-1 remediated).
    const healthDisclosed = await lookupHealthDisclosure(store, { tenantId, accountSubject: accountSubject!, guestAnonId });

    const result = await mergeGuestIntoAccount(
      { vector: vectorPort, audit: store, hmacKey: AUDIT_HMAC_SECRET },
      {
        tenantId,
        anonId: guestAnonId,
        accountId: verifiedShopperId,
        consent2: accountConsent.memorySpecial,
        consent2Source: guestConsent.memorySpecial,
        healthDisclosed,
      },
    );
    return { merged: result.merged };
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

    // D2 Task 4 — a SECOND pre-flight, distinct from the servability check above. Servability answers
    // "does this merchant's ROW say we may serve them" (identity/revocation/residency); this answers "CAN
    // we actually read the delegate credential their install custodied." A merchant can be fully servable
    // and still have an `unreadable` row (a rotated/misconfigured key, a corrupt write) — that is a
    // transient, operator-fixable fault, not a deliberate revocation, so it gets its OWN flag
    // (`grounding_unavailable`) and its OWN status (503, not 403) rather than reusing the servability
    // 403's shape. `found`/`missing` are NOT refused here: `missing` (never installed / never custodied)
    // and any tenant whose credential we successfully read both fall through to the existing
    // resolveStorefrontCredential three-way (live/fixtures/refuse) inside grounding, unchanged. Only
    // `credReadHandle` is called — never a second store construction — reusing Task 3's SAME handle. Fires
    // ONLY when the flag is on AND the handle exists; an off/unconfigured deployment skips the read
    // entirely (no store round trip, no behavior change). `tenantId` here is the SAME server-derived value
    // the servability check above just used — never client input.
    if (MERCHANT_CRED_READBACK_ENABLED && credReadHandle) {
      // M-2 fix (D2 final review): this read must never let a STORE/CRYPTO FAULT — a thrown exception,
      // distinct from the store's own honest `unreadable` classification below — escape past this
      // pre-flight. Before this fix the `await` sat outside any try/catch, so a thrown fault propagated
      // straight to Fastify's default error handler (a RAW 500) instead of the SAME fail-closed
      // `grounding_unavailable` 503 the `unreadable` branch already returns for an honest read failure.
      // Folded into that SAME branch (reason "read-error") rather than a second response shape, so a
      // caller sees ONE unavailability signal regardless of whether the store returned an honest
      // classification or threw — fail CLOSED either way.
      const cred = await credReadHandle
        .read(tenantId)
        .catch((): { status: "unreadable"; reason: string } => ({ status: "unreadable", reason: "read-error" }));
      if (cred.status === "unreadable") {
        // I-2: make the refusal observable/alarmable (spec §2.2/§4/§7) — a tenant id and a closed reason
        // set (`undecryptable` | `malformed-record` | the M-2 fault marker `read-error`), NEVER the token,
        // the raw stored row, or the caught error's own message (which could in principle echo something
        // store-internal — the reason marker is all this ever logs). Rate-safe: this can fire at most once
        // per unreadable/faulting turn for this tenant, same cardinality as the 503 it accompanies — no
        // separate amplification vector.
        req.log.warn({ tenantId, reason: cred.reason }, "grounding credential unreadable — serving grounding_unavailable");
        reply.code(503); // transient / operator-fixable, not a deliberate revocation
        return {
          // Shopper-facing copy: same promise-nothing discipline as the servability 403 above — no human,
          // no export, no erasure, and no hint that this is a credential/decryption problem specifically.
          reply: "This store's assistant is temporarily unavailable. Please try again shortly.",
          mode: "support",
          pitch: "none",
          escalate: false,
          flags: ["grounding_unavailable"],
          memoryEnabled: memoryServiceEnabled,
          // M-1: from here the merchant IS resolved (servability passed above) — report THEIR resolved
          // regime, not the pre-resolution UNRESOLVED_CONSENT_MODE (that value is for the 403 path above,
          // where we never learned who the merchant is).
          consentMode: CONSENT_MODE,
        };
      }
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
      //   • behavioral   — WS-B3a: client-accepted, but only the enum-validated TIMING subset
      //     (dwell/hesitation/idle_then_return) a client can legitimately observe about its own session.
      //     `rage`/`pitch_declined`/`repeat_question` stay SERVER-owned — DISPOSITION_BEHAVIORAL is
      //     default-on on staging and a client-supplied `rage` would set brain.ts's escalateToHuman
      //     unconditionally, so those three are never trusted from the client (signals.ts's
      //     CLIENT_BEHAVIORAL_EVENTS, not the full BehavioralEvent enum).
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
      // These four reads are independent (no read depends on another's result) and hit the SAME shared
      // store, so they are fired concurrently rather than paid sequentially every turn (incl. dark
      // tenants where retrieval is off). Values and downstream use are unchanged — only the await shape.
      // §8a inv 14 basic-mode-at-cap: a cap set by the control plane (where spend is actually measured)
      // propagates to every serving instance. Deliberately a separate registry from `kill`: a kill halts
      // and hands off, while at cap the shopper must keep being served. See
      // state-postgres/src/cost-cap-registry.ts.
      // S4 §B — per-tenant CATALOG_RETRIEVAL, resolved from the two-gate registry on the SAME shared store,
      // so a `pnpm catalog:enable` flip propagates to every serving instance. Default OFF for everyone.
      // S4 §C — the retrieval-scoped kill, read alongside the shopper kill. `CATALOG_RETRIEVAL_AGENT_TYPE`
      // ("catalog-retrieval") is the SAME agentType the retriever meters under (server.ts retriever above).
      // matchedKill handles precedence global>tenant>agent. This DEGRADES retrieval; it does not halt.
      const [kill, costCap, catalogRetrievalEnabled, retrievalKill] = await Promise.all([
        matchedKill(store, { tenantId, agentType: RUNTIME_AGENT_TYPE }),
        matchedCostCap(store, { tenantId }),
        catalogRetrievalEnabledFor(store, tenantId),
        matchedKill(store, { tenantId, agentType: CATALOG_RETRIEVAL_AGENT_TYPE }),
      ]);
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
      // T1 phase 2 — server-side guard classification for THIS turn. Computed HERE (moved up) because the
      // special-category consent decision below now consults it, and still BEFORE deriveServingSignals so
      // the result stays server-authored and unspoofable. Runs only when SERVER_GUARD_SIGNALS is on (⇒
      // guardClassifierModel defined), never while halted, and never on an empty/proactive turn (no message
      // to classify). classifyGuardSignals never throws — a failure returns a degraded result (no signal ⇒
      // the brain falls back to its keyword floor).
      const guardSignals =
        guardClassifierModel && !kill && !costCap && message.trim() !== ""
          ? await classifyGuardSignals(guardClassifierModel, message, tenantId)
          : undefined;
      // Special-category (GDPR Art. 9 health) detection for the consent prompt has TWO sources: the fast
      // English keyword classifier (classifyFact — a floor) OR, when SERVER_GUARD_SIGNALS is on, the model
      // guard classifier, which is LANGUAGE-AGNOSTIC and so catches health/allergy disclosures in ANY
      // language (e.g. "我有濕疹") that the English keyword list would miss. Only the two health-bearing guard
      // classes count as special-category here: "medical" (a medical/health message) and "product_safety"
      // (allergy / swelling / skin-condition safety) — the same categories classifyFact keys on. The
      // remaining classes (distress / regulated_claim / legal / abuse) are NOT Art. 9 health and never
      // trigger this prompt. Guard OFF ⇒ guardSignals undefined ⇒ the keyword classifier alone decides,
      // byte-identical to before this change.
      const consentPromptFactClass = classifyFact(message).class;
      const guardSpecial =
        guardSignals?.safetyClass === "medical" || guardSignals?.safetyClass === "product_safety";
      const consentPrompt: "special" | undefined =
        memoryServiceEnabled &&
        (consentRecord?.memorySpecial ?? "unknown") === "unknown" &&
        (consentPromptFactClass === "special" || guardSpecial)
          ? "special"
          : undefined;
      // Durable, no-PII observability for the special-category consent DECISION (a compliance-relevant
      // decision: whether to ask a shopper to share health/Art-9 info). Logs ONLY the decision and the
      // booleans/enums that produce it — never the message text, the shopper/guest identity, or any token.
      // `factClass` is the keyword classifier's verdict; `guardSafetyClass` is the model guard's verdict —
      // together they make "why did / didn't the health-consent prompt fire?" answerable in Cloud Logging.
      console.log(
        JSON.stringify({
          evt: "consent-prompt-decision",
          tenantId,
          memoryServiceEnabled,
          factClass: consentPromptFactClass,
          guardSafetyClass: guardSignals?.safetyClass ?? "none",
          memorySpecial: consentRecord?.memorySpecial ?? "unknown",
          hasConsentRecord: consentRecord != null,
          consentPrompt: consentPrompt ?? "none",
        }),
      );
      // WS-B2b — lifecycle derivation (ADR-0015 Tier 2): VERIFIED-ONLY (never called for an anonymous
      // shopper) and FAIL-OPEN (any throw — including CommerceGuardRefusalError on a live adapter, or a
      // real adapter error/timeout — leaves `relationship` undefined, so deriveServingSignals below falls
      // back to its old new/anonymous-only default; the chat turn never breaks on this). Bound via
      // `withRequestPrincipal` (same mechanism `session.send` uses further down) so a LIVE commerce
      // adapter's guard — which requires the ALS-bound principal to be this verified shopper — actually
      // passes, rather than always refusing because no principal was bound yet at this point in the
      // handler. Adds 2 commerce calls per verified-shopper turn — acceptable for staging; a per-session
      // cache is a future optimization, not built here.
      let relationship: Relationship | undefined;
      if (verifiedShopperId) {
        try {
          const [hist, sub] = await withRequestPrincipal(shopperPrincipal, () =>
            Promise.all([commerce.getOrderHistory(verifiedShopperId), commerce.getSubscription(verifiedShopperId)]),
          );
          relationship = deriveLifecycle(hist, sub, true);
        } catch {
          relationship = undefined; // FAIL-OPEN: any commerce error ⇒ fall back to the old default
        }
      }
      // WS-B4' — device is SERVER-derived from THIS request's own `user-agent` header, never the client's
      // `signals` body (STYLE/FORMAT-ONLY; FAIR-1). Same array-vs-string header normalization as the
      // `x-forwarded-for` reads elsewhere in this file — a proxy/multi-value header takes the first value.
      const uaHeader = req.headers["user-agent"];
      const device = classifyDevice(Array.isArray(uaHeader) ? uaHeader[0] : uaHeader);
      const signals: Signals = deriveServingSignals(body.signals, {
        tenantId,
        kill: Boolean(kill),
        atCap: Boolean(costCap),
        device,
        catalogRetrievalEnabled,
        catalogRetrievalKilled: Boolean(retrievalKill),
        // T1 — server-authored guard signals (undefined ⇒ deriveServingSignals omits the keys, so the
        // flag-off path stays byte-identical). `safetyClass` is undefined when the classifier said "none".
        serverSafetyClass: guardSignals?.safetyClass,
        serverInjection: guardSignals?.injection,
        // broaden — the same classifier's whitelisted support intent (undefined when it said "general" /
        // was out-of-enum / it failed ⇒ key omitted ⇒ brain's keyword classifier decides, byte-identical).
        serverSupportIntent: guardSignals?.supportIntent,
        // F10-D — the classifier's own degraded marker for THIS turn (undefined when the classifier
        // didn't run, e.g. flag off/killed/cost-capped/empty message; false when it ran cleanly; true on
        // any error/timeout/unparseable/out-of-enum). deriveServingSignals only ever sets the key when
        // truthy, so the flag-off / clean-classification path stays byte-identical.
        serverGuardDegraded: guardSignals?.degraded,
        // WS-B1 — mood, folded into the SAME classifyGuardSignals call above (no second model.complete).
        // Undefined when the classifier didn't run / omitted mood / emitted out-of-enum ⇒
        // deriveServingSignals falls back to the client's own mood echo (safe: mood only restrains).
        serverMood: guardSignals?.mood,
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
        // WS-B2b — server-computed lifecycle stage (undefined ⇒ deriveServingSignals's old default).
        relationship,
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

      // W2-B — the business HOLDOUT (holdout.ts; ADR-0007 / attribution-and-billing.md §1). Read once per
      // turn, like matchedKill/matchedCostCap above. DEFAULT `{enabled:false}` (readHoldoutConfig's own
      // honest default when nothing has been written) ⇒ `holdoutArm` stays undefined and NOTHING below
      // in this block — arm assignment, the control-policy override, and the exposure tally further down
      // — runs: byte-identical to before this feature existed. Identity prefers the server-VERIFIED
      // shopperId (`verifiedShopperId`, derived above from the x-shopper-token — never client-claimed)
      // and falls back to the (hashed) sessionId, mirroring canary's own trust boundary. `holdoutPeriod()`
      // is computed once and reused at the exposure-tally call below so one turn can never straddle two
      // periods.
      const holdoutConfig = await readHoldoutConfig(store, tenantId);
      const holdoutPeriodValue = holdoutPeriod();
      // F1 (W2-B security review): the arm-assignment WRITE (a `store.tx`) sits on the turn's critical
      // path, so — exactly like the exposure tally further down — it is fail-OPEN. A store/tx write fails
      // more readily than the canary/champion READs beside it, so if it throws we leave `holdoutArm`
      // undefined: the turn serves the normal canary/champion policy and is simply left UNMEASURED for
      // BOTH arms this period. That is the unbiased degradation — never break the shopper's reply, and
      // never silently fall back to `treated` (which would undercount control and bias the comparison).
      let holdoutArm: Arm | undefined;
      if (holdoutConfig.enabled) {
        try {
          holdoutArm = await assignHoldoutArm(
            store,
            tenantId,
            holdoutConfig,
            holdoutIdentity({ verifiedShopperId, sessionId }),
            holdoutPeriodValue,
          );
        } catch (e) {
          console.error(`[/chat] holdout arm_assign error tenant=${tenantId} error=${e instanceof Error ? e.constructor.name : typeof e}`);
          holdoutArm = undefined;
        }
      }

      // Canary split: a sticky fraction of THIS tenant's sessions is served by that tenant's canary
      // policy; the rest by champion. Keyed by the server-derived tenantId, so one merchant's canary can
      // never bucket another merchant's shoppers (ADR-0014 blast-radius fix).
      const canary = await assignCanary(store, tenantId, sessionId);
      // Champion is the store-backed active champion the control plane persisted on a human-approved
      // promotion (champion.ts / control-plane champion-promoter.ts), falling back to DEFAULT_POLICY when
      // nothing has been promoted yet — this is what makes engine.promote actually reach shoppers
      // (ADR-0003 promote→serving). Canary still overrides for its sticky traffic slice.
      const champion = (await readActiveChampion(store, tenantId)) ?? DEFAULT_POLICY;
      // A holdout CONTROL arm overrides canary/champion entirely — it is the un-treated baseline the
      // flywheel measures against, never a canary/champion variant (step 3 of the design: "control ⇒
      // serve a designated CONTROL policy"; "treated ⇒ serve champion/canary exactly as today"). The
      // control arm still goes through every guardrail (kill switch, cost cap, safety) exactly like any
      // other policy — `resolveControlPolicy` only changes styleDirective/proactivityDefault, the same
      // narrow surface a promoted champion is limited to (see champion.test.ts's CONTAINMENT case), so
      // this is a policy choice, never a bypass.
      const policy = holdoutArm === "control" ? resolveControlPolicy(holdoutConfig) : canary ? canary.policy : champion;
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
      // to call it and WITH WHAT turn. Awaited synchronously (see the write-timing note below) but never
      // BREAKS the response — a memory-service failure is caught and logged, fail-open exactly like every
      // other side effect on this path (telemetry/traffic), it just no longer runs off the critical path.
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
        // semantic-memory-v1 T6 REVERTED (live-staging finding, 2026-08-18) — the write is SYNCHRONOUS
        // (`await`ed inside this try/catch), not fire-and-forget. T6 made this `void ...catch()` on the
        // theory that the write is off the shopper's critical path; live diagnosis on staging proved the
        // opposite: Cloud Run throttles a container's CPU to ~0 once the HTTP response has been sent, so a
        // write kicked off AFTER the reply (the distiller's `model.complete` + embed + upsert) is starved
        // and never runs at all — confirmed by 0 facts ever landing in `vp_ann` and by metering showing
        // exactly one `shopper`-tagged model call per turn (the reply) instead of two (reply + distiller).
        // Awaiting the write here keeps it inside the request, where Cloud Run guarantees CPU. Fail-open is
        // unchanged: a `remember()` failure is caught and logged, never surfaced to the shopper or allowed
        // to break the reply — only WHEN the write runs moved (during vs. after the response), not whether
        // a failure can affect it. This trades back some of T6's tail-latency win; the latency-preserving
        // follow-up is a proper async write queue (Cloud Tasks/Pub/Sub, mirroring the catalog-webhook
        // path) so the write is durably handed off instead of raced against a frozen container.
        try {
          // #126 W1.5 — enqueue-or-inline. `memoryWriteQueue` undefined (the dark default, always true in
          // real production until the MEMORY_PUBSUB_* env is set) ⇒ this calls `remember()` INLINE, byte-
          // identical to before this change; a configured queue hands the write off async instead, falling
          // back to the SAME inline call on any publish failure (memory-write-dispatch.ts). Either way the
          // fail-open try/catch below is unchanged — a throw from either path is caught and logged, never
          // surfaced to the shopper.
          await dispatchMemoryWrite({
            queue: memoryWriteQueue,
            remember: (ctx, turn) => memoryService.remember(ctx, turn),
            // `memoryConsentInputs` — the same object the client-facing `memoryActive` is derived from,
            // so what the shopper is TOLD and what is actually gated here are one decision, not two.
            ctx: { tenantId, anonId: memorySubject, ...memoryConsentInputs },
            turn: { message, reply: d.reply },
            nowMs: Date.now(),
            log: (m) => console.error(m),
          });
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
      // NOT closed by this sweep (security review, Finding 4 — corrected from an earlier overclaim, and
      // now UPDATED again — see below): (a) the sweep's ONLY predicate is EXPIRY (retention.ts) — a fact
      // whose consent has not been explicitly withdrawn but has not yet expired either is not touched
      // here; it merely stops being renewed (service.ts recall) and survives up to its remaining TTL (up
      // to 30 more days). CORRECTED: this comment previously said symmetric erasure-first withdrawal
      // (ADR-0015 Inv 9) was "NOT enforced by POST /consent today" because `withdrawConsent1`/
      // `withdrawConsent2` (widget-memory/src/erasure.ts) had no production caller. That residual is now
      // CLOSED for the /consent path: POST /consent calls `withdrawConsent1`/`withdrawConsent2` per tier
      // the instant a shopper toggles that tier to `"out"` (see the route above), so an Art-9/ordinary
      // fact is erased + tombstoned at withdrawal time, not left to age out via this sweep. What remains
      // true is narrower: a fact that is merely EXPIRED (never explicitly withdrawn) still relies on this
      // TTL sweep, and a consent record set by any path OTHER than POST /consent (there is none today)
      // would not go through the withdrawal call. (b) the sweep is itself capped at retention.ts's
      // SWEEP_QUERY_LIMIT (500) per call, so it cannot GUARANTEE bringing a namespace back under
      // erasure.ts's own enumeration cap — it only deletes what expiry finds among the first 500 records
      // it queries.
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
      // W2-B — tally this turn's EXPOSURE onto the holdout arm's `ArmTally` row, only while the holdout
      // is enabled (`holdoutArm` is undefined otherwise, and this whole block is skipped — no ledger
      // write at all when off, per the design's step 6). AWAITED (not fire-and-forget): the semantic-
      // memory-v1 T6 revert above already proved that work kicked off after a response starts being
      // returned can be starved by Cloud Run's post-response CPU throttling, and this feeds a
      // measurement the flywheel's incrementality metric depends on, so it gets the same treatment as
      // that memory write — inside the request, fail-open (a tally failure never breaks the reply).
      // `orders`/`revenue` stay 0 here by design: W2-C's order webhook is what populates those later.
      // DELIBERATELY unconditional on `kill`/`no_autonomous_action`: an exposure records that this
      // shopper reached the surface under this arm this period, not that the model took an action — and
      // the kill switch is tenant/agent-wide, so it depresses BOTH arms' exposure counts equally and
      // cannot bias the treated-vs-control comparison the way an arm-specific effect would.
      if (holdoutArm) {
        try {
          await accumulateArmTally(store, {
            tenantId,
            play: HOLDOUT_PLAY,
            period: holdoutPeriodValue,
            arm: holdoutArm,
            exposures: 1,
          });
        } catch (e) {
          console.error(`[/chat] holdout arm_tally error tenant=${tenantId} error=${e instanceof Error ? e.constructor.name : typeof e}`);
        }
      }
      // M3 — per-turn telemetry enrichment: the business dimensions (mode/pitch/servedBy/escalate) and
      // end-to-end turn latency the model-port decorator can't see. PII-free (no message/reply). Under
      // the server-derived tenant; fail-open like logTraffic. `arm` (W2-B) is undefined — hence
      // structurally absent, not present-and-null — whenever the holdout is off, so this row is
      // unchanged from before this feature existed for every tenant that never enables it.
      void telemetry
        .record(serving, { kind: "turn", agentType: RUNTIME_AGENT_TYPE, servedBy: policy.id, mode: d.mode, pitch: d.pitch, escalate: d.escalateToHuman, arm: holdoutArm, latencyMs: Date.now() - turnStart, ...recommendationTelemetryFields(d) })
        .catch(() => {});
      // T9 — logTraffic is the choke point that redacts message/reply and hashes sessionId at the
      // write boundary (see canary.ts), so no raw shopper PII lands in the shadow-grading log at rest.
      // `arm` (W2-B) is joinable-but-optional here too, same absence-when-off rule as telemetry above.
      await logTraffic(store, tenantId, { servedBy: policy.id, sessionId, message, reply: d.reply, mode: d.mode, escalate: d.escalateToHuman, killScope: kill?.scope, arm: holdoutArm });
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
        // §3.5 — the proactive OPENER is agent-initiated and shopper-reaching, so it is logged even though it
        // is a benign smalltalk turn (buildAuditInput above returns null for it). PII-safe (hashed sessionRef +
        // code-owned chip actions), reversal n/a. Committed in the SAME tx so state never advances unaudited.
        if (Array.isArray(d.flags) && d.flags.includes("opener")) {
          await t.audit(buildOpenerAuditInput({ sessionId, decision: d }));
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
        // Pillar 3 (opener) — the tappable quick-reply chips the opener may surface. Spread-conditional (no
        // key unless the decision carried chips), so every turn today — PROACTIVE_OPENER off, no opener rung
        // yet mints any — serializes byte-identically to before this seam existed (chat-wire-flag-off golden).
        ...suggestedChipsWireField(d),
        // Pillar 2a — tells the widget it may call POST /cart/checkout-url. Spread-conditional on the
        // FLAG (not on the decision), so the key is absent — not present-and-false — for every turn
        // while IN_CHAT_CHECKOUT is off, keeping the response byte-identical (chat-wire-flag-off golden).
        ...(IN_CHAT_CHECKOUT ? { checkoutEnabled: true } : {}),
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

  // Task 7 (credential-enrollment-unification, CARRY T5) — the catalog-sync scheduler's deps
  // (catalog-sync-scheduler.ts), wired with the REAL `listActive`-backed merchant registry (Task 5) so
  // tenant discovery for the fleet backfill/embed-poll job goes through the governed registry enumeration
  // rather than `SHOPIFY_STORES`/`parseStoreDomains`. Built whenever a durable `merchantRegistry` exists
  // (unified-cutover-cleanup, 2026-08-24 — the CATALOG_UNIFIED flag that used to ALSO gate this is gone;
  // the scheduler's own dependency on a real registry is the only remaining precondition) — no registry
  // (e.g. no DATABASE_URL) ⇒ `catalogSyncSchedulerDeps` stays `undefined`.
  //
  // NOT INVOKED FROM ANYWHERE IN THIS FILE: `runCatalogSyncScheduler` has no live cron/HTTP trigger
  // anywhere in this codebase today (see that file's own "NOT WIRED INTO ANY LIVE CRON/SERVER HERE"
  // banner, and `retention-sweep.ts`'s identical situation) — standing one up, plus the real
  // Admin-token-refresh-backed `backfill` composition production needs (Task 6's `getFreshAdminToken`
  // lifecycle is not wired into this composition root either), is Task 9's "remaining composition wiring"
  // per the plan. `index` below is the one REAL piece available today: it reuses the SAME `reconcileDeps`
  // webhook reconcile already uses, so a scheduler run's embed-poll step is genuinely live, not a stub.
  // `backfill` defaults to a clearly-named "not yet composed" refusal unless a caller (a test, or Task 9's
  // eventual cron entry point) supplies `opts.catalogSyncBackfill`.
  //
  // EXPOSED ON THE RETURNED `app` (a plain property, not a Fastify decorator — this codebase has no
  // existing decoration pattern to reuse) purely as a composition-root test/ops seam: `buildServer`
  // otherwise returns only the bare Fastify instance, and there is today no HTTP route or cron caller that
  // would otherwise observe this wiring. This is a judgment call, flagged for review.
  //
  // TASK 9 DECISION (deliverable 3 of the plan's Task 9, evaluated 2026-08-24) — `backfill` STAYS the
  // throw-default above; deliberately NOT composing a real `getFreshAdminToken` + `runCatalogBackfill` +
  // Admin-client wiring here, for two independent verify-or-don't-write reasons, either of which alone
  // would be disqualifying:
  //   1. `admin-token-refresh.ts`'s `exchange` (the refresh_token-grant HTTP call) has NO live
  //      implementation anywhere in this codebase — ADR-0023 open item 1: "Live dev-store confirmation of
  //      the refresh_token grant (deferred to staging-enable; docs verified 2026-08-24)". Composing a real
  //      caller here would force inventing that wire shape from memory, which CLAUDE.md's honesty rules
  //      (verify-or-don't-write) forbid.
  //   2. Independently, `catalog-backfill.ts`'s OWN file banner says its Bulk Operations query/JSONL shape
  //      is "NOT LIVE-VERIFIED... against a live bulk export from this repo" — so even with a
  //      hypothetically-injected `exchange` supplying a fresh Admin token, actually RUNNING this backfill
  //      against live Shopify would exercise an separately-unverified wire surface. Injecting `exchange`
  //      with no default live implementation (the plan's option (b)) would still leave this second
  //      unverified surface live-reachable the moment any caller supplied a real Admin client — so option
  //      (b) does not clear the plan's own bar ("ONLY if it introduces NO unverified-live-HTTP surface").
  // Given both, the plan's option (a) is the one that actually holds: the throw-default fails LOUD (never
  // a silent no-op) and — since nothing in this codebase invokes `runCatalogSyncScheduler` at all yet (see
  // above) — costs nothing today. Standing up the real backfill composition is carried to staging-enable
  // time, alongside the live refresh-grant confirmation and a live cron/HTTP trigger for the scheduler
  // itself (both explicitly operator/deploy steps, never a build agent's).
  const catalogSyncSchedulerDeps: CatalogSyncSchedulerDeps | undefined =
    merchantRegistry
      ? {
          store,
          registry: merchantRegistry,
          backfill:
            opts?.catalogSyncBackfill ??
            (async () => {
              throw new Error(
                "catalog-sync-scheduler: no backfill composition wired (the real Admin-token-refresh-backed " +
                  "backfill client is Task 9's remaining composition wiring) — supply opts.catalogSyncBackfill " +
                  "for a test/ops caller in the meantime",
              );
            }),
          // F-G (ADR-0023) — wrapped so an Admin-token reauth-required halt is a distinguishable, audited
          // SIGNAL rather than silently folding into the scheduler's generic per-tenant "failed" outcome.
          // This is a log+audit hook only, NOT a monitored/paged destination — that is explicitly carried
          // to Task 9 (its own "monitored destination" wiring), not built here.
          index: async (tenantId) => {
            try {
              return await (opts?.catalogSyncIndex ?? ((t: string) => runCatalogIndex(reconcileDeps, [t]).then((rs) => rs[0]!)))(tenantId);
            } catch (e) {
              if (e instanceof AdminTokenReauthRequiredError) {
                console.error(
                  `[catalog-sync] REAUTH REQUIRED tenant=${tenantId} — Admin token custody has lapsed; halting ` +
                    `rather than serving stale (F-G). A merchant must reinstall/reauthorize.`,
                );
                try {
                  await store.audit(
                    { tenantId },
                    {
                      actor: "system:catalog-sync-scheduler",
                      action: "catalog_sync.reauth_required",
                      decision: { halted: true, reason: e.message },
                      reversalPath: "merchant must reinstall/reauthorize the Admin API connection to resume catalog sync",
                    },
                  );
                } catch {
                  // Best-effort audit, mirrors shopify-install.ts's own admin_token.custody_failed pattern —
                  // a secondary audit-write failure must not mask the original reauth signal.
                }
              }
              throw e; // preserve the scheduler's own per-tenant "failed"/errorClass recording
            }
          },
        }
      : undefined;
  // Only assign the property when it is actually defined (a real `merchantRegistry` exists) — an
  // unconditional assignment here would give the returned `app` a new own-property (value `undefined`)
  // even with no registry, breaking the "genuinely absent, not present-but-undefined" contract this seam's
  // own tests pin.
  if (catalogSyncSchedulerDeps) {
    (app as unknown as { catalogSyncSchedulerDeps?: CatalogSyncSchedulerDeps }).catalogSyncSchedulerDeps = catalogSyncSchedulerDeps;
  }

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
