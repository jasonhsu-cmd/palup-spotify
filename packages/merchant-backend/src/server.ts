import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply } from "fastify";
import fastifyStatic from "@fastify/static";
import { pathToFileURL, fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type RuntimeStatePort,
  type MerchantIdentityPort,
  type MerchantRegistryPort,
  type CampaignCommsPort,
  type CustomerListingCommerce,
  type MerchantRulesStore,
  type PrimaryGoalStore,
  type ProposalStore,
  type LearnedStore,
  createEnvSecrets,
  createInMemoryMerchantRegistry,
  InMemoryMerchantRulesStore,
  InMemoryPrimaryGoalStore,
  InMemoryProposalStore,
  InMemoryLearnedStore,
  SandboxCommsAdapter,
  SandboxCustomerDirectory,
} from "@palup/platform-ports";
import { createRuntimeStore, PostgresMerchantRegistry, PostgresMerchantRulesStore, PostgresPrimaryGoalStore, PostgresLearnedStore } from "@palup/state-postgres";
import { requireMerchant, shopifyEmbedFrameAncestors, createShopifyAppBridgeIdentity, createInMemoryJtiGuard } from "@palup/identity-shopify";
import { registerMeRoutes } from "./routes/me.js";
import { registerInternalWinBackRoutes } from "./routes/internal-winback.js";
import { registerInternalInsightsRoutes } from "./routes/internal-insights.js";
import { registerApprovalsRoutes } from "./routes/approvals.js";
import { registerKillRoutes } from "./routes/kill.js";
import { registerAuditRoutes } from "./routes/audit.js";
import { registerActivityRoutes } from "./routes/activity.js";
import { registerEventsRoutes } from "./routes/events.js";
import { registerRulesRoutes } from "./routes/rules.js";
import { registerHomeRoutes } from "./routes/home.js";
import { registerLearnedRoutes } from "./routes/learned.js";
import { InMemoryEventBus, type EventBus } from "./events.js";
import "./types.js";

// Task 4 composition root: `store`/`identity` stay injectable (every existing test suite injects fakes
// — InMemoryRuntimeStore + a deterministic MerchantIdentityPort double — so no unit test needs a real
// Postgres connection or a real Shopify secret). Omitting them wires the REAL deps, mirroring
// control-plane's `opts?.store ?? (await createRuntimeStore()).store` pattern (control-plane/src/server.ts):
//   • store    -> `createRuntimeStore()` (@palup/state-postgres): real Cloud SQL Postgres when
//                 DATABASE_URL is set, else the same in-memory fallback every other service uses locally.
//   • identity -> `createShopifyAppBridgeIdentity` (@palup/identity-shopify): the real Shopify App
//                 Bridge session-token/exchange adapter. Its app client secret and PalUp session-signing
//                 secret are read via the SECRETS PORT (`createEnvSecrets()`, the same adapter and the
//                 same secret names widget-backend already reads — server.ts:416) — never env-inline.
//                 The registry it resolves a shop domain against is `PostgresMerchantRegistry` when a
//                 durable store is available (sharing the SAME pool `createRuntimeStore()` opened, per
//                 the "one pg.Pool per process" rule state-postgres documents), else the in-memory
//                 registry — this deployment has no merchants registered until F5+ writes to it, so a
//                 real shop can't resolve until then; that is fail-closed by construction, not a bypass.
//   • SHOPIFY_APP_CLIENT_ID is the OAuth client id (NOT a secret — it ships in the URL, same convention
//     widget-backend uses at server.ts:1196) so it is read directly from the environment.
export async function buildServer(opts?: {
  store?: RuntimeStatePort;
  identity?: MerchantIdentityPort;
  // Task 5 (WB win-back staging trigger route) — every one of these stays injectable so its tests
  // (and every other suite in this package) never need a real DB/comms provider. Absent opts default
  // to sandbox/in-memory adapters wrapping `store` — the exact same "inject for tests, sandbox/mock
  // for real deploys until a governed live adapter is wired" convention `identity`/`registry` above
  // already follow.
  commerce?: CustomerListingCommerce;
  comms?: CampaignCommsPort;
  proposalStore?: ProposalStore;
  rulesStore?: MerchantRulesStore;
  // W2 (Revenue Home): injectable for tests, same convention as rulesStore. Absent → the durable
  // Postgres adapter when DATABASE_URL gave us a pool, else in-memory.
  goalStore?: PrimaryGoalStore;
  // W3 Task 4 (Learned/Memory & Voice — merchant-facing `/learned` surface): injectable for tests,
  // same durable-vs-in-memory convention as rulesStore/goalStore above. Absent → the durable Postgres
  // adapter when DATABASE_URL gave us a pool, else in-memory. Build DARK: this store is only reachable
  // through the private, per-tenant `/learned` routes below — no aggregate-tier caller wired here.
  learnedStore?: LearnedStore;
  // Task 7 (SSE live-update channel): injectable for tests (each test that shares a bus across two
  // `buildServer()` calls, e.g. one connecting to `/events` and one driving an approve, needs the
  // SAME bus instance). Absent -> a fresh `InMemoryEventBus` per server — single-instance only; see
  // events.ts's TODO for the multi-instance Cloud Run follow-up.
  bus?: EventBus;
}): Promise<FastifyInstance> {
  const runtimeResult = opts?.store ? undefined : await createRuntimeStore();
  const store: RuntimeStatePort = opts?.store ?? runtimeResult!.store;
  const commerce: CustomerListingCommerce = opts?.commerce ?? new SandboxCustomerDirectory({});
  // SandboxCommsAdapter records every send and NEVER delivers — the only comms adapter this service
  // may default to until a real (still consent/DLP-gated) provider adapter is wired + prod-enabled.
  const comms: CampaignCommsPort = opts?.comms ?? new SandboxCommsAdapter();
  const proposalStore: ProposalStore = opts?.proposalStore ?? new InMemoryProposalStore(store);
  // Task 4 composition default: mirrors the `identity`/registry pattern just below — a real
  // `PostgresMerchantRulesStore` sharing the SAME pool `createRuntimeStore()` opened when a durable
  // store is available (DATABASE_URL set), else the in-memory adapter every other service falls back
  // to locally/in tests. `state` is `store` itself, so the `"rules.changed"` audit record `set()`
  // writes lands in the SAME `rs_audit` table every other governed mutation in this deployment uses.
  //
  // DEPLOY-BLOCKING GAP FIX: `createRuntimeStore()` only migrates its OWN `RuntimeStatePort` KV tables
  // (`rs_kv`/`rs_audit`, inside `state-postgres/src/factory.ts`) — it has no idea `pl_merchant_rules`
  // (this store) or `pl_merchant` (the registry, just below) exist. Each has its OWN `migrate()`
  // (idempotent `CREATE TABLE IF NOT EXISTS`, mirroring `PostgresRuntimeStore.migrate()`), so on the
  // durable path both concrete Postgres adapters are constructed here, `await`ed through `migrate()`,
  // and ONLY THEN handed off as their port-typed const — a fresh `DATABASE_URL` boots with every table
  // it needs instead of 500ing on first use. The in-memory path (no `DATABASE_URL`, every other test in
  // this package) is untouched: no Postgres class is constructed and no `migrate()` call happens.
  let rulesStore: MerchantRulesStore;
  if (opts?.rulesStore) {
    rulesStore = opts.rulesStore;
  } else if (runtimeResult?.sql) {
    const postgresRulesStore = new PostgresMerchantRulesStore(runtimeResult.sql, store);
    await postgresRulesStore.migrate();
    rulesStore = postgresRulesStore;
  } else {
    rulesStore = new InMemoryMerchantRulesStore(store);
  }
  // W2: same durable-vs-inmemory split + migrate-before-serve rule as `rulesStore` above —
  // `createRuntimeStore()` migrates only its OWN tables, so the concrete Postgres adapter is
  // constructed here, `await`ed through `migrate()`, and only then handed off port-typed.
  let goalStore: PrimaryGoalStore;
  if (opts?.goalStore) {
    goalStore = opts.goalStore;
  } else if (runtimeResult?.sql) {
    const postgresGoalStore = new PostgresPrimaryGoalStore(runtimeResult.sql, store);
    await postgresGoalStore.migrate();
    goalStore = postgresGoalStore;
  } else {
    goalStore = new InMemoryPrimaryGoalStore(store);
  }
  // W3 Task 4: same durable-vs-inmemory split + migrate-before-serve rule as `rulesStore`/`goalStore`
  // above — `createRuntimeStore()` migrates only its OWN tables, so the concrete Postgres adapter is
  // constructed here, `await`ed through `migrate()`, and only then handed off port-typed.
  let learnedStore: LearnedStore;
  if (opts?.learnedStore) {
    learnedStore = opts.learnedStore;
  } else if (runtimeResult?.sql) {
    const postgresLearnedStore = new PostgresLearnedStore(runtimeResult.sql, store);
    await postgresLearnedStore.migrate();
    learnedStore = postgresLearnedStore;
  } else {
    learnedStore = new InMemoryLearnedStore(store);
  }
  const bus: EventBus = opts?.bus ?? new InMemoryEventBus();
  // Hoisted to a named const (rather than constructed inline inside `createShopifyAppBridgeIdentity`)
  // so the concrete Postgres instance can be `migrate()`d on the durable path — the same reasoning as
  // `rulesStore` above. `MerchantRegistryPort` (the interface `createShopifyAppBridgeIdentity` takes)
  // does not declare `migrate()`; only the concrete `PostgresMerchantRegistry` does.
  let registry: MerchantRegistryPort;
  if (runtimeResult?.sql) {
    const postgresRegistry = new PostgresMerchantRegistry(runtimeResult.sql);
    await postgresRegistry.migrate();
    registry = postgresRegistry;
  } else {
    registry = createInMemoryMerchantRegistry();
  }
  const identity: MerchantIdentityPort =
    opts?.identity ??
    createShopifyAppBridgeIdentity({
      clientId: process.env.SHOPIFY_APP_CLIENT_ID ?? "",
      secrets: createEnvSecrets(),
      registry,
      // PER-INSTANCE, not shared — see DEPLOY.md "Shared state" ⚠️ for the multi-instance replay-window
      // caveat and the --max-instances 1 mitigation until a durable JtiReplayGuard adapter exists.
      jtiGuard: createInMemoryJtiGuard(),
    });

  const app = Fastify({ logger: false });

  // C1 hardening (found while fixing the approve/reject routes' error mapping — coordinator review):
  // Fastify's OWN default error handler echoes the raw `err.message` of any uncaught error in the
  // JSON response body (verified empirically: `throw new Error("x")` from a route -> HTTP 500 body
  // `{..., message: "x"}`) — a real info leak for a genuine bug or infra failure (e.g.
  // `deps.state.audit()` throwing after a transition already committed) once approve/reject stop
  // catching every `Error` into a 409. Every typed §3 error (`VersionConflictError`/`KillSwitchError`/
  // `ProposalNotFoundError`/`TerminalStateError`) is already mapped to a specific status code INSIDE
  // the route via an explicit `reply.code(...).send(...)` before it would ever reach here — this
  // handler is the redacted fallback for everything else.
  //
  // FIX (coordinator re-review, 2nd pass): an EARLIER version of this handler redacted
  // UNCONDITIONALLY to 500, which also clobbered legitimate Fastify-NATIVE 4xx errors (e.g. a
  // malformed/empty JSON body -> `FST_ERR_CTP_INVALID_JSON_BODY`, a real 400) into a misleading 500 —
  // breaking client retry logic (5xx retryable, 4xx not) and misdirecting on-call triage on every POST
  // route. Pass through a well-formed 4xx `statusCode` (still WITHOUT ever echoing `err.message` —
  // `err.name`/a fixed code is the most detail sent), and redact to a generic message-free 500 ONLY
  // when the status is absent or >= 500 (a genuine bug/infra failure).
  app.setErrorHandler((err: FastifyError, req, reply) => {
    req.log.error({ err }, "unhandled error");
    const sc = err.statusCode;
    if (typeof sc === "number" && sc >= 400 && sc < 500) {
      return reply.code(sc).send({ statusCode: sc, error: err.name ?? "Bad Request" }); // never err.message
    }
    reply.code(500).send({ statusCode: 500, error: "Internal Server Error" });
  });

  // Structural-safety backstop (coordinator review, W1-API is about to add many routes): collect
  // EVERY route Fastify actually registers, regardless of which context (root `app` vs the
  // encapsulated `merchantPlane` below) it's registered in — `onRoute` fires for child-context routes
  // too. `route-protection.test.ts` walks this list and asserts every non-/health route 401s with no
  // token, so a future route registered outside `merchantPlane` fails that test instead of shipping
  // unprotected with green tests and no signal.
  const registeredRoutes: { method: string; url: string }[] = [];
  app.addHook("onRoute", (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) registeredRoutes.push({ method, url: route.url });
  });
  app.decorate("registeredRoutes", registeredRoutes);

  // /health is the ONLY unauthenticated DATA route — registered directly on `app`, outside the
  // encapsulated merchant-plane context below, so it can never accidentally pick up the auth
  // preHandler that context scopes to everything registered inside it.
  app.get("/health", async () => ({ ok: true }));

  // ---------------------------------------------------------------------------------------------
  // Merchant-console SPA (Vite build of `@palup/merchant-console`) — served PUBLICLY from this same
  // Cloud Run service so one origin serves both the API and the embedded UI. This is safe to leave
  // unauthenticated because it is pure app-shell code (no merchant/customer data): the browser has no
  // session token yet when it first loads the iframe, and Shopify App Bridge only mints one AFTER the
  // shell has booted. Every DATA route stays behind `requireMerchant` inside `merchantPlane` below —
  // this block registers ONLY static/asset routes and an index.html fallback, never anything that
  // reads `req.principal` or touches `store`/`commerce`/`comms`/etc.
  //
  // `vite.config.ts` sets `build.outDir` to `dist-web` (NOT `dist`, which is `tsc -b`'s plain-JS output
  // dir for this same package — the two build steps would otherwise collide). Resolved relative to
  // THIS file's own URL (not `process.cwd()`) so it's correct both in local dev (`tsx` from the repo
  // root) and in the Cloud Run image (`Dockerfile.merchant-backend` runs `pnpm --filter
  // @palup/merchant-console build` before this service starts, baking `dist-web` into the image at the
  // same relative path).
  const consoleDistDir = fileURLToPath(new URL("../../merchant-console/dist-web", import.meta.url));
  const consoleAssetsDir = join(consoleDistDir, "assets");
  const consoleIndexPath = join(consoleDistDir, "index.html");
  // Read once at boot, not per-request — the SPA bundle doesn't change without a redeploy/restart.
  // `null` (bundle not built — e.g. a unit test run that never invoked `vite build`) fails closed to a
  // 503 rather than crashing the whole server at import time.
  const consoleIndexHtml = existsSync(consoleIndexPath) ? readFileSync(consoleIndexPath, "utf-8") : null;

  function sendConsoleIndex(reply: FastifyReply): void {
    if (consoleIndexHtml === null) {
      reply.code(503).send({
        error: "console_not_built",
        message: "merchant-console SPA bundle is missing — run `pnpm --filter @palup/merchant-console build`.",
      });
      return;
    }
    reply.type("text/html").send(consoleIndexHtml);
  }

  // Hashed asset chunks (`/assets/*.js`, `/assets/*.css`, etc) — a discrete, enumerable route
  // (`GET`/`HEAD /assets/*`) so `route-protection.test.ts`'s structural guard can assert it by name,
  // same as any other route. Registered only when the bundle exists so a test run that never built the
  // console doesn't 500 at startup on a missing directory.
  if (existsSync(consoleAssetsDir)) {
    await app.register(fastifyStatic, { root: consoleAssetsDir, prefix: "/assets/" });
  }

  // `index.html` at both `/` (the embed's default entry) and `/index.html` (an explicit request for
  // it) — plain routes, not `@fastify/static`, since there's exactly one file and no directory listing
  // concerns.
  app.get("/", async (_req, reply) => sendConsoleIndex(reply));
  app.get("/index.html", async (_req, reply) => sendConsoleIndex(reply));

  // SPA client-side routing fallback: any GET that doesn't match a registered route (API or static)
  // gets the same `index.html` so the SPA's own router (react-router) can resolve it client-side.
  // `setNotFoundHandler` registers on Fastify's INTERNAL 404 router, not via `.route()` — it never
  // fires `onRoute` and so never shows up in `registeredRoutes`/the structural guard, and — more
  // importantly — it only runs for requests that matched NO route anywhere, so it can never shadow or
  // intercept an actual API route registered inside `merchantPlane` below (those already matched and
  // already ran `requireMerchant` by the time routing would ever reach this fallback). Non-GET
  // requests to an unmatched path still get a normal JSON 404, not the SPA HTML.
  app.setNotFoundHandler((req, reply) => {
    if (req.method === "GET" && consoleIndexHtml !== null) {
      reply.type("text/html").send(consoleIndexHtml);
      return;
    }
    reply.code(404).send({ statusCode: 404, error: "Not Found", message: `Route ${req.method}:${req.url} not found` });
  });

  // CSP `frame-ancestors` pin (F2, anti-clickjacking): the embedded merchant console may only be framed
  // by Shopify admin. Per-shop widening needs the authenticated merchant's shop domain, which the
  // identity port doesn't surface yet (Task 4 composition) — until then every response gets the safe
  // admin-only default rather than staying unset.
  app.addHook("onSend", async (_req, reply, payload) => {
    reply.header("content-security-policy", shopifyEmbedFrameAncestors(""));
    return payload;
  });

  // Every merchant-plane route (everything except /health) lives inside this encapsulated context so
  // Fastify's own scoping — not string-matching request URLs — is what keeps /health open: the
  // fail-closed session-token preHandler (F2's `requireMerchant`) applies to every route registered
  // inside here and nowhere else. An absent/invalid bearer -> 401 from the preHandler itself; a valid
  // one attaches `req.principal` for the handler + any `requirePermission` preHandler mounted per-route.
  await app.register(async (merchantPlane) => {
    merchantPlane.addHook("preHandler", requireMerchant(identity));
    registerMeRoutes(merchantPlane);
    registerInternalWinBackRoutes(merchantPlane, { state: store, commerce, comms, proposalStore, rulesStore });
    registerInternalInsightsRoutes(merchantPlane, { learnedStore });
    registerApprovalsRoutes(merchantPlane, { proposalStore, state: store, rulesStore, comms, bus });
    registerKillRoutes(merchantPlane, { state: store, bus });
    registerAuditRoutes(merchantPlane, { state: store });
    registerEventsRoutes(merchantPlane, { bus });
    registerRulesRoutes(merchantPlane, { rulesStore });
    registerLearnedRoutes(merchantPlane, { learnedStore });
    registerHomeRoutes(merchantPlane, { state: store, goalStore });
    registerActivityRoutes(merchantPlane, { state: store });
  });

  return app;
}

const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (invoked === import.meta.url) {
  const port = Number(process.env.PORT ?? 8991);
  // Cloud Run needs 0.0.0.0 to accept traffic (control-plane's HOST default is loopback-only, which is
  // the deploy gotcha that broke its first Cloud Run rollout — see project memory). Default open here so
  // an ops env doesn't have to remember to set HOST for merchant-backend's health check to pass.
  const host = process.env.HOST ?? "0.0.0.0";
  buildServer()
    .then((app) => app.listen({ port, host }))
    .then(() => console.log(`merchant-backend on http://${host}:${port}`))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
